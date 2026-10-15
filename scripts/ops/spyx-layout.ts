// ─────────────────────────────────────────────────────────────────────
// spyx-layout — one-shot probe of the live SPYx/USDC CLMM pools.
// Run from a machine with mainnet RPC access BEFORE arming the breaker:
//
//   anchor run spyx-layout            # probes the default SPYx pair
//   POOLS=<a>,<b> anchor run spyx-layout
//
// Confirms the exact bytes the program reads: CLMM ownership, 1544-byte
// size, 6/6 decimals, identical mint pair across venues, a sqrt price that
// decodes to a sane SPY level, and cross-venue agreement. Any ✗ = do not
// arm; the program's on-chain canaries will reject the same things.
// ─────────────────────────────────────────────────────────────────────
import * as anchor from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { MAINNET_HALT_POOLS, SPYX_MINT, validatePoolPair } from "../lib/clmm";

async function main() {
    const provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);

    const [a, b] = process.env.POOLS
        ? (process.env.POOLS.split(",").map((s) => new PublicKey(s.trim())) as [PublicKey, PublicKey])
        : MAINNET_HALT_POOLS;

    console.log(`probing ${a.toBase58()} + ${b.toBase58()} on ${provider.connection.rpcEndpoint}\n`);
    let ok = true;
    try {
        const { poolA, poolB, divergencePct } = await validatePoolPair(provider.connection, a, b);
        const hasSpyx = poolA.mintA.equals(SPYX_MINT) || poolA.mintB.equals(SPYX_MINT);
        console.log(`pool A: mints ${poolA.mintA.toBase58()} / ${poolA.mintB.toBase58()}`);
        console.log(`       decimals ${poolA.decimalsA}/${poolA.decimalsB}  priceRaw ${poolA.priceRaw}`);
        console.log(`pool B: priceRaw ${poolB.priceRaw}`);
        console.log(`cross-venue divergence: ${divergencePct.toFixed(3)}%`);
        if (!hasSpyx) {
            console.error(`✗ neither mint is the SPYx mint ${SPYX_MINT.toBase58()} — wrong pools?`);
            ok = false;
        }
        if (divergencePct > 1) {
            console.error(`✗ venues disagree by ${divergencePct.toFixed(2)}% — stale venue?`);
            ok = false;
        }
    } catch (e: any) {
        console.error(`✗ ${e.message}`);
        process.exit(1);
    }
    if (!ok) process.exit(1);
    console.log(`\n✓ layout + canaries verified — safe to pin this pair (HALT_POOLS=${a.toBase58()},${b.toBase58()})`);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
