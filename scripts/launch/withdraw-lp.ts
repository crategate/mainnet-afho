import * as anchor from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import {
    TOKEN_PROGRAM_ID,
    getAccount,
    getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { readDeploymentState } from "../lib/deployment-state";
import { resolveSolanaConfig } from "../lib/cluster";

// withdraw-lp.ts — recover liquidity from a Raydium CPMM pool back to the
// deployer wallet. Used to reclaim a stale rehearsal pool (e.g. the 2000 USDC
// seeded into an earlier pool before the mint was re-created).
//
//   POOL_ID=4TYcE… npx ts-node scripts/launch/withdraw-lp.ts
//
// Defaults to deployment.raydiumPool. The deployer must own the LP tokens.
// Cluster-aware (2026-09-17): follows `solana config get` like the rest of
// the flow. NOTE: only works while the LP is NOT burned — after burn-lp the
// liquidity is permanently in the pool (that's the point).

async function main() {
    const provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);
    const wallet = provider.wallet as anchor.Wallet;
    const connection = provider.connection;

    const deployment = readDeploymentState();
    const poolIdStr = process.env.POOL_ID || deployment.raydiumPool;
    if (!poolIdStr) {
        throw new Error("No pool ID — set POOL_ID, or run 'anchor run create-pool' first.");
    }
    const poolId = new PublicKey(poolIdStr);

    const { Raydium, TxVersion, Percent, getPdaPoolAuthority, getPdaVault } =
        await import("@raydium-io/raydium-sdk-v2");
    const net = resolveSolanaConfig();
    const raydium = await Raydium.load({
        connection,
        owner: wallet.payer,
        cluster: net.cluster === "mainnet-beta" ? "mainnet" : "devnet",
    });

    // Raw pool (RPC) carries the decoded account fields: mintA/mintB, their
    // token programs, decimals, mintLp, programId, config, reserves.
    const rawPool = raydium.cpmm.getRpcPoolInfos ? (await raydium.cpmm.getRpcPoolInfos([poolId.toBase58()]))[poolId.toBase58()] : undefined;
    if (!rawPool) throw new Error(`pool not found on RPC: ${poolId.toBase58()}`);

    const cpmmProgram = new PublicKey(rawPool.programId.toString());
    const mintA = new PublicKey(rawPool.mintA.toString());
    const mintB = new PublicKey(rawPool.mintB.toString());
    const lpMint = new PublicKey(rawPool.mintLp.toString());

    // Minimal ApiV3PoolInfoStandardItemCpmm — withdrawLiquidity only reads
    // id/programId/mintA/mintB/lpMint (address + programId + extensions.feeConfig).
    const poolInfo = {
        id: poolId.toBase58(),
        programId: cpmmProgram.toBase58(),
        type: "Standard",
        mintA: {
            address: mintA.toBase58(),
            programId: new PublicKey(rawPool.mintProgramA.toString()).toBase58(),
            decimals: rawPool.mintDecimalA,
            extensions: {},
        },
        mintB: {
            address: mintB.toBase58(),
            programId: new PublicKey(rawPool.mintProgramB.toString()).toBase58(),
            decimals: rawPool.mintDecimalB,
            extensions: {},
        },
        lpMint: { address: lpMint.toBase58(), programId: TOKEN_PROGRAM_ID.toBase58() },
        config: {},
    } as never;

    // Pool keys (authority + per-mint vaults) derived the same way launch-bundle.ts does.
    const poolKeys = {
        authority: getPdaPoolAuthority(cpmmProgram).publicKey,
        vault: {
            A: getPdaVault(cpmmProgram, poolId, mintA).publicKey,
            B: getPdaVault(cpmmProgram, poolId, mintB).publicKey,
        },
    };

    const lpAta = getAssociatedTokenAddressSync(lpMint, wallet.publicKey, false, TOKEN_PROGRAM_ID);
    let lpBalance = 0n;
    try {
        lpBalance = (await getAccount(connection, lpAta, "confirmed", TOKEN_PROGRAM_ID)).amount;
    } catch {
        // no LP ATA → nothing to withdraw below
    }

    console.log(` Pool:      ${poolId.toBase58()}`);
    console.log(` LP mint:   ${lpMint.toBase58()}`);
    console.log(` LP holder: ${wallet.publicKey.toBase58()}`);
    console.log(` LP amount: ${lpBalance} (raw)`);

    if (lpBalance === 0n) {
        console.log(" Nothing to withdraw (no LP tokens held by this wallet).");
        return;
    }

    const { execute, extInfo } = await raydium.cpmm.withdrawLiquidity({
        poolInfo,
        poolKeys: poolKeys as never,
        lpAmount: new anchor.BN(lpBalance.toString()),
        slippage: new Percent(1, 100), // 1%
        txVersion: TxVersion.V0,
    });

    console.log(" Amount A (token0) to receive:", (extInfo as any)?.amountA?.toString?.() ?? "(n/a)");
    console.log(" Amount B (token1) to receive:", (extInfo as any)?.amountB?.toString?.() ?? "(n/a)");



    const { txId } = await execute({ sendAndConfirm: true });
    console.log(` Liquidity withdrawn! Tx: ${txId}`);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
