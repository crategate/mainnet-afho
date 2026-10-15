import * as anchor from "@coral-xyz/anchor";
import * as fs from "fs";
import * as path from "path";
import {
    AddressLookupTableProgram, Connection, PublicKey, Transaction,
    sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
    TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { writeDeploymentState } from "../lib/deployment-state";

// Creates (or extends) the buyer-side Address Lookup Table used by SOL bond
// claims (offer_claim_sol), then records it in deployment.json as
// `claimLookupTable`.
//
// WHY: the legacy SOL claim transaction is ~1213 bytes — 19 bytes under the
// 1232-byte packet limit — so it cannot carry a compute-budget instruction
// and runs on the 200k CU default while consuming 141-166k. Wallet sims sit
// right at that edge (Phantom shows a failed simulation, then the retry
// lands). Moving the 29 static accounts into an ALT frees ~450 bytes,
// letting the app send a v0 transaction with setComputeUnitLimit(400_000)
// and huge headroom. See useOfferClaim.ts (SOL branch).
//
// USAGE: anchor run create-claim-alt  (or just `anchor run set-pools`,
// which runs it after the pool pins)
// Re-run after set-cpmm-pool / set-sol-usdc-pool WHEN THE POOL ADDRESSES
// CHANGE (a new pool = new state/vault/observation/config keys — the script
// extends the table in place; ALTs are append-only). Re-pinning the SAME
// pool, or redeploying the amm program, is a no-op here. Returns the ALT
// address; exported for `anchor run set-pools`.
export async function ensureClaimAlt(): Promise<string> {
    const provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);
    const wallet = provider.wallet as anchor.Wallet;
    const connection = provider.connection;

    const deployment = JSON.parse(
        fs.readFileSync(path.join(process.cwd(), "app", "public", "deployment.json"), "utf-8")
    );
    const mint = new PublicKey(deployment.mint);
    const ammProgram = new PublicKey(deployment.ammProgram);
    const stakingProgram = new PublicKey(deployment.stakingProgram);

    // ── Recompute the SOL claim's static account set from live state ──────
    const idl = JSON.parse(fs.readFileSync(path.join(process.cwd(), "target", "idl", "amm.json"), "utf-8"));
    const program = new anchor.Program(idl, provider);
    const [ammStatePda] = PublicKey.findProgramAddressSync(
        [Buffer.from("amm_state"), mint.toBuffer()], ammProgram
    );
    const amm = await (program.account as any).ammState.fetch(ammStatePda);
    const usdcMint = (amm as unknown as { usdcMint: PublicKey }).usdcMint;
    const crankProgram = new PublicKey(deployment.crankProgram);
    const [marketStatus] = PublicKey.findProgramAddressSync(
        [Buffer.from("market_status")], crankProgram
    );
    const [stakingPool] = PublicKey.findProgramAddressSync(
        [Buffer.from("pool"), mint.toBuffer()], stakingProgram
    );
    const [stakingVault] = PublicKey.findProgramAddressSync(
        [Buffer.from("vault"), stakingPool.toBuffer()], stakingProgram
    );
    const field = (o: unknown, ...names: string[]): PublicKey => {
        const rec = o as Record<string, unknown>;
        for (const n of names) {
            const v = rec?.[n];
            if (v instanceof PublicKey) return v;
        }
        throw new Error(`amm_state missing ${names[0]}`);
    };
    const ammRec = amm as unknown as Record<string, unknown>;
    const cpmmProgram = field(ammRec, "cpmmProgram", "cpmm_program");
    const cpmmPoolState = field(ammRec, "cpmmPoolState", "cpmm_pool_state");
    const cpmmSolUsdcPool = field(ammRec, "cpmmSolUsdcPool", "cpmm_sol_usdc_pool");
    const cpmmSolUsdcConfig = field(ammRec, "cpmmSolUsdcConfig", "cpmm_sol_usdc_config");
    const poolVault = (pool: PublicKey, m: PublicKey) => PublicKey.findProgramAddressSync(
        [Buffer.from("pool_vault"), pool.toBuffer(), m.toBuffer()], cpmmProgram
    )[0];
    const [cpmmObservation] = PublicKey.findProgramAddressSync(
        [Buffer.from("observation"), cpmmPoolState.toBuffer()], cpmmProgram
    );
    const [solUsdcObservation] = PublicKey.findProgramAddressSync(
        [Buffer.from("observation"), cpmmSolUsdcPool.toBuffer()], cpmmProgram
    );
    const [solUsdcAuthority] = PublicKey.findProgramAddressSync(
        [Buffer.from("vault_and_lp_mint_auth_seed")], cpmmProgram
    );
    const wsolVault = getAssociatedTokenAddressSync(WSOL_MINT, ammStatePda, true, TOKEN_PROGRAM_ID);

    const staticKeys: PublicKey[] = [
        ammStatePda,
        PublicKey.findProgramAddressSync([Buffer.from("offer_list"), mint.toBuffer()], ammProgram)[0],
        mint,
        usdcMint,
        marketStatus,
        field(ammRec, "usdcVault", "usdc_vault"),
        field(ammRec, "usdcDip", "usdc_dip"),
        field(ammRec, "usdcRewards", "usdc_rewards"),
        wsolVault,
        WSOL_MINT,
        cpmmSolUsdcPool,
        cpmmSolUsdcConfig,
        poolVault(cpmmSolUsdcPool, WSOL_MINT),
        poolVault(cpmmSolUsdcPool, usdcMint),
        solUsdcObservation,
        solUsdcAuthority,
        stakingProgram,
        stakingPool,
        field(ammRec, "afhoVault", "afho_vault"),
        stakingVault,
        ASSOCIATED_TOKEN_PROGRAM_ID,
        TOKEN_PROGRAM_ID,
        TOKEN_2022_PROGRAM_ID,
        anchor.web3.SystemProgram.programId,
        cpmmPoolState,
        cpmmObservation,
        poolVault(cpmmPoolState, usdcMint),
        poolVault(cpmmPoolState, mint),
        cpmmProgram,
    ];

    if (new Set(staticKeys.map((k) => k.toBase58())).size !== staticKeys.length) {
        throw new Error("Duplicate keys in the claim account set");
    }
    if (staticKeys.length > 250) throw new Error("Account set exceeds ALT capacity");

    // ── Find or create the ALT ────────────────────────────────────────────
    const existing = deployment.claimLookupTable
        ? await connection.getAddressLookupTable(new PublicKey(deployment.claimLookupTable))
        : null;

    let altKey: PublicKey;
    if (existing && existing.value) {
        altKey = existing.value.key;
        const known = new Set(existing.value.state.addresses.map((k) => k.toBase58()));
        const missing = staticKeys.filter((k) => !known.has(k.toBase58()));
        if (missing.length === 0) {
            console.log(`ALT ${altKey.toBase58()} already up to date (${known.size} keys).`);
            return;
        }
        if (existing.value.state.addresses.length + missing.length > 256) {
            throw new Error("ALT is full — create a fresh one (clear claimLookupTable in deployment.json).");
        }
        console.log(`Extending ALT ${altKey.toBase58()} with ${missing.length} new key(s)…`);
        const ix = AddressLookupTableProgram.extendLookupTable({
            payer: wallet.publicKey,
            lookupTable: altKey,
            authority: wallet.publicKey,
            addresses: missing,
        });
        const tx = new Transaction().add(ix);
        tx.feePayer = wallet.publicKey;
        tx.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
        await sendAndConfirmTransaction(connection, tx, [wallet.payer], { skipPreflight: true });
    } else {
        console.log("Creating a new claim lookup table…");
        const slot = await connection.getSlot("confirmed");
        const [createIx, alt] = AddressLookupTableProgram.createLookupTable({
            authority: wallet.publicKey,
            payer: wallet.publicKey,
            recentSlot: slot,
        });
        altKey = alt;
        // Transaction 1: create (the ALT derives from a recent blockhash and
        // activates after one slot). Transaction 2: extend with the full
        // claim account set — 29 keys × 32B ≈ 950 bytes, fits the packet.
        const tx = new Transaction().add(createIx);
        tx.feePayer = wallet.publicKey;
        tx.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
        await sendAndConfirmTransaction(connection, tx, [wallet.payer], { skipPreflight: true });
        const extendTx = new Transaction().add(
            AddressLookupTableProgram.extendLookupTable({
                payer: wallet.publicKey,
                lookupTable: altKey,
                authority: wallet.publicKey,
                addresses: staticKeys,
            }),
        );
        extendTx.feePayer = wallet.publicKey;
        extendTx.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
        await sendAndConfirmTransaction(connection, extendTx, [wallet.payer], { skipPreflight: true });
        // Newly extended keys need the slot to finalize before a v0 message
        // can reference them (the app's legacy fallback covers the gap).
        await new Promise((r) => setTimeout(r, 5_000));
    }

    // The ALT activation slot must pass before v0 messages can reference it.
    await new Promise((r) => setTimeout(r, 5_000));
    const final = await connection.getAddressLookupTable(altKey);
    console.log(
        `ALT ${altKey.toBase58()} holds ${final.value?.state.addresses.length ?? "?"} keys ` +
        `(claim set needs ${staticKeys.length}).`
    );
    writeDeploymentState({ claimLookupTable: altKey.toBase58() });
    return altKey.toBase58();
}

const WSOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");

if (require.main === module) {
    ensureClaimAlt().catch((err) => {
        console.error(err);
        process.exit(1);
    });
}
