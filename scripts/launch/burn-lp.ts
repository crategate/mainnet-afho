import * as anchor from "@coral-xyz/anchor";
import { PublicKey, Transaction } from "@solana/web3.js";
import {
    TOKEN_PROGRAM_ID,
    getAccount,
    getAssociatedTokenAddressSync,
    createBurnInstruction,
} from "@solana/spl-token";
import { readDeploymentState } from "../lib/deployment-state";

// burn-lp.ts — final launch step: burn 100% of the CPMM LP tokens held by the
// deployer wallet, making the pool's liquidity permanently unwithdrawable
// (MAINNET_CHECKLIST §5 burn-all vs cpmm.lockLiquidity — burning refunds
// NOTHING: both legs stay in the pool forever; new liquidity can still be
// ADDED later via deposits, which mints fresh LP — burn that too).
//
// EXECUTES BY DEFAULT (2026-09-17 decision: LP burn is the standard launch
// behavior on devnet AND mainnet — an unburned manual-pool LP shows as
// "Burnt: 0%" on every screener, a first-order rug signal). DRY_RUN=1 to
// preview without sending. `anchor run launch` runs this automatically;
// SKIP_BURN=1 at the launch level removes the step (Phase-0 rehearsal only).
//
// NEVER burn during the Phase-0 mainnet rehearsal — unburned LP keeps the
// rehearsal recoverable (both legs refundable while upgradeable; see
// MAINNET_CHECKLIST Phase 0). Burn only once the pool is at its final size
// (top up via addLiquidity BEFORE burning).
async function main() {
    const provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);
    const wallet = provider.wallet as anchor.Wallet;
    const connection = provider.connection;

    const deployment = readDeploymentState();
    const lpMintStr = process.env.RAYDIUM_LP_MINT || deployment.raydiumLpMint;
    if (!lpMintStr) {
        throw new Error(
            "LP mint not found (raydiumLpMint missing from deployment.json). " +
            "Run 'anchor run create-pool' first, or set RAYDIUM_LP_MINT."
        );
    }
    const lpMint = new PublicKey(lpMintStr);

    const lpAta = getAssociatedTokenAddressSync(lpMint, wallet.publicKey, false, TOKEN_PROGRAM_ID);
    let lpBalance = 0n;
    try {
        lpBalance = (await getAccount(connection, lpAta, "confirmed", TOKEN_PROGRAM_ID)).amount;
    } catch {
        // ATA missing → nothing to burn below.
    }

    console.log(` Pool:      ${deployment.raydiumPool ?? "(unknown)"}`);
    console.log(` LP mint:   ${lpMint.toBase58()}`);
    console.log(` LP holder: ${wallet.publicKey.toBase58()}`);
    console.log(` LP amount: ${lpBalance} (raw)`);

    if (lpBalance === 0n) {
        console.log(" Nothing to burn (already burned, or LP is held elsewhere).");
        return;
    }

    if (process.env.DRY_RUN === "1") {
        console.log(
            "\n Dry run (DRY_RUN=1) — nothing burned. Run without it to burn permanently " +
            "(IRREVERSIBLE: both pool legs become unwithdrawable forever)."
        );
        return;
    }
    console.log("\n Burning LP (default behavior — DRY_RUN=1 to preview instead)…");

    const burnTx = new Transaction().add(
        createBurnInstruction(lpAta, lpMint, wallet.publicKey, lpBalance, [], TOKEN_PROGRAM_ID)
    );
    const { blockhash } = await connection.getLatestBlockhash("confirmed");
    burnTx.recentBlockhash = blockhash;
    burnTx.feePayer = wallet.publicKey;
    const sig = await provider.sendAndConfirm(burnTx);
    console.log(` LP burned! Tx: ${sig}`);
    const after = await getAccount(connection, lpAta, "confirmed", TOKEN_PROGRAM_ID);
    console.log(` LP remaining in ATA: ${after.amount}`);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
