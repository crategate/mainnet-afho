import "dotenv/config";
import * as fs from "fs";
import * as path from "path";
import { spawnSync, spawn } from "child_process";
import readline from "readline/promises";
import {
    Connection,
    Keypair,
    LAMPORTS_PER_SOL,
    PublicKey,
    SystemProgram,
    Transaction,
    sendAndConfirmTransaction,
} from "@solana/web3.js";
import { resolveSolanaConfig, Cluster } from "../lib/cluster";
import { usdcMintFor } from "../lib/cpmm";
import { derivePoolId } from "../lib/cpmm";
import { STEPS } from "../lib/launch-steps";

// deploy-wizard.ts — the ONE-COMMAND, hand-holding deploy. Wraps the
// rehearsed launch chain (launch.ts steps, unchanged) with fresh-wallet
// generation, funding verification with live balance bars, per-step
// confirmation gates, and the post-launch keeper/manifest handoff.
//
//   anchor run deploy                          # mainnet (this repo's default)
//   DEPLOY_CLUSTER=devnet anchor run deploy    # full-flow devnet rehearsal
//   anchor run deploy -- --dry                 # gates + preflights + plan, sends nothing
//   anchor run deploy -- --new-wallets         # force fresh role wallets
//   anchor run deploy -- --from launch-bundle  # resume the chain mid-way (see also launch.ts)
//
// Phases (resumable via .wizard-state.json, gitignored):
//   gate → preflight → wallets → funding → rotate+deploy → prep → chain → post
//
// Safety shape:
//   - The dev repo (no .deploy-repo marker) REFUSES mainnet here.
//   - Mainnet requires typing MAINNET, with the money-at-stake printed first.
//   - Nothing irreversible runs until every wallet shows funded (live bars).
//   - fund-launch / burn-lp ask for a typed confirmation on mainnet.
//   - Wallet phrases are shown ONCE by solana-keygen's own flow (cleared
//     screen + confirm-a-word); this script never logs or stores them.

const ROOT = path.resolve(__dirname, "../..");
const KEYS_DIR = path.join(ROOT, "keys");
const STATE_PATH = path.join(ROOT, ".wizard-state.json");
const ANCHOR_TOML = path.join(ROOT, "Anchor.toml");
const ENV_PATH = path.join(ROOT, ".env");
const MINT_KEYPAIR = path.join(ROOT, "target/deploy/afho_token-keypair.json");

const ROLE_WALLETS = ["launch", "buyer", "keeper"] as const;
type Role = (typeof ROLE_WALLETS)[number];

interface WizardState {
    cluster: Cluster;
    phase: string;
    rotated: boolean;
    deployed: boolean;
    mint?: string;
    wallets?: Record<Role, string>; // pubkeys only — never secrets
}

// ── tiny terminal toolkit ────────────────────────────────────────────────

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

function hr(title: string) {
    console.log(`\n━━━ ${title} ${"─".repeat(Math.max(4, 66 - title.length))}`);
}

async function pause(msg = "Press ENTER to continue…") {
    await rl.question(`\n${msg}`);
}

async function confirm(msg: string, def = true): Promise<boolean> {
    const hint = def ? "[Y/n]" : "[y/N]";
    const a = (await rl.question(`${msg} ${hint} `)).trim().toLowerCase();
    if (!a) return def;
    return a === "y" || a === "yes";
}

async function typedConfirm(challenge: string) {
    const a = (await rl.question(`Type ${challenge} to continue: `)).trim();
    if (a !== challenge) {
        console.error(`✗ expected exactly "${challenge}".`);
        process.exit(1);
    }
}

function must(cond: boolean, msg: string) {
    if (!cond) {
        console.error(`\n✗ ${msg}`);
        process.exit(1);
    }
}

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv = process.env): number {
    const res = spawnSync(cmd, args, { stdio: "inherit", cwd: ROOT, env });
    return res.status ?? 1;
}

// ── state ────────────────────────────────────────────────────────────────

function loadState(): WizardState | null {
    try {
        return JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
    } catch {
        return null;
    }
}

function saveState(s: WizardState) {
    fs.writeFileSync(STATE_PATH, JSON.stringify(s, null, 2));
}

// ── config editors ───────────────────────────────────────────────────────

function anchorToml(): string {
    return fs.readFileSync(ANCHOR_TOML, "utf8");
}

function setProviderWallet(p: string) {
    const s = anchorToml().replace(/^wallet\s*=.*$/m, `wallet = "${p}"`);
    fs.writeFileSync(ANCHOR_TOML, s);
}

function setProviderCluster(cluster: string) {
    const s = anchorToml().replace(/^cluster\s*=.*$/m, `cluster = "${cluster}"`);
    fs.writeFileSync(ANCHOR_TOML, s);
}

function upsertEnv(values: Record<string, string>) {
    let s = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, "utf8") : "";
    for (const [k, v] of Object.entries(values)) {
        const re = new RegExp(`^${k}=.*$`, "m");
        if (re.test(s)) s = s.replace(re, `${k}=${v}`);
        else s += (s.endsWith("\n") || s === "" ? "" : "\n") + `${k}=${v}\n`;
    }
    fs.writeFileSync(ENV_PATH, s);
}

// ── wallets ──────────────────────────────────────────────────────────────

function walletPath(role: Role) {
    return path.join(KEYS_DIR, `${role}.json`);
}

function pubkeyOf(file: string): string {
    const res = spawnSync("solana-keygen", ["pubkey", file], { encoding: "utf8" });
    must(res.status === 0, "solana-keygen pubkey failed — is the Solana CLI installed?");
    return res.stdout.trim();
}

// solana-keygen new, stdio inherited: it clears the screen, shows the phrase
// ONCE, and makes the user confirm a random word before writing the file.
function genWallet(role: Role): string {
    const file = walletPath(role);
    fs.mkdirSync(KEYS_DIR, { recursive: true });
    console.log(`\n  ${role} wallet — solana-keygen will show the recovery phrase ONCE`);
    console.log(`  and ask you to confirm a word from it. Write the phrase down NOW;`);
    console.log(`  it is the ONLY backup (the JSON file alone is not a paper backup).`);
    const ok = run("solana-keygen", [
        "new",
        "--no-bip39-passphrase",
        "--force",
        "--outfile", file,
    ]) === 0;
    must(ok, `solana-keygen failed for the ${role} wallet.`);
    const pk = pubkeyOf(file);
    console.log(`  ✓ ${role} wallet: ${pk}  (${path.relative(ROOT, file)})`);
    return pk;
}

function loadKeypair(file: string): Keypair {
    return Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(file, "utf8"))));
}

// ── balances / funding ───────────────────────────────────────────────────

interface Needs {
    sol: number;
    usdc: number;
    note: string;
}

function fundingNeeds(cluster: Cluster): Record<Role, Needs> {
    // Same amounts on both clusters — launch-bundle's hard preflights enforce
    // the USDC legs (USDC_TO_LP seed + 0.18×L buy) regardless of cluster, so
    // the wizard shows them everywhere (devnet USDC comes from your reserve).
    const usdcToLp = Number(process.env.USDC_TO_LP || 2000);
    const buyUsdc = Math.ceil((usdcToLp * 18) / 100);
    const src = cluster === "mainnet-beta" ? "from your exchange" : "from your devnet USDC reserve";
    return {
        launch: { sol: 11, usdc: usdcToLp, note: `program rent ~8.7 + PDA/vault rent ~1.5 + fees ${src}` },
        buyer: { sol: 0.05, usdc: buyUsdc, note: `bundle fees + stake rents / the 3% buy = 0.18 × USDC_TO_LP ${src}` },
        keeper: { sol: 0.5, usdc: 0, note: "VPS hot wallet — crank fees for the first weeks" },
    };
}

async function balances(conn: Connection, owner: PublicKey, usdcMint: PublicKey) {
    const sol = (await conn.getBalance(owner)) / LAMPORTS_PER_SOL;
    let usdc = 0;
    try {
        const tas = await conn.getParsedTokenAccountsByOwner(owner, { mint: usdcMint });
        for (const { account } of tas.value) usdc += account.data.parsed.info.tokenAmount.uiAmount ?? 0;
    } catch { /* no account yet */ }
    return { sol, usdc };
}

function bar(label: string, have: number, need: number, unit: string): boolean {
    const pct = need <= 0 ? 1 : Math.min(1, have / need);
    const width = 24;
    const filled = Math.round(pct * width);
    const mark = pct >= 1 ? "✓" : "…";
    console.log(
        `  ${label.padEnd(8)} ${String(have.toFixed(unit === "SOL" ? 2 : 0)).padStart(9)} / ${need} ${unit}  [${"█".repeat(filled)}${"░".repeat(width - filled)}] ${(pct * 100).toFixed(0).padStart(3)}% ${mark}`,
    );
    return pct >= 1;
}

async function fundingPhase(
    conn: Connection,
    cluster: Cluster,
    wallets: Record<Role, string>,
    state: WizardState,
) {
    const needs = fundingNeeds(cluster);
    const usdcMint = usdcMintFor(cluster, process.env.USDC_MINT);
    const pubs: Record<Role, PublicKey> = {
        launch: new PublicKey(wallets.launch),
        buyer: new PublicKey(wallets.buyer),
        keeper: new PublicKey(wallets.keeper),
    };

    hr("FUNDING — send to these addresses, the bars fill as balances land");
    for (const role of ROLE_WALLETS) {
        console.log(`  ${role.padEnd(8)} ${wallets[role]}`);
        console.log(`  ${"".padEnd(8)} needs ${needs[role].sol} SOL` +
            (needs[role].usdc ? ` + ${needs[role].usdc} USDC` : "") +
            `  (${needs[role].note})`);
    }
    console.log(`\n  USDC mint (${cluster}): ${usdcMint.toBase58()} — send plain SPL-USDC, not from a program deposit.`);
    if (cluster === "devnet") console.log("  devnet: SOL airdrop is automatic below if the faucet allows; USDC via your devnet reserve.");

    await pause("Fund the addresses (exchanges/withdrawals can take minutes). Press ENTER to start watching…");

    let autoSent = false;
    for (;;) {
        const rows: Record<Role, Awaited<ReturnType<typeof balances>>> = {} as never;
        for (const role of ROLE_WALLETS) rows[role] = await balances(conn, pubs[role], usdcMint);
        console.log("");
        let allMet = true;
        for (const role of ROLE_WALLETS) {
            const metSol = bar(`${role} SOL`, rows[role].sol, needs[role].sol, "SOL");
            const metUsdc = needs[role].usdc === 0 || bar(`${role} USDC`, rows[role].usdc, needs[role].usdc, "USDC");
            allMet = allMet && metSol && metUsdc;
        }

        if (allMet) {
            console.log("\n  ✓ every wallet funded above its requirement.");
            break;
        }

        // Optional SOL top-up legs from the (funded) launch wallet.
        if (!autoSent && rows.launch.sol >= needs.launch.sol + 0.6 &&
            await confirm("\n  Launch wallet has spare SOL — auto-send the buyer + keeper SOL legs from it?", false)) {
            const launch = loadKeypair(walletPath("launch"));
            for (const [role, amount] of [["buyer", 0.05], ["keeper", 0.5]] as const) {
                const missing = needs[role].sol - rows[role].sol;
                if (missing <= 0) continue;
                const tx = new Transaction().add(
                    SystemProgram.transfer({
                        fromPubkey: launch.publicKey,
                        toPubkey: pubs[role],
                        lamports: Math.round(Math.min(amount, missing + 0.02) * LAMPORTS_PER_SOL),
                    }),
                );
                const sig = await sendAndConfirmTransaction(conn, tx, [launch]);
                console.log(`  → sent ${Math.min(amount, missing + 0.02)} SOL to ${role}: ${sig}`);
            }
            autoSent = true;
            continue;
        }

        if (cluster === "devnet" && rows.launch.sol < needs.launch.sol &&
            await confirm("  Request a devnet airdrop of 5 SOL to the launch wallet?", false)) {
            try {
                await conn.requestAirdrop(pubs.launch, 5 * LAMPORTS_PER_SOL);
                console.log("  → airdrop requested ( faucet-ratelimited at times — retry later if 0 )");
            } catch (e) {
                console.log(`  airdrop failed: ${(e as Error).message}`);
            }
        }

        const again = await rl.question("\n  [ENTER] re-check  ·  [s] skip funding gate  ·  [q] quit > ");
        const a = again.trim().toLowerCase();
        if (a === "q") { console.log("state saved — rerun to resume."); process.exit(0); }
        if (a === "s") {
            must(cluster === "devnet",
                "funding gate cannot be skipped on mainnet — the launch-bundle preflights would fail anyway, loudly.");
            console.log("  ⚠ skipped (devnet) — later preflights still enforce what they need.");
            break;
        }
    }
    state.phase = "funded";
    saveState(state);
}

// ── NYSE session window (soft check; the bundle preflight hard-fails) ────

function nyseWindow(): string {
    const now = new Date();
    const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: "America/New_York",
        weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false,
    }).formatToParts(now);
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
    const day = get("weekday");
    const mins = Number(get("hour")) * 60 + Number(get("minute"));
    const weekend = day === "Sat" || day === "Sun";
    const inWindow = !weekend && mins >= 9 * 60 + 35 && mins <= 15 * 60 + 50;
    if (inWindow) return `OPEN window now (${day} ${get("hour")}:${get("minute")} ET) — good to launch.`;
    if (weekend) return "WEEKEND — NYSE closed. The freeze legs need a weekday open session; run Monday 09:35–15:50 ET.";
    return `Outside the safe window (${day} ${get("hour")}:${get("minute")} ET). Launch weekdays 09:35–15:50 ET, clear of the bell flips.`;
}

// ── program ids + manifest ───────────────────────────────────────────────

function programIds(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const p of ["amm", "crank_oracle", "staking"]) {
        const f = path.join(ROOT, `target/deploy/${p}-keypair.json`);
        if (fs.existsSync(f)) out[p] = pubkeyOf(f);
    }
    return out;
}

function writeManifest(state: WizardState, wallets: Record<Role, string>) {
    fs.mkdirSync(KEYS_DIR, { recursive: true });
    const mint = state.mint ? new PublicKey(state.mint) : null;
    const file = path.join(KEYS_DIR, `deploy-manifest-${new Date().toISOString().replace(/[:T]/g, "-").slice(0, 16)}.json`);
    fs.writeFileSync(file, JSON.stringify({
        createdAt: new Date().toISOString(),
        cluster: state.cluster,
        usdcToLp: Number(process.env.USDC_TO_LP || 2000),
        programs: programIds(),
        mint: state.mint ?? null,
        poolPda: mint ? derivePoolId(mint, state.cluster).toBase58() : null,
        wallets, // pubkeys only
        keeperAuthoritySetTo: wallets.keeper,
    }, null, 2));
    console.log(`\n  manifest (no secrets): ${path.relative(ROOT, file)}`);
}

// ── main flow ────────────────────────────────────────────────────────────

async function main() {
    const argv = process.argv.slice(2);
    const dry = argv.includes("--dry");
    const newWallets = argv.includes("--new-wallets");
    const fromIdx = argv.indexOf("--from");
    const fromStep = fromIdx >= 0 ? argv[fromIdx + 1] : undefined;

    const isDeployRepo = fs.existsSync(path.join(ROOT, ".deploy-repo"));
    const rawTomlCluster = anchorToml().match(/^cluster\s*=\s*"(.+)"$/m)?.[1];
    const tomlCluster = rawTomlCluster === "mainnet" ? "mainnet-beta" : rawTomlCluster as Cluster | undefined;
    const flagCluster = argv.includes("--cluster")
        ? (argv[argv.indexOf("--cluster") + 1] as Cluster)
        : (process.env.DEPLOY_CLUSTER as Cluster | undefined);
    const prev = loadState();
    const cluster: Cluster =
        flagCluster ?? prev?.cluster ?? tomlCluster ?? "mainnet-beta";
    must(cluster === "devnet" || cluster === "mainnet-beta", `unknown cluster "${cluster}"`);

    const net = resolveSolanaConfig();
    console.log("\n╔════════════════════════════════════════════════════════════════════╗");
    console.log("║           AFHO deploy wizard — fresh wallets, one command          ║");
    console.log("╚════════════════════════════════════════════════════════════════════╝");
    console.log(`  repo:      ${ROOT} ${isDeployRepo ? "(deploy tree)" : "(DEV TREE)"}`);
    console.log(`  cluster:   ${cluster}   (solana config says: ${net.cluster})`);

    // gate: the dev tree never deploys mainnet from here
    if (cluster === "mainnet-beta" && !isDeployRepo) {
        console.error("\n✗ REFUSED: this is the DEV repo. Mainnet deploys run from the deploy");
        console.error("  tree (mainnet-afho). Rehearse here with DEPLOY_CLUSTER=devnet.");
        process.exit(1);
    }

    const usdcToLp = Number(process.env.USDC_TO_LP || 2000);
    if (cluster === "mainnet-beta") {
        console.log(`\n  ┌─ MAINNET, real money ────────────────────────────────────────────┐`);
        console.log(`  │  launch wallet needs  ~${11} SOL + ${usdcToLp} USDC (USDC_TO_LP)`);
        console.log(`  │  buy wallet needs     ~0.05 SOL + ${Math.ceil(usdcToLp * 0.18)} USDC`);
        console.log(`  │  LP USDC is gone the moment fund-launch + the bundle land.      `);
        console.log(`  │  LP burn is PERMANENT (default-on).                             `);
        console.log(`  └──────────────────────────────────────────────────────────────────┘`);
        await typedConfirm("MAINNET");
    } else {
        console.log("  devnet rehearsal — throwaway mint, no typed gate, same flow.");
    }

    const state: WizardState = prev && prev.cluster === cluster && !newWallets
        ? prev
        : { cluster, phase: "gate", rotated: false, deployed: false };

    // ── preflight ──
    hr("PREFLIGHT");
    for (const tool of ["solana", "solana-keygen", "anchor"]) {
        must(run(tool, ["--version"], { ...process.env }) === 0, `${tool} not found on PATH`);
    }
    const rpc = net.rpcUrl || `https://api.${cluster}.solana.com`;
    if (cluster === "mainnet-beta" && /api\.mainnet-beta\.solana\.com/.test(rpc)) {
        console.log("  ⚠ public mainnet RPC — rate limits WILL bite mid-launch. Set RPC_URL in .env");
        console.log("    (paid Helius) before the real run. Continuing anyway.");
    }
    const conn = new Connection(rpc, "confirmed");
    try {
        const [v, genesis] = await Promise.all([conn.getVersion(), conn.getGenesisHash()]);
        console.log(`  rpc:      ${rpc}`);
        console.log(`  version:  ${v["solana-core"]}   genesis: ${genesis}`);
    } catch (e) {
        must(false, `RPC unreachable (${(e as Error).message})`);
    }
    console.log(`  window:   ${nyseWindow()}`);
    console.log(`  USDC_TO_LP=${usdcToLp}${process.env.USDC_TO_LP ? "" : " (default — set it in .env!)"}`);
    if (await confirm("  Edit USDC_TO_LP / .env before continuing?", false)) {
        await pause("  Edit .env now (USDC_TO_LP, RPC_URL, …) — then come back and press ENTER…");
    }
    const uri = fs.readFileSync(path.join(ROOT, "scripts/launch/mint-create.ts"), "utf8")
        .match(/uri:\s*'([^']+)'/)?.[1];
    console.log(`  metadata uri: ${uri ?? "(not found)"}`);
    console.log("    (frozen at mint-create — if the JSON changed, re-upload to IPFS and update it FIRST)");

    hr("PLAN");
    console.log("  wallets (fresh) → funding bars → rotate program keys → anchor deploy");
    console.log("  → prep (mint-create) → " + STEPS.map((s) => s.name).join(" → "));
    console.log("  → set-keeper + VPS handoff + manifest");
    if (dry) {
        console.log("\n--dry: gates + preflights only. Nothing generated, nothing sent, no files touched. ✓");
        rl.close();
        return;
    }

    // anchor's [provider] cluster drives anchor build/deploy + which
    // [programs.*] section gets synced — keep it equal to the session cluster
    // (accept anchor's "mainnet" spelling for mainnet-beta). Past the dry
    // gate only: a --dry run must never touch config.
    const tomlMatches = rawTomlCluster === cluster ||
        (cluster === "mainnet-beta" && rawTomlCluster === "mainnet");
    if (!tomlMatches) {
        setProviderCluster(cluster === "mainnet-beta" ? "mainnet" : cluster);
        console.log(`  Anchor.toml [provider] cluster → ${cluster} (restore later: git checkout -- Anchor.toml)`);
    }

    // ── wallets ──
    hr("WALLETS — fresh per deployment instance");
    const wallets = state.wallets ?? ({} as Record<Role, string>);
    for (const role of ROLE_WALLETS) {
        const file = walletPath(role);
        if (!newWallets && wallets[role] && fs.existsSync(file)) {
            const current = pubkeyOf(file);
            if (current === wallets[role]) {
                console.log(`  ✓ reusing ${role} wallet: ${wallets[role]}`);
                continue;
            }
        }
        wallets[role] = genWallet(role);
    }
    state.wallets = wallets;
    state.phase = "wallets";
    saveState(state);

    setProviderWallet(walletPath("launch"));
    upsertEnv({ BUYER_WALLET_KEY: JSON.stringify(Array.from(loadKeypair(walletPath("buyer")).secretKey)) });
    console.log(`  Anchor.toml [provider] wallet → ${walletPath("launch")}`);
    console.log(`  .env BUYER_WALLET_KEY ← keys/buyer.json secret (gitignored file also kept)`);

    // ── funding ──
    if (state.phase !== "funded" || newWallets) {
        await fundingPhase(conn, cluster, wallets, state);
    } else {
        console.log("\n  funding already confirmed in this session — skipping (use --new-wallets to redo).");
    }

    // ── program keys + deploy ──
    hr("PROGRAM KEYS + DEPLOY");
    if (!state.rotated) {
        console.log("  Fresh program IDs = fresh PDA namespace (mandatory per instance).");
        console.log("  Old keypairs are archived outside the repo — never deleted.");
        if (await confirm("  Run tools/rotate-program-keys.sh now? (builds twice, ~2 min)", true)) {
            must(run("bash", [path.join(ROOT, "tools/rotate-program-keys.sh")]) === 0, "key rotation failed");
            state.rotated = true;
            saveState(state);
        }
    } else {
        console.log("  program keys already rotated this session.");
    }

    if (!state.deployed) {
        // mint keypair: throwaway on devnet, THE vanity keypair on mainnet
        if (cluster === "devnet" && !fs.existsSync(MINT_KEYPAIR)) {
            fs.mkdirSync(path.dirname(MINT_KEYPAIR), { recursive: true });
            fs.writeFileSync(MINT_KEYPAIR, JSON.stringify(Array.from(Keypair.generate().secretKey)));
            console.log(`  devnet throwaway mint: ${pubkeyOf(MINT_KEYPAIR)}`);
        }
        if (cluster === "mainnet-beta") {
            if (!fs.existsSync(MINT_KEYPAIR)) {
                console.log(`\n  !! Put your VANITY mint keypair at target/deploy/afho_token-keypair.json`);
                await pause("  …then press ENTER to continue…");
            }
            must(fs.existsSync(MINT_KEYPAIR), "mint keypair still missing.");
            console.log(`  mint: ${pubkeyOf(MINT_KEYPAIR)} — confirm this is your mainnet vanity mint.`);
            await typedConfirm(pubkeyOf(MINT_KEYPAIR).slice(0, 4));
        }
        state.mint = pubkeyOf(MINT_KEYPAIR);
        saveState(state);

        console.log("\n  anchor deploy — three programs, rent paid from the launch wallet.");
        await pause("  ENTER to deploy (ctrl-C to abort)…");
        must(run("anchor", ["deploy"], { ...process.env, ANCHOR_PROVIDER_URL: rpc }) === 0, "anchor deploy failed");
        state.deployed = true;
        state.phase = "deployed";
        saveState(state);
    } else {
        console.log("  programs already deployed this session.");
    }

    // ── prep + launch chain with per-step gates ──
    hr("PREP (mint-create)");
    await pause("  ENTER to claim the mint on-chain…");
    must(run("anchor", ["run", "prep"], { ...process.env, ANCHOR_PROVIDER_URL: rpc }) === 0, "prep failed");

    hr("LAUNCH CHAIN");
    const env = { ...process.env, ANCHOR_PROVIDER_URL: rpc };
    const steps = process.env.SKIP_BURN === "1" ? STEPS.filter((s) => s.name !== "burn-lp") : STEPS;
    const startAt = fromStep ? steps.map((s) => s.name).lastIndexOf(fromStep) : 0;
    must(startAt >= 0, `unknown --from step "${fromStep}"`);
    for (let i = startAt; i < steps.length; i++) {
        const step = steps[i];
        console.log(`\n━━━ [${i + 1}/${steps.length}] ${step.label}  (anchor run ${step.script}) ━━━`);
        const oneWay = cluster === "mainnet-beta" && (step.name === "fund-launch" || step.name === "burn-lp");
        if (oneWay) await typedConfirm(step.name === "burn-lp" ? "BURN" : "FUND");
        else if (!(await confirm("  Run this step?", true))) {
            console.log(`  skipped — resume later with: anchor run deploy -- --from ${step.name}`);
            process.exit(0);
        }
        must(run("anchor", ["run", step.script], env) === 0,
            `step "${step.script}" failed — fix and resume: anchor run deploy -- --from ${step.name}`);
    }

    // ── post: keeper + handoff + manifest ──
    hr("KEEPER + HANDOFF");
    await pause(`  ENTER to set the AMM keeper to the new keeper wallet\n  (${wallets.keeper})…`);
    must(run("anchor", ["run", "set-keeper"], { ...env, KEEPER: wallets.keeper }) === 0, "set-keeper failed");

    console.log(`
  ── VPS handoff (manual, deliberate) ─────────────────────────────────
  1. scp ${walletPath("keeper")} → the VPS (once, by hand); keep the phrase in
     your paper backup. The VPS wallet file is the ONLY live keeper copy.
  2. VPS .env: RPC_URL=${rpc}
  3. svps (script sync) then:  systemctl restart afho-keeper afho-announcer
     (the announcer pins PDAs at startup — a relaunch that rewrote
      deployment.json MUST restart it; empty journal ≠ dead.)
  4. Stop any PC-side announcer/keeper tabs first.
`);
    writeManifest(state, wallets);
    console.log(`\n  Wallet phrases: paper only. keys/*.json files: encrypted offline copy.`);
    console.log(`  Next (separate, deliberate — NOT automated here): rotate authorities`);
    console.log(`  to the Squads vault (set-keeper BEFORE amm — done), then the renounce`);
    console.log(`  trio per MAINNET_CHECKLIST §3 once the audit clears.`);
    if (fs.existsSync(STATE_PATH)) fs.unlinkSync(STATE_PATH);
    console.log(`\n✓ deploy wizard complete (${cluster}).`);
    rl.close();
}

main().catch((e) => {
    console.error(`\n✗ wizard aborted: ${(e as Error).stack ?? e}`);
    console.error("  state saved — rerun `anchor run deploy` to resume where it stopped.");
    process.exit(1);
});
