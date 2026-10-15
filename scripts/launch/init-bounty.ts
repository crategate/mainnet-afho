import * as anchor from "@coral-xyz/anchor";
import * as fs from "fs";
import * as path from "path";
import { PublicKey } from "@solana/web3.js";
import { resolveSolanaConfig } from "../lib/cluster";
import { usdcMintFor } from "../lib/cpmm";

// init-bounty.ts — initialize (or migrate) the crank-oracle BountyConfig.
//
// 2026-09-19 Switchboard removal: initialize_bounty no longer takes oracle
// pins (the queue/feed bytes at offsets 165/229 are dead, zeroed by the
// program). An existing legacy config (165- or 229-byte devnet) is migrated
// in place by this call, authority-gated on-chain. The market CALENDAR is a
// separate PDA — run `anchor run init` (initialize.ts → init-calendar.ts →
// this) or `anchor run init-calendar` standalone. USDC comes from the
// cluster `solana config get` reports via usdcMintFor().

// $0.75 per crank, +5% per calendar year after the base year.
const BOUNTY_USD_RAW = 750_000n; // 0.75 USDC (6 dp)
const BASE_YEAR = 2026;
const ANNUAL_INFLATION_BPS = 500; // 5%

async function main() {
    const provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);

    const idlPath = path.join(process.cwd(), "target", "idl", "crank_oracle.json");
    const idl = JSON.parse(fs.readFileSync(idlPath, "utf-8"));
    const program = new anchor.Program(idl, provider);

    const net = resolveSolanaConfig();
    const USDC_MINT = usdcMintFor(net.cluster, process.env.USDC_MINT);

    const deployment = JSON.parse(
        fs.readFileSync(path.join(process.cwd(), "app", "public", "deployment.json"), "utf-8")
    );

    const [bountyConfigPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("bounty_config")],
        program.programId
    );
    const [bountyVaultPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("bounty_vault")],
        program.programId
    );

    console.log(`[${net.cluster}] Initializing bounty config...`);
    console.log("Config:", bountyConfigPda.toBase58());
    console.log("Vault:", bountyVaultPda.toBase58());

    const solUsdcPool = new PublicKey(deployment.raydiumSolUsdcPool);
    const cpmmProgram = new PublicKey(deployment.raydiumProgram);

    try {
        const tx = await program.methods
            .initializeBounty(
                new anchor.BN(5_000_000), // fallback lamports (0.005 SOL)
                new anchor.BN(BOUNTY_USD_RAW.toString()),
                BASE_YEAR,
                ANNUAL_INFLATION_BPS,
                solUsdcPool,
                cpmmProgram,
                USDC_MINT
            )
            .accounts({
                payer: provider.wallet.publicKey,
                bountyConfig: bountyConfigPda,
                bountyVault: bountyVaultPda,
                systemProgram: anchor.web3.SystemProgram.programId,
            })
            .rpc();
        console.log(" Bounty initialized:", tx);
    } catch (e) {
        // bounty_config is program-global (seeds=["bounty_config"], not
        // per-mint), so a re-launch with a fresh devnet mint finds it already
        // initialized. That's fine ONLY if its authority is this wallet —
        // the invariant check below decides, not the error text. (Legacy
        // 165-/229-byte configs MIGRATE on this call.)
        console.error("initializeBounty tx failed (checking on-chain state):", e);
    }

    // The breaker venues default to the verified MAINNET pair at init. Those
    // pools don't exist on devnet — clear them there so the crank runs with the
    // breaker inert (fail-open). The halt drill re-pins its own devnet venues.
    if (net.cluster === "devnet") {
        const [marketCalendarPda] = PublicKey.findProgramAddressSync(
            [Buffer.from("market_calendar")],
            program.programId
        );
        try {
            await program.methods
                .setHaltPools(PublicKey.default, PublicKey.default)
                .accounts({
                    calendarAuthority: provider.wallet.publicKey,
                    marketCalendar: marketCalendarPda,
                    bountyConfig: bountyConfigPda,
                    // Clearing the venues — default-pubkey fillers (the
                    // handler skips venue validation on the zero pair).
                    poolAAcc: PublicKey.default,
                    poolBAcc: PublicKey.default,
                })
                .rpc();
            console.log(" devnet: circuit-breaker venues cleared (breaker inert)");
        } catch (e) {
            console.error("setHaltPools(0,0) failed on devnet:", e);
        }
    }

    // Invariant on every exit path: bounty_config exists and its authority
    // is the launch wallet. Fail the launch here instead of bricks/0x1773
    // later.
    // (NB: Program camelCases account names for the coder — use the account
    // namespace, not coder.accounts.decode("BountyConfig").)
    const cfg = await (program.account as any).bountyConfig.fetchNullable(bountyConfigPda);
    if (!cfg) {
        console.error("✗ bounty_config does not exist after init — cannot verify.");
        process.exit(1);
    }
    const authority = cfg.authority as PublicKey;
    const walletPk = provider.wallet.publicKey;
    console.log(`Bounty authority: ${authority.toBase58()}`);
    if (!authority.equals(walletPk)) {
        console.error(`✗ bounty authority is NOT this launch wallet.`);
        console.error(`    on-chain authority : ${authority.toBase58()}`);
        console.error(`    launch wallet      : ${walletPk.toBase58()}`);
        console.error(`  Fix before continuing (fund_bounty / set_bounty_usd will fail 0x1773 otherwise):`);
        console.error(`    - rotate to this wallet (signed by the current authority wallet):`);
        console.error(`        NEW_AUTHORITY=${walletPk.toBase58()} WHICH=crank npx ts-node scripts/launch/rotate-authorities.ts`);
        console.error(`    - or run the launch from the authority wallet`);
        process.exit(1);
    }
    console.log("✓ bounty authority verified (oracle pins are gone — dead bytes zeroed by the program).");
}

main();
