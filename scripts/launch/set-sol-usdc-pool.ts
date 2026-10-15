import "dotenv/config";
import * as anchor from "@coral-xyz/anchor";
import * as fs from "fs";
import * as path from "path";
import {
    PublicKey,
    SystemProgram,
    Transaction,
    sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
    TOKEN_PROGRAM_ID,
    getAssociatedTokenAddressSync,
    createAssociatedTokenAccountInstruction,
    createSyncNativeInstruction,
    getMinimumBalanceForRentExemptAccount,
} from "@solana/spl-token";
import { writeDeploymentState } from "../lib/deployment-state";
import { resolveSolanaConfig } from "../lib/cluster";
import { usdcMintFor } from "../lib/cpmm";

// Pins the Raydium SOL/USDC CPMM pool used by offer_claim_sol to convert SOL
// bond payments to USDC, and by bounty_top_up to convert USDC back to SOL.
//
// Resolution order:
//   1. DEVNET_SOL_USDC_POOL / DEVNET_SOL_USDC_CONFIG env vars (historical
//      names — they are the MAINNET override path: point them at the
//      canonical Raydium SOL/USDC pool before the mainnet launch).
//   2. raydiumSolUsdcPool / raydiumSolUsdcConfig already in deployment.json.
//   3. DEVNET-ONLY fallback: create our own SOL/USDC CPMM pool, seeded at the
//      same 200 USDC/SOL rate, so the claim's min-out math lines up. Seed
//      amounts: SOL_USDC_SEED_SOL / SOL_USDC_SEED_USDC env vars (defaults
//      3 SOL / 600 USDC — for bigger test claims seed a bigger pool).
//
// MAINNET NEVER auto-creates (2026-09-17 hard guard): the mainnet pin must be
// the canonical deep pool with creator fee DISABLED (feeOn = 0 — else the
// 25bps claim/top-up solve is wrong, MAINNET_CHECKLIST §5), supplied via the
// env vars or deployment.json. The canonical pool must contain the SAME USDC
// the rest of the protocol uses — verified below against usdcMintFor().
export async function setSolUsdcPool(): Promise<void> {
    const provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);
    const wallet = provider.wallet as anchor.Wallet;
    const connection = provider.connection;
    const net = resolveSolanaConfig();
    const isMainnet = net.cluster === "mainnet-beta";

    const deployment = JSON.parse(
        fs.readFileSync(path.join(process.cwd(), "app", "public", "deployment.json"), "utf-8")
    );

    let poolStateKey = process.env.DEVNET_SOL_USDC_POOL || deployment.raydiumSolUsdcPool;
    let ammConfigKey = process.env.DEVNET_SOL_USDC_CONFIG || deployment.raydiumSolUsdcConfig;

    if (isMainnet && (!poolStateKey || !ammConfigKey)) {
        console.error("✗ MAINNET: no SOL/USDC pool configured — refusing to run.");
        console.error("  The mainnet pin MUST be the canonical Raydium wSOL/USDC CPMM pool with");
        console.error("  creator fee DISABLED (feeOn = 0). Set it explicitly:");
        console.error("    DEVNET_SOL_USDC_POOL=<canonical pool> DEVNET_SOL_USDC_CONFIG=<its config> \\");
        console.error("      anchor run set-sol-usdc-pool");
        console.error("  (historical env names — they are the mainnet override path). Never let a");
        console.error("  script auto-create the mainnet SOL/USDC side: a thin self-made pool would");
        console.error("  skew every SOL claim price and bounty payout.");
        process.exit(1);
    }

    // ── Devnet fallback: find-or-create our own SOL/USDC pool ──────────────
    if (!poolStateKey || !ammConfigKey) {
        console.log(" No SOL/USDC pool configured — looking for an existing devnet SOL/USDC CPMM pool…");
        const { Raydium, TxVersion, DEVNET_PROGRAM_ID, getCreatePoolKeys } =
            await import("@raydium-io/raydium-sdk-v2");
        const raydium = await Raydium.load({ connection, owner: wallet.payer, cluster: "devnet" });

        const feeConfigs = await raydium.api.getCpmmConfigs();
        const feeConfigs2500 = feeConfigs.filter((c) => c.tradeFeeRate === 2500);
        if (feeConfigs2500.length === 0) throw new Error("No 0.25% CPMM fee config on devnet");

        // Mints in the same sorted order the CPMM program derives pool PDAs in.
        const [mintA, mintB] =
            Buffer.compare(WSOL_MINT.toBuffer(), USDC_MINT.toBuffer()) <= 0
                ? [WSOL_MINT, USDC_MINT]
                : [USDC_MINT, WSOL_MINT];

        // Reuse a pool if one already exists for a 0.25% config. A previous
        // run can create the pool but die before recording it in
        // deployment.json — re-creating then fails inside the CPMM initialize
        // with "Allocate: account already in use" on the LP-mint PDA.
        for (const config of feeConfigs2500) {
            const keys = getCreatePoolKeys({
                programId: DEVNET_PROGRAM_ID.CREATE_CPMM_POOL_PROGRAM,
                configId: new PublicKey(config.id),
                mintA,
                mintB,
            });
            if (await connection.getAccountInfo(keys.poolId)) {
                poolStateKey = keys.poolId.toBase58();
                ammConfigKey = config.id;
                console.log(`    Reusing existing SOL/USDC pool: ${poolStateKey} (config ${ammConfigKey})`);
                writeDeploymentState({
                    raydiumSolUsdcPool: poolStateKey,
                    raydiumSolUsdcConfig: ammConfigKey,
                });
                break;
            }
            if (await connection.getAccountInfo(keys.lpMint)) {
                throw new Error(
                    `SOL/USDC LP mint ${keys.lpMint.toBase58()} exists but pool state ` +
                    `${keys.poolId.toBase58()} does not — a previous createPool died mid-flight. ` +
                    `Set DEVNET_SOL_USDC_POOL to an existing pool or clean up the half-created accounts.`
                );
            }
        }

        if (!poolStateKey || !ammConfigKey) {
            console.log("   No existing pool — creating a devnet SOL/USDC CPMM pool…");
            const feeConfig = feeConfigs2500[0];

            // ── Wrap SOL → wSOL (pool legs must be SPL tokens) ──────────────
            const wsolAta = getAssociatedTokenAddressSync(WSOL_MINT, wallet.publicKey, false);
            if (!(await connection.getAccountInfo(wsolAta))) {
                const createIx = createAssociatedTokenAccountInstruction(
                    wallet.publicKey,
                    wsolAta,
                    wallet.publicKey,
                    WSOL_MINT,
                    TOKEN_PROGRAM_ID
                );
                const tx = new Transaction().add(createIx);
                tx.feePayer = wallet.publicKey;
                tx.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
                await sendAndConfirmTransaction(connection, tx, [wallet.payer], { skipPreflight: true });
                console.log(`   wSOL ATA created: ${wsolAta.toBase58()}`);
            }
            const rentExempt = await getMinimumBalanceForRentExemptAccount(connection);
            const wrapLamports = Math.round(seedSol * 1e9) + rentExempt;
            const wrapTx = new Transaction().add(
                SystemProgram.transfer({
                    fromPubkey: wallet.publicKey,
                    toPubkey: wsolAta,
                    lamports: wrapLamports,
                }),
                createSyncNativeInstruction(wsolAta, TOKEN_PROGRAM_ID)
            );
            wrapTx.feePayer = wallet.publicKey;
            wrapTx.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
            await sendAndConfirmTransaction(connection, wrapTx, [wallet.payer], { skipPreflight: true });
            console.log(`   Wrapped ${seedSol} SOL → wSOL`);

            const getToken = async (mintKey: PublicKey, programId: string) => {
                const parsed = await connection.getParsedAccountInfo(mintKey);
                const info = (parsed.value!.data as { parsed: { info: { decimals: number } } }).parsed.info;
                return { address: mintKey.toBase58(), decimals: info.decimals, programId };
            };
            const wsolInfo = await getToken(WSOL_MINT, TOKEN_PROGRAM_ID.toBase58());
            const usdcInfo = await getToken(USDC_MINT, TOKEN_PROGRAM_ID.toBase58());

            const { execute, extInfo } = await raydium.cpmm.createPool({
                programId: DEVNET_PROGRAM_ID.CREATE_CPMM_POOL_PROGRAM,
                poolFeeAccount: DEVNET_PROGRAM_ID.CREATE_CPMM_POOL_FEE_ACC,
                mintA: wsolInfo,
                mintB: usdcInfo,
                mintAAmount: new anchor.BN(Math.round(seedSol * 1e9)),
                mintBAmount: new anchor.BN(Math.round(seedUsdc * 1_000_000)),
                startTime: new anchor.BN(0),
                feeConfig,
                associatedOnly: false,
                ownerInfo: { useSOLBalance: true },
                txVersion: TxVersion.V0,
            });
            const { txId } = await execute({ sendAndConfirm: true });
            poolStateKey = extInfo.address.poolId.toBase58();
            ammConfigKey = extInfo.address.configId.toBase58();
            console.log(`   SOL/USDC pool created: ${poolStateKey} (tx ${txId})`);
            console.log(`    Seeded ${seedSol} SOL : ${seedUsdc} USDC (~${SEED_RATE_USDC_PER_SOL} USDC/SOL — devnet seed rate)`);
            writeDeploymentState({
                raydiumSolUsdcPool: poolStateKey,
                raydiumSolUsdcConfig: ammConfigKey,
            });
        }
    }

    const poolState = new PublicKey(poolStateKey!);
    const ammConfig = new PublicKey(ammConfigKey!);

    // ── Pin-time preflight: the pool must actually contain wSOL + THIS
    // cluster's USDC. Catches the 4zMMC/USDCoct mix-up (AGENTS.md gotcha)
    // at pin time instead of as a mispriced claim/bounty later. CPMM pool
    // state layout: token_0 @ offset 168, token_1 @ offset 200.
    {
        const poolAcct = await connection.getAccountInfo(poolState, "confirmed");
        if (!poolAcct) throw new Error(`pool state ${poolState.toBase58()} not found on ${net.cluster}`);
        const t0 = new PublicKey(poolAcct.data.slice(168, 200));
        const t1 = new PublicKey(poolAcct.data.slice(200, 232));
        const ok =
            (t0.equals(WSOL_MINT) && t1.equals(USDC_MINT)) ||
            (t0.equals(USDC_MINT) && t1.equals(WSOL_MINT));
        if (!ok) {
            console.error(`✗ pool ${poolState.toBase58()} holds ${t0.toBase58()} / ${t1.toBase58()}`);
            console.error(`  expected wSOL + USDC ${USDC_MINT.toBase58()} (cluster ${net.cluster}).`);
            console.error(`  Wrong-pair pin = broken offer_claim_sol + bounty pricing (the 4zMMC trap).`);
            process.exit(1);
        }
        console.log(`✓ pool pair verified: wSOL / USDC(${USDC_MINT.toBase58().slice(0, 6)}…)`);
    }

    // ── Pin into the AMM state ─────────────────────────────────────────────
    const idlPath = path.join(process.cwd(), "target", "idl", "amm.json");
    const idl = JSON.parse(fs.readFileSync(idlPath, "utf-8"));
    const program = new anchor.Program(idl, provider);
    const mint = new PublicKey(deployment.mint);

    const [ammStatePda] = PublicKey.findProgramAddressSync(
        [Buffer.from("amm_state"), mint.toBuffer()],
        program.programId
    );

    const tx = await program.methods
        .setSolUsdcPool(poolState, ammConfig)
        .accounts({
            cranker: provider.wallet.publicKey,
            ammState: ammStatePda,
            // Pin-time ownership proof: the pool account itself (must be
            // Raydium cp-swap owned).
            poolStateAcc: poolState,
        })
        .rpc();
    console.log(` SOL/USDC pool pinned: ${poolState.toBase58()} (tx ${tx})`);
}

const WSOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");
// USDC follows `solana config get` via the shared per-cluster table
// (USDC_MINT env wins for one-off overrides). This is the mint the fallback
// pool creation seeds AND the mint the pinned-pool preflight validates.
const USDC_MINT = usdcMintFor(
    resolveSolanaConfig().cluster,
    process.env.USDC_MINT || process.env.DEVNET_USDC_MINT || undefined
);

// 200 USDC/SOL — the devnet seed rate
// (200_000_000_000 = 200 × 1e9 floor units). MAINNET: this only affects the
// fallback pool creation, which should never run on mainnet (env vars are
// used instead).
const SEED_RATE_USDC_PER_SOL = 200;

const seedSol = parseFloat(process.env.SOL_USDC_SEED_SOL || "03");
const seedUsdc = parseFloat(process.env.SOL_USDC_SEED_USDC || "600");

async function main() {
    await setSolUsdcPool();
}

if (require.main === module) {
    main().catch((err) => {
        console.error(err);
        process.exit(1);
    });
}
