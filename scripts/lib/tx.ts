// ─────────────────────────────────────────────────────────────────────
// tx.ts — minimal v0 transaction builder (local replacement for the
// Switchboard On-Demand SDK's asV0Tx; Switchboard was removed 2026-09-19).
// Same call shape the keepers already use: { connection, ixs, signers,
// computeUnitPrice?, luts? } with the payer defaulting to signers[0].
// ─────────────────────────────────────────────────────────────────────
import {
    AddressLookupTableAccount,
    ComputeBudgetProgram,
    Connection,
    Keypair,
    TransactionInstruction,
    TransactionMessage,
    VersionedTransaction,
} from "@solana/web3.js";

export async function asV0Tx(opts: {
    connection: Connection;
    ixs: TransactionInstruction[];
    signers: Keypair[];
    payer?: Keypair["publicKey"];
    computeUnitPrice?: number; // micro-lamports per CU
    computeUnitLimit?: number; // absolute CU cap (omit = validator default)
    luts?: AddressLookupTableAccount[];
}): Promise<VersionedTransaction> {
    const { connection, ixs, signers, computeUnitPrice, computeUnitLimit, luts } = opts;
    const payerKey = opts.payer ?? signers[0].publicKey;
    const allIxs: TransactionInstruction[] = [];
    if (computeUnitLimit !== undefined) {
        allIxs.push(ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnitLimit }));
    }
    if (computeUnitPrice !== undefined) {
        allIxs.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: computeUnitPrice }));
    }
    allIxs.push(...ixs);

    const { blockhash } = await connection.getLatestBlockhash("confirmed");
    const message = new TransactionMessage({
        payerKey,
        recentBlockhash: blockhash,
        instructions: allIxs,
    }).compileToV0Message(luts ?? []);
    const tx = new VersionedTransaction(message);
    tx.sign(signers);
    return tx;
}
