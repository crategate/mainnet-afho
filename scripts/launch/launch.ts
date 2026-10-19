import { spawnSync } from "child_process";
import { resolveSolanaConfig } from "../lib/cluster";
import { STEPS } from "../lib/launch-steps";

// launch.ts — run the mint→pool sequence as one command (mint-create is now
// the separate `anchor run prep` step — see scripts/launch/prep.ts).
//
//   npx ts-node scripts/launch/launch.ts             # full sequence incl. LP burn
//   npx ts-node scripts/launch/launch.ts --from create-pool   # resume after a failed step
//   npx ts-node scripts/launch/launch.ts --dry       # print the plan, run nothing
//
// 2026-09-29 (buyer retirement): the retired VPS snipe buyer is replaced by
// launch-bundle — pool creation + the 3% buy + the 5M-lot stakes as ONE Jito
// bundle on mainnet (all-or-nothing; sequential on devnet). The buy wallet
// (BUYER_WALLET_KEY) is balance-checked by launch-bundle's preflight before
// anything is sent.
//
// 2026-09-19 (Switchboard removal):
//   - feed-deploy is GONE (Switchboard wound down). `init` now sequences
//     initialize.ts → init-calendar.ts (the market-calendar PDA) →
//     init-bounty.ts.
//   - check-authorities runs BEFORE fund-launch (genesis-race guard: verify
//     the on-chain authorities BEFORE minting the 80% into the vault) and
//     again at the end.
//   - burn-lp is part of the sequence (LP burn is the default behavior —
//     2026-09-17 decision; burn-lp.ts executes by default now). Set
//     SKIP_BURN=1 only for a Phase-0 rehearsal where LP must stay
//     recoverable.
//
// The individual `anchor run <step>` scripts still exist and are unchanged;
// this only sequences them, stops on the first failure, and reads the network
// from `solana config get` so you never have to touch ANCHOR_PROVIDER_URL.
//
// 2026-10-02: web-dist is the final step — npm run build in app/ (the
// typecheck gate; vite dev never typechecks) then app/dist/dep.zip for
// upload. It runs LAST because the build copies app/public/deployment.json
// into the zip, and a web failure after burn-lp touches nothing on-chain.

function main() {
    const args = process.argv.slice(2);
    const dry = args.includes("--dry");
    const fromIdx = args.indexOf("--from");
    const fromName = fromIdx >= 0 ? args[fromIdx + 1] : undefined;

    const net = resolveSolanaConfig();
    let steps = STEPS;
    if (process.env.SKIP_BURN === "1") {
        steps = steps.filter((s) => s.name !== "burn-lp");
        console.log("SKIP_BURN=1 — LP burn step removed (Phase-0 rehearsal mode; LP stays recoverable).");
    }

    let startAt = 0;
    if (fromName) {
        const matches = steps.map((s, i) => ({ s, i })).filter(({ s }) => s.name === fromName);
        if (matches.length === 0) {
            console.error(`Unknown --from step "${fromName}". Choices: ${steps.map((s) => s.name).join(", ")}`);
            process.exit(1);
        }
        startAt = matches[matches.length - 1].i;
    }

    console.log(`network: ${net.cluster} (${net.rpcUrl || "Anchor.toml default"})`);
    console.log(`plan:    ${steps.map((s) => s.name).join(" → ")}`);
    if (startAt > 0) console.log(`resume:  skipping ${steps.slice(0, startAt).map((s) => s.name).join(", ")}`);
    if (dry) return;

    const env = { ...process.env, ANCHOR_PROVIDER_URL: net.rpcUrl || process.env.ANCHOR_PROVIDER_URL || "" };

    for (let i = startAt; i < steps.length; i++) {
        const step = steps[i];
        console.log(`\n━━━ [${i + 1}/${steps.length}] ${step.label}  (anchor run ${step.script}) ━━━`);
        const res = spawnSync("anchor", ["run", step.script], { stdio: "inherit", env });
        if (res.status !== 0) {
            console.error(`\n✗ "${step.script}" failed (exit ${res.status ?? "signal"}).`);
            if (step.name === "check-authorities") {
                console.error(`  AUTHORITY CHECK FAILED — do not resume past this point. Either re-run the`);
                console.error(`  launch from the right wallet, or rotate authorities (see the error above).`);
                console.error(`  If the mint was front-run (genesis race), rotate to a fresh mint keypair.`);
            }
            console.error(`  Fix it, then resume with:  npx ts-node scripts/launch/launch.ts --from ${step.name}`);
            process.exit(res.status ?? 1);
        }
    }

    console.log(`\n✓ launch sequence complete (${steps.length} step${steps.length === 1 ? "" : "s"}).`);
}

main();
