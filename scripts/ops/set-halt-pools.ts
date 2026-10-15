// ─────────────────────────────────────────────────────────────────────
// set-halt-pools — re-point the two SPYx/USDC Raydium CLMM pools the Rule
// 7.12 circuit breaker reads.
//
// Gated by the CALENDAR AUTHORITY (Squads multisig) — a MAINTENANCE knob for
// a Raydium/xStocks venue rotation, NOT a halt override: halt DETECTION stays
// fully automatic (pool mechanics only); this can never trigger, fabricate,
// or extend a halt.
//
//   HALT_POOLS=<a>,<b>  anchor run set-halt-pools   # re-point to an explicit pair
//   HALT_POOLS=0        anchor run set-halt-pools   # clear (breaker inert)
//   (no env, mainnet)                               # the verified SPYx pair
//
// Run as the calendar authority (the multisig vault PDA, via Squads).
// ─────────────────────────────────────────────────────────────────────
import * as anchor from "@coral-xyz/anchor";
import * as fs from "fs";
import * as path from "path";
import { PublicKey } from "@solana/web3.js";
import { MAINNET_HALT_POOLS, validatePoolPair } from "../lib/clmm";

async function main() {
    const provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);

    const idlPath = path.join(process.cwd(), "target", "idl", "crank_oracle.json");
    if (!fs.existsSync(idlPath)) throw new Error(`IDL not found at ${idlPath}. Run 'anchor build' first.`);
    const idl = JSON.parse(fs.readFileSync(idlPath, "utf-8"));
    const program = new anchor.Program(idl, provider);

    let a: PublicKey;
    let b: PublicKey;
    if (process.env.HALT_POOLS === "0") {
        a = PublicKey.default;
        b = PublicKey.default;
    } else if (process.env.HALT_POOLS) {
        const parts = process.env.HALT_POOLS.split(",").map((s) => s.trim());
        if (parts.length !== 2) throw new Error("HALT_POOLS must be '<poolA>,<poolB>' or 0");
        a = new PublicKey(parts[0]);
        b = new PublicKey(parts[1]);
    } else {
        console.log("no HALT_POOLS env → using the verified mainnet SPYx/USDC pair");
        [a, b] = MAINNET_HALT_POOLS;
    }

    if (!a.equals(PublicKey.default)) {
        // Pre-validate the way the program will at crank time — fail before
        // re-pointing anything the breaker couldn't read.
        const { poolA, poolB, divergencePct } = await validatePoolPair(provider.connection, a, b);
        console.log(`pool A ${a.toBase58()}: price raw ${poolA.priceRaw}`);
        console.log(`pool B ${b.toBase58()}: price raw ${poolB.priceRaw}`);
        if (divergencePct > 2) {
            throw new Error(`pools disagree by ${divergencePct.toFixed(2)}% — pick two live venues`);
        }
    }

    const [marketCalendarPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("market_calendar")],
        program.programId
    );
    const [bountyConfigPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("bounty_config")],
        program.programId
    );
    const sig = await program.methods
        .setHaltPools(a, b)
        .accounts({
            calendarAuthority: provider.wallet.publicKey,
            marketCalendar: marketCalendarPda,
            bountyConfig: bountyConfigPda,
            // Pin-time ownership proof: the pool accounts themselves. When
            // clearing (zero pair) these are default-pubkey fillers the
            // handler skips.
            poolAAcc: a,
            poolBAcc: b,
        })
        .rpc();

    // Read-back verification.
    const cfg: any = await (program.account as any).bountyConfig.fetch(bountyConfigPda);
    const landed = new PublicKey(cfg.haltPoolA).equals(a) && new PublicKey(cfg.haltPoolB).equals(b);
    if (!landed) {
        console.error(`✗ venue re-point did NOT land (on-chain ${cfg.haltPoolA} / ${cfg.haltPoolB})`);
        process.exit(1);
    }
    console.log(
        a.equals(PublicKey.default)
            ? `circuit-breaker venues CLEARED — breaker inert (${sig})`
            : `circuit-breaker venues re-pointed + VERIFIED — ${sig}`
    );
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
