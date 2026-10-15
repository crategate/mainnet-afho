import "dotenv/config";
import * as anchor from "@coral-xyz/anchor";
import * as fs from "fs";
import * as path from "path";
import BN from "bn.js";
import {
    ComputeBudgetProgram,
    Keypair,
    PublicKey,
    SystemProgram,
    Transaction,
    VersionedTransaction,
} from "@solana/web3.js";
import {
    TOKEN_2022_PROGRAM_ID,
    TOKEN_PROGRAM_ID,
    createAssociatedTokenAccountIdempotentInstruction,
    getAccount,
    getAssociatedTokenAddressSync,
    getMint,
} from "@solana/spl-token";
import { readDeploymentState, writeDeploymentState, pubkey } from "../lib/deployment-state";
import { resolveSolanaConfig } from "../lib/cluster";
import { usdcMintFor } from "../lib/cpmm";
import { bs58Decode, bs58Encode, getBundleStatuses, getTipAccounts, sendBundle } from "../lib/jito";

// launch-bundle.ts — THE atomic launch step (replaces create-pool + the
// retired VPS buyer): pool creation, the 3% dev buy, and the stake lots land
// as ONE unit.
//
//   mainnet:  one Jito bundle  [create CPMM pool + initial deposit
//                                 → buy wallet buys 3% at the open price
//                                 → buy wallet stakes HALF in 5M lots
//                                 → buy wallet freezes those lots
//                                 → tip]                       (all-or-nothing)
//   devnet:   the same transactions, sent sequentially (no Jito on devnet —
//             the devnet path exists so the exact tx set is testable e2e).
//
// Bundling is also the optics call: a same-block creator-linked buy reads as
// "dev bought 3% at launch" on screeners, the bundle guarantees the open
// price (nobody in front of the creator inside the creation block), and it
// removes the watcher-bot failure classes (open_time race, confirm-poll
// false success) that burned the 09-25 launch.
//
// All sizing is FINALIZED except USDC_TO_LP (the one launch knob, .env):
//   pool seed     200M AFHO (20% of the 1B supply) : USDC_TO_LP USDC
//   buy           0.18 × USDC_TO_LP USDC  → ≥30M AFHO (3% of supply; 0.18
//                 solves 15% of the pool's AFHO side on the constant-product
//                 curve with ~2% fee/impact headroom)
//   frozen half   15M AFHO staked as 3 × 5M positions (indices 0–2, staked
//                 with days=0) and frozen FREEZE_DAYS trading days in the
//                 same tx — the freeze IS the lock (unstake opens the first
//                 trading day after it ends), and it fixes the bonus weight
//                 rate from the day-0 card (fresh metrics read momentum 0 =
//                 full-bear regime; per-lot popularity scaling trims lots
//                 1–2 a few hundred bps — on-chain, verifiable, symmetric).
//   liquid half   ~15M AFHO (the rest of the buy) stays liquid in the buy
//                 wallet, unstaked — disclosed in the litepaper allocation.
//
// FREEZE IS OPEN-SESSION-ONLY: the staking program rejects freeze unless the
// market state is OPEN (0), so this bundle must run inside NYSE hours (and
// not within a minute of a bell flip). A preflight below hard-fails early
// with nothing sent. Launching at the opening bell is also the thematically
// correct move for this token. Fallback if an off-hours launch is ever
// needed: stake the frozen half with days=21 instead (edit LOT_STAKE_DAYS),
// drop the freeze ixs, and freeze from the app UI once vested at day 21.
//
// Wallets (exactly two):
//   launch wallet   Anchor.toml [provider].wallet / `solana config get` —
//                   pays pool creation + rents + the Jito tip, seeds the pool
//   buy wallet      BUYER_WALLET_KEY (.env, base58 secret or JSON byte array)
//                   — funded by beforehand, signs ONLY the buy + stake txs
//
// Preflight hard-fails (balance math BEFORE anything is sent):
//   launch wallet: USDC ≥ USDC_TO_LP, SOL ≥ fees + tip + pool rents
//   buy wallet:    USDC ≥ 0.18 × USDC_TO_LP, SOL ≥ fees + 7 account rents
//
// Re-run safety: on mainnet the bundle is atomic — a dropped bundle means
// NOTHING landed and a re-run is safe. If the pool already exists (partial
// devnet run, or an old manual create-pool), the script refuses and explains.

// ── FINALIZED constants (never launch config — see header) ──────────────────
const AFHO_TO_LP_WHOLE = 200_000_000;     // 20% of the 1B supply
const BUY_RATIO_NUM = 18;                 // buy USDC = USDC_TO_LP × 18/100
const BUY_RATIO_DEN = 100;
const BUY_TARGET_WHOLE = 30_000_000;      // 3% of supply = the min-out floor
const STAKE_LOT_WHOLE = 5_000_000;        // 5M AFHO per StakePosition
const LOT_COUNT = 3;                      // HALF the buy is staked+frozen (indices 0–2)
const LOT_STAKE_DAYS = 0;                 // vested on arrival — the freeze is the lock
const FREEZE_DAYS = 21;                   // trading days the frozen half locks (≈ the old 21d lock horizon)
const DEFAULT_TIP_SOL = 0.01;             // Jito tip (JITO_TIP_SOL overrides)
const BUNDLE_CONFIRM_TIMEOUT_MS = 90_000; // block-engine landing window

const LAMPORTS_PER_SOL = 1_000_000_000;

function buyWalletFromEnv(): Keypair {
    const raw = (process.env.BUYER_WALLET_KEY || "").trim();
    if (!raw) {
        throw new Error(
            "BUYER_WALLET_KEY is not set. Put the buy wallet's secret in .env " +
            "(base58 string from `solana-keygen grind/export`, or the JSON byte array)."
        );
    }
    try {
        const bytes = raw.startsWith("[") ? new Uint8Array(JSON.parse(raw)) : bs58Decode(raw);
        return Keypair.fromSecretKey(bytes);
    } catch (e) {
        throw new Error(`BUYER_WALLET_KEY could not be parsed: ${e instanceof Error ? e.message : e}`);
    }
}

async function main() {
    const provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);
    const wallet = provider.wallet as anchor.Wallet;
    const launchWallet = wallet.payer;
    const connection = provider.connection;

    const net = resolveSolanaConfig();
    const isMainnet = net.cluster === "mainnet-beta";
    const USDC_MINT = usdcMintFor(net.cluster, process.env.USDC_MINT);
    const usdcMintInfo = await getMint(connection, USDC_MINT, "confirmed", TOKEN_PROGRAM_ID);
    const USDC_DECIMALS = usdcMintInfo.decimals;
    const USDC_TO_LP = Number(process.env.USDC_TO_LP || 2000);
    if (!Number.isInteger(USDC_TO_LP) || USDC_TO_LP <= 0) throw new Error(`bad USDC_TO_LP=${process.env.USDC_TO_LP}`);

    const buyUsdcWhole = Math.ceil((USDC_TO_LP * BUY_RATIO_NUM) / BUY_RATIO_DEN);
    const buyUsdcRaw = BigInt(buyUsdcWhole) * 1_000_000n;
    const tipSol = Number(process.env.JITO_TIP_SOL || DEFAULT_TIP_SOL);
    if (!(tipSol > 0)) throw new Error(`bad JITO_TIP_SOL=${process.env.JITO_TIP_SOL}`);

    // ── 1. The two wallets ──
    const buyWallet = buyWalletFromEnv();
    console.log(`[${net.cluster}] launch wallet: ${launchWallet.publicKey.toBase58()}`);
    console.log(`[${net.cluster}] buy wallet:    ${buyWallet.publicKey.toBase58()} (BUYER_WALLET_KEY)`);

    // ── 2. Mint + fund-launch state (must be complete) ──
    const mintKeypairPath = path.join(process.cwd(), "target", "deploy", "afho_token-keypair.json");
    if (!fs.existsSync(mintKeypairPath)) throw new Error("afho_token-keypair.json not found. Run 'anchor run prep' first.");
    const AFHO_MINT = Keypair.fromSecretKey(
        new Uint8Array(JSON.parse(fs.readFileSync(mintKeypairPath, "utf8")))
    ).publicKey;
    const mintInfo = await getMint(connection, AFHO_MINT, "confirmed", TOKEN_2022_PROGRAM_ID);
    const decimals = mintInfo.decimals;
    const rawPerWhole = 10n ** BigInt(decimals);

    const seedAta = getAssociatedTokenAddressSync(AFHO_MINT, launchWallet.publicKey, false, TOKEN_2022_PROGRAM_ID);
    const seedBal = (await getAccount(connection, seedAta, "confirmed", TOKEN_2022_PROGRAM_ID)).amount;
    if (mintInfo.supply !== BigInt(1_000_000_000) * rawPerWhole)
        throw new Error(`mint supply is ${mintInfo.supply} raw — run 'anchor run fund-launch' first.`);
    if (mintInfo.mintAuthority !== null)
        throw new Error("mint authority not revoked yet — run 'anchor run fund-launch' first.");
    if (seedBal < BigInt(AFHO_TO_LP_WHOLE) * rawPerWhole)
        throw new Error(`seed ATA holds ${seedBal} raw AFHO, need ${AFHO_TO_LP_WHOLE} whole — run 'anchor run fund-launch' first.`);

    const minOutRaw = BigInt(BUY_TARGET_WHOLE) * rawPerWhole;           // 30M floor (3 lots + liquid half)
    const lotRaw = BigInt(STAKE_LOT_WHOLE) * rawPerWhole;               // 5M per position
    if (BigInt(LOT_COUNT) * lotRaw > minOutRaw) throw new Error("internal: stake lots exceed the buy floor");

    // ── 3. Staking pool (amm-init must have run; stake targets its accounts) ──
    const deployment = readDeploymentState();
    if (!deployment.marketStatus) throw new Error("marketStatus missing from deployment.json — run 'anchor run amm-init' first.");
    const MARKET_STATUS = new PublicKey(deployment.marketStatus);
    const stakingIdlPath = path.join(process.cwd(), "target", "idl", "staking.json");
    if (!fs.existsSync(stakingIdlPath)) throw new Error("staking.json IDL not found. Run 'anchor build' first.");
    const stakingProgram = new anchor.Program(
        JSON.parse(fs.readFileSync(stakingIdlPath, "utf-8")), provider
    );
    const STAKING_PROGRAM_ID = stakingProgram.programId;
    const [stakingPoolPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("pool"), AFHO_MINT.toBuffer()], STAKING_PROGRAM_ID
    );
    const [stakingVaultPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("vault"), stakingPoolPda.toBuffer()], STAKING_PROGRAM_ID
    );
    const [userIndexPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("user_index"), buyWallet.publicKey.toBuffer()], STAKING_PROGRAM_ID
    );
    const stakePool = await (stakingProgram.account as any).stakePool.fetchNullable(stakingPoolPda);
    if (!stakePool) throw new Error(`staking pool ${stakingPoolPda.toBase58()} not found — run 'anchor run amm-init' first.`);
    if (!new PublicKey(stakePool.marketStatusPda).equals(MARKET_STATUS))
        throw new Error(
            `staking pool pins market status ${stakePool.marketStatusPda.toBase58()} but deployment.json says ` +
            `${MARKET_STATUS.toBase58()} — stale deployment.json, fix before launching.`
        );
    const existingIndex = await (stakingProgram.account as any).userStakeIndex.fetchNullable(userIndexPda);
    if (existingIndex && existingIndex.nextIndex.toNumber() > 0)
        throw new Error(
            `buy wallet already has ${existingIndex.nextIndex} stake position(s) — use a FRESH buy wallet ` +
            `for the launch (the 3% must land as positions 0–${LOT_COUNT - 1} for the disclosure copy).`
        );

    // The freeze legs below are open-session-only: hard-fail HERE, with
    // nothing sent, unless the market state reads OPEN (0). Launch inside
    // NYSE hours, clear of the bell-flip minutes.
    const crankIdlPath = path.join(process.cwd(), "target", "idl", "crank_oracle.json");
    if (!fs.existsSync(crankIdlPath)) throw new Error("crank_oracle.json IDL not found. Run 'anchor build' first.");
    const crankProgram = new anchor.Program(JSON.parse(fs.readFileSync(crankIdlPath, "utf-8")), provider);
    const marketStatusAcct = await (crankProgram.account as any).marketStatus.fetchNullable(MARKET_STATUS);
    if (!marketStatusAcct) throw new Error(`marketStatus ${MARKET_STATUS.toBase58()} not found — run 'anchor run init' first.`);
    const sessionState = Number(marketStatusAcct.state);
    if (sessionState !== 0)
        throw new Error(
            `market state is ${sessionState} (not OPEN) — the in-bundle freeze would revert. ` +
            `Run the launch inside NYSE hours (not within a minute of a bell), or see the header ` +
            `for the stake-days=21 fallback.`
        );
    const AMM_PROGRAM_ID = new PublicKey(stakePool.ammProgram);
    const [metricsPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("metrics"), AFHO_MINT.toBuffer()], AMM_PROGRAM_ID
    );

    // ── 4. Balance preflights — hard fails with exact numbers ────────────────
    const usdcAtaLaunch = getAssociatedTokenAddressSync(USDC_MINT, launchWallet.publicKey, false, TOKEN_PROGRAM_ID);
    const usdcAtaBuy = getAssociatedTokenAddressSync(USDC_MINT, buyWallet.publicKey, false, TOKEN_PROGRAM_ID);
    const afhoAtaBuy = getAssociatedTokenAddressSync(AFHO_MINT, buyWallet.publicKey, false, TOKEN_2022_PROGRAM_ID);

    const launchUsdc = (await getAccount(connection, usdcAtaLaunch, "confirmed", TOKEN_PROGRAM_ID)).amount;
    if (launchUsdc < BigInt(USDC_TO_LP) * 1_000_000n)
        throw new Error(
            `launch wallet holds ${Number(launchUsdc) / 1e6} USDC — needs ${USDC_TO_LP} (USDC_TO_LP) to seed the pool.`
        );

    const buyUsdc = (await getAccount(connection, usdcAtaBuy, "confirmed", TOKEN_PROGRAM_ID)).amount;
    if (buyUsdc < buyUsdcRaw)
        throw new Error(
            `buy wallet holds ${Number(buyUsdc) / 1e6} USDC — needs ${buyUsdcWhole} (0.18 × USDC_TO_LP=${USDC_TO_LP}) for the 3% buy.`
        );

    const [launchSol, buySol] = await Promise.all([
        connection.getBalance(launchWallet.publicKey, "confirmed"),
        connection.getBalance(buyWallet.publicKey, "confirmed"),
    ]);
    const positionRent = await connection.getMinimumBalanceForRentExemption(8 + 130); // StakePosition disc+space
    const userIndexRent = await connection.getMinimumBalanceForRentExemption(8 + 8);   // UserStakeIndex
    const buySolFloor =
        2 * 5_000 + LOT_COUNT * positionRent + userIndexRent + 0.005 * LAMPORTS_PER_SOL; // fees + rents + margin
    const launchSolFloor = 5_000 + (isMainnet ? tipSol * LAMPORTS_PER_SOL : 0) + 0.08 * LAMPORTS_PER_SOL; // fee + tip + pool rents
    if (buySol < buySolFloor)
        throw new Error(`buy wallet holds ${buySol / LAMPORTS_PER_SOL} SOL — needs ≥ ${(buySolFloor / LAMPORTS_PER_SOL).toFixed(4)} (fees + 4 stake-account rents).`);
    if (launchSol < launchSolFloor)
        throw new Error(`launch wallet holds ${launchSol / LAMPORTS_PER_SOL} SOL — needs ≥ ${(launchSolFloor / LAMPORTS_PER_SOL).toFixed(3)} (fee${isMainnet ? " + tip" : ""} + pool-creation rents).`);
    if (launchSol < 0.3 * LAMPORTS_PER_SOL)
        console.warn(`!! launch wallet SOL is low (${(launchSol / LAMPORTS_PER_SOL).toFixed(3)}) — fine to proceed, but slim.`);
    if (buySol < 0.05 * LAMPORTS_PER_SOL)
        console.warn(`!! buy wallet SOL is low (${(buySol / LAMPORTS_PER_SOL).toFixed(4)}) — fine to proceed, but slim.`);

    // Buy-wallet ATAs (USDC leg exists — it passed the balance check above; the
    // AFHO ATA is created here, idempotent, launch wallet pays rent).
    try {
        await getAccount(connection, afhoAtaBuy, "confirmed", TOKEN_2022_PROGRAM_ID);
    } catch {
        console.log(" creating buy-wallet AFHO ATA (one-time, launch wallet pays)…");
        const ataTx = new Transaction().add(
            createAssociatedTokenAccountIdempotentInstruction(
                launchWallet.publicKey, afhoAtaBuy, buyWallet.publicKey, AFHO_MINT, TOKEN_2022_PROGRAM_ID
            )
        );
        const { blockhash: ataBh } = await connection.getLatestBlockhash("confirmed");
        ataTx.recentBlockhash = ataBh;
        ataTx.feePayer = launchWallet.publicKey;
        const ataSig = await provider.sendAndConfirm(ataTx);
        console.log(`   AFHO ATA created: ${afhoAtaBuy.toBase58()} (tx ${ataSig})`);
    }

    // ── 5. Raydium: fee config + pool keys + pool-does-not-exist check ───────
    const { Raydium, TxVersion, DEVNET_PROGRAM_ID, CREATE_CPMM_POOL_PROGRAM, CREATE_CPMM_POOL_FEE_ACC,
        getCreatePoolKeys, getPdaPoolAuthority, getPdaObservationId, getPdaVault, CurveCalculator,
        makeSwapCpmmBaseInInstruction, makeSwapCpmmBaseOutInstruction } =
        await import("@raydium-io/raydium-sdk-v2");
    const raydium = await Raydium.load({ connection, owner: launchWallet, cluster: isMainnet ? "mainnet" : "devnet" });
    const cpmmProgramId = isMainnet ? CREATE_CPMM_POOL_PROGRAM : DEVNET_PROGRAM_ID.CREATE_CPMM_POOL_PROGRAM;
    const cpmmFeeAcc = isMainnet ? CREATE_CPMM_POOL_FEE_ACC : DEVNET_PROGRAM_ID.CREATE_CPMM_POOL_FEE_ACC;
    const feeConfigs = await raydium.api.getCpmmConfigs();
    const feeConfig: any = feeConfigs.find((c: any) => c.tradeFeeRate === 2500);
    if (!feeConfig) throw new Error(`No 0.25% CPMM fee config on ${net.cluster}`);

    const seedAfho = new BN(AFHO_TO_LP_WHOLE).mul(new BN(10).pow(new BN(decimals)));
    const seedUsdc = new BN(USDC_TO_LP).mul(new BN(1_000_000));

    // Pool id is a PDA of (amm_config, sorted mints) — know it BEFORE creating.
    const [mint0, mint1] = Buffer.compare(Buffer.from(USDC_MINT.toBytes()), Buffer.from(AFHO_MINT.toBytes())) <= 0
        ? [USDC_MINT, AFHO_MINT]
        : [AFHO_MINT, USDC_MINT];
    const prePoolId = getCreatePoolKeys({
        programId: new PublicKey(cpmmProgramId), configId: new PublicKey(feeConfig.id), mintA: mint0, mintB: mint1,
    }).poolId;
    const poolExists = await connection.getAccountInfo(prePoolId, "confirmed");
    if (poolExists) {
        throw new Error(
            `pool ${prePoolId.toBase58()} ALREADY EXISTS. On mainnet the bundle is atomic (this should be ` +
            `unreachable unless a create-pool ran manually). If the buy never landed, STOP — see MAINNET_CHECKLIST.`
        );
    }

    // Expected out from the pool's own curve at the launch reserves — must clear
    // the 30M floor with ~1% headroom, else the sizing constants drifted.
    const expectedOutRaw = BigInt(
        CurveCalculator.swapBaseInput(
            new BN(buyUsdcRaw.toString()),
            new BN((BigInt(USDC_TO_LP) * 1_000_000n).toString()),
            new BN((BigInt(AFHO_TO_LP_WHOLE) * rawPerWhole).toString()),
            new BN(feeConfig.tradeFeeRate), new BN(0),
            new BN(feeConfig.protocolFeeRate ?? 0), new BN(feeConfig.fundFeeRate ?? 0), false,
        ).outputAmount.toString()
    );
    if (expectedOutRaw < (minOutRaw * 101n) / 100n)
        throw new Error(
            `curve check failed: 0.18 × USDC_TO_LP=${buyUsdcWhole} buys only ~${Number(expectedOutRaw) / Number(rawPerWhole) / 1e6}M AFHO ` +
            `at the launch reserves (< 30M floor). Re-check USDC_TO_LP.`
        );

    // ── 6. BUILD the transaction set ──────────────────────────────────────────
    // tx1  create CPMM pool + initial deposit        (launch wallet, SDK v0)
    // tx2  buy: swap 0.18×L USDC → ≥30M AFHO         (buy wallet)
    // tx3  stake+freeze: 3 × 5M lots, indices 0–2,   (buy wallet)
    //      staked days=0 then frozen 21 trading days
    // tx4  Jito tip                                   (launch wallet, mainnet only)
    console.log("\n━━━ launch plan ━━━");
    console.log(`  pool seed : ${AFHO_TO_LP_WHOLE.toLocaleString("en-US")} AFHO : ${USDC_TO_LP.toLocaleString("en-US")} USDC`);
    console.log(`  buy       : ${buyUsdcWhole} USDC → ≥${BUY_TARGET_WHOLE.toLocaleString("en-US")} AFHO (expected ~${(Number(expectedOutRaw) / Number(rawPerWhole) / 1e6).toFixed(2)}M)`);
    console.log(`  frozen ½  : ${LOT_COUNT} × ${(STAKE_LOT_WHOLE / 1e6).toFixed(0)}M lots, days=${LOT_STAKE_DAYS} + frozen ${FREEZE_DAYS} trading days (indices 0–${LOT_COUNT - 1})`);
    console.log(`  liquid ½  : ~${(BUY_TARGET_WHOLE - LOT_COUNT * STAKE_LOT_WHOLE).toLocaleString("en-US")} AFHO stays in the buy wallet`);
    console.log(`  atomicity : ${isMainnet ? `one Jito bundle (+${tipSol} SOL tip) — all-or-nothing` : "sequential (devnet — no Jito bundles)"}`);
    console.log(`  pool PDA  : ${prePoolId.toBase58()}`);

    // tx1 — the SDK returns the built v0 transaction unsigned; we sign it here
    // so it can join the bundle instead of being sent by execute().
    const { transaction: createTxRaw, extInfo } = await raydium.cpmm.createPool({
        programId: cpmmProgramId,
        poolFeeAccount: cpmmFeeAcc,
        mintA: { address: AFHO_MINT.toBase58(), decimals, programId: TOKEN_2022_PROGRAM_ID.toBase58() },
        mintB: { address: USDC_MINT.toBase58(), decimals: USDC_DECIMALS, programId: TOKEN_PROGRAM_ID.toBase58() },
        mintAAmount: seedAfho,
        mintBAmount: seedUsdc,
        startTime: new BN(0), // open immediately — the same-block buy depends on this
        feeConfig,
        associatedOnly: false,
        ownerInfo: { useSOLBalance: true },
        txVersion: TxVersion.V0,
    });
    const poolId = extInfo.address.poolId;
    const configId = extInfo.address.configId;
    if (!poolId.equals(prePoolId))
        throw new Error(`SDK pool PDA ${poolId.toBase58()} != derived ${prePoolId.toBase58()} — fee-config mismatch, aborting.`);
    const createTx = createTxRaw as VersionedTransaction;
    createTx.sign([launchWallet]);

    // Pool keys for the swap (per-mint vaults; direction by mint sort order).
    const usdcIsToken0 = mint0.equals(USDC_MINT);
    const poolAuthority = getPdaPoolAuthority(new PublicKey(cpmmProgramId)).publicKey;
    const observationId = getPdaObservationId(new PublicKey(cpmmProgramId), poolId).publicKey;
    const usdcVault = getPdaVault(new PublicKey(cpmmProgramId), poolId, USDC_MINT).publicKey;
    const afhoVault = getPdaVault(new PublicKey(cpmmProgramId), poolId, AFHO_MINT).publicKey;

    // tx2 — buy swap (USDC in → AFHO out), same account layout the retired
    // buyer used; base-in when USDC sorts first (exact spend, min-out floor),
    // base-out otherwise (exact 30M+ out, spend ≤ budget).
    const swapAccounts = [
        new PublicKey(cpmmProgramId),
        buyWallet.publicKey,
        poolAuthority,
        configId,
        poolId,
        usdcAtaBuy,
        afhoAtaBuy,
        usdcVault,
        afhoVault,
        TOKEN_PROGRAM_ID,
        TOKEN_2022_PROGRAM_ID,
        USDC_MINT,
        AFHO_MINT,
        observationId,
    ];
    const buyTx = new Transaction();
    buyTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 250_000 }));
    buyTx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1_000 }));
    const swapIx = usdcIsToken0
        ? (makeSwapCpmmBaseInInstruction as any)(...swapAccounts, new BN(buyUsdcRaw.toString()), new BN(minOutRaw.toString()))
        : (makeSwapCpmmBaseOutInstruction as any)(...swapAccounts, new BN(buyUsdcRaw.toString()), new BN(expectedOutRaw.toString()));
    buyTx.add(swapIx);

    // tx3 — stake HALF the buy-in as lots (sequential indices 0..LOT_COUNT-1;
    // the program enforces index == user_index.next_index, so the stake ixs
    // run in order inside this transaction), then freeze each lot in the same
    // tx. Staked days=0 so the lot is vested immediately and the FREEZE is
    // the lock; the freeze rate is fixed from the day-0 card and the position
    // weight carries the bonus until the freeze settles. Position PDAs carry
    // the index in their seeds (little-endian u64) — same derivation as the
    // app's useStake.
    const leIndex = (i: number) => {
        const buf = Buffer.alloc(8);
        buf.writeBigUInt64LE(BigInt(i));
        return buf;
    };
    const positionPda = (i: number) =>
        PublicKey.findProgramAddressSync(
            [Buffer.from("position"), stakingPoolPda.toBuffer(), buyWallet.publicKey.toBuffer(), leIndex(i)],
            STAKING_PROGRAM_ID
        )[0];
    const stakeTx = new Transaction();
    for (let i = 0; i < LOT_COUNT; i++) {
        const stakeIx = await stakingProgram.methods
            .stake(new BN(lotRaw.toString()), new BN(i), LOT_STAKE_DAYS)
            .accounts({
                owner: buyWallet.publicKey,
                mint: AFHO_MINT,
                pool: stakingPoolPda,
                userIndex: userIndexPda,
                position: positionPda(i),
                ownerToken: afhoAtaBuy,
                vault: stakingVaultPda,
                marketStatus: MARKET_STATUS,
                tokenProgram: TOKEN_2022_PROGRAM_ID,
                systemProgram: SystemProgram.programId,
            })
            .instruction();
        stakeTx.add(stakeIx);
    }
    // All stakes land BEFORE any freeze: the popularity scalar divides
    // frozen_amount by total_staked, so freezing against the full 15M
    // denominator (not 5M/10M mid-stake) trims the per-lot penalty to
    // ≈ +16.0/+15.4/+10.1% at the day-0 card.
    for (let i = 0; i < LOT_COUNT; i++) {
        const freezeIx = await stakingProgram.methods
            .freeze(new BN(i), FREEZE_DAYS)
            .accounts({
                owner: buyWallet.publicKey,
                mint: AFHO_MINT,
                pool: stakingPoolPda,
                position: positionPda(i),
                metrics: metricsPda,
                marketStatus: MARKET_STATUS,
            })
            .instruction();
        stakeTx.add(freezeIx);
    }
    stakeTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }));
    stakeTx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1_000 }));

    const { blockhash } = await connection.getLatestBlockhash("confirmed");
    for (const tx of [buyTx, stakeTx]) {
        tx.recentBlockhash = blockhash;
        tx.feePayer = buyWallet.publicKey;
        tx.sign(buyWallet);
    }

    // tx4 — tip (mainnet only)
    let tipTx: Transaction | null = null;
    if (isMainnet) {
        const tips = await getTipAccounts();
        const tipAccount = new PublicKey(tips[Math.floor(Math.random() * tips.length)]);
        tipTx = new Transaction().add(
            SystemProgram.transfer({
                fromPubkey: launchWallet.publicKey,
                toPubkey: tipAccount,
                lamports: Math.round(tipSol * LAMPORTS_PER_SOL),
            })
        );
        tipTx.recentBlockhash = blockhash;
        tipTx.feePayer = launchWallet.publicKey;
        tipTx.sign(launchWallet);
    }

    // ── 7. SEND ────────────────────────────────────────────────────────────────
    let buySig: string, stakeSig: string;
    if (isMainnet) {
        const txs: Array<Transaction | VersionedTransaction> = tipTx
            ? [createTx, buyTx, stakeTx, tipTx]
            : [createTx, buyTx, stakeTx];
        console.log(`\n submitting Jito bundle (${txs.length} txs incl. ${tipSol} SOL tip)…`);
        const uuid = await sendBundle(txs);
        console.log(` bundle uuid: ${uuid}`);
        const deadline = Date.now() + BUNDLE_CONFIRM_TIMEOUT_MS;
        for (; ;) {
            await new Promise((r) => setTimeout(r, 3_000));
            const statuses = await getBundleStatuses([uuid]);
            const st = statuses.get(uuid);
            if (st?.landed) {
                console.log(` ✓ bundle LANDED (${st.confirmationStatus})`);
                break;
            }
            if (st?.err) throw new Error(`bundle failed: ${st.err}`);
            if (Date.now() > deadline)
                throw new Error(
                    "bundle not confirmed in 90s — treat as NOT landed until verified. Check `getBundleStatuses`/" +
                    "the pool PDA before re-running; the bundle is atomic so a dropped bundle changed nothing."
                );
            process.stdout.write(".");
        }
        buySig = buyTx.signature ? bs58Encode(new Uint8Array(buyTx.signature)) : "(in bundle)";
        stakeSig = stakeTx.signature ? bs58Encode(new Uint8Array(stakeTx.signature)) : "(in bundle)";
    } else {
        console.log("\n devnet path: sending the same txs sequentially (no Jito bundles on devnet)…");
        await sendAndConfirmRaw(connection, createTx.serialize(), "pool creation");
        console.log(` ✓ pool created: ${poolId.toBase58()}`);
        buySig = await sendAndConfirmRaw(connection, buyTx.serialize(), "buy");
        console.log(` ✓ buy landed: ${buyUsdcWhole} USDC in (tx ${buySig})`);
        try {
            stakeSig = await sendAndConfirmRaw(connection, stakeTx.serialize(), "stake+freeze lots");
        } catch (e) {
            throw new Error(
                `stake/freeze lots failed after the buy landed (devnet has no bundle atomicity): ${e instanceof Error ? e.message : e}. ` +
                `The buy is safe in the buy wallet — re-stake manually (same accounts) after fixing. If only the ` +
                `freeze legs failed, the lots sit days=0: freeze them from the app UI during any OPEN session.`
            );
        }
        console.log(` ✓ ${LOT_COUNT} lots staked + frozen (tx ${stakeSig})`);
    }

    // ── 8. POST-VERIFY (loud echo + read-back, per house rules) ────────────────
    writeDeploymentState({
        raydiumPool: pubkey(poolId),
        raydiumAmmConfig: pubkey(configId),
        raydiumProgram: new PublicKey(cpmmProgramId).toBase58(),
        raydiumLpMint: pubkey(extInfo.address.lpMint),
    });
    console.log("\n━━━ post-verify ━━━");
    console.log(`  pool      : ${poolId.toBase58()} (LP mint ${extInfo.address.lpMint.toBase58()} — burn via 'anchor run burn-lp')`);
    const afhoBal = (await getAccount(connection, afhoAtaBuy, "confirmed", TOKEN_2022_PROGRAM_ID)).amount;
    const stakedPool = await (stakingProgram.account as any).stakePool.fetch(stakingPoolPda);
    const vaultBal = stakedPool.totalStaked.toString();
    const frozenBal = stakedPool.frozenAmount.toString();
    const liquidTarget = BUY_TARGET_WHOLE - LOT_COUNT * STAKE_LOT_WHOLE;
    console.log(`  buy wallet: ${Number(afhoBal) / Number(rawPerWhole)} AFHO in ATA (the liquid half — expect ≈ ${liquidTarget.toLocaleString("en-US")} + dust)`);
    console.log(`  staked    : ${Number(vaultBal) / Number(rawPerWhole)} AFHO total in the staking pool (expect ≥ ${(LOT_COUNT * STAKE_LOT_WHOLE).toLocaleString("en-US")})`);
    console.log(`  frozen    : ${Number(frozenBal) / Number(rawPerWhole)} AFHO frozen until trading day +${FREEZE_DAYS} (expect ≥ ${(LOT_COUNT * STAKE_LOT_WHOLE).toLocaleString("en-US")})`);
    console.log(`  buy sig   : ${buySig}`);
    console.log(`  stake sig : ${stakeSig}`);
    console.log("\n✓ launch-bundle complete. Next: anchor run set-pools → check-authorities → burn-lp.");
}

/** Send an already-signed serialized tx and confirm it — checking status.err
 *  explicitly (the 09-25 lesson: a reverted swap must never read as landed). */
async function sendAndConfirmRaw(connection: any, wire: Uint8Array, label: string): Promise<string> {
    const sig = await connection.sendRawTransaction(Buffer.from(wire), { skipPreflight: false, maxRetries: 3 });
    const deadline = Date.now() + 60_000;
    for (; ;) {
        await new Promise((r) => setTimeout(r, 2_000));
        const res = await connection.getSignatureStatuses([sig], { searchTransactionHistory: true });
        const st = res?.value?.[0];
        if (st?.err) throw new Error(`${label} FAILED on-chain: ${JSON.stringify(st.err)} (tx ${sig})`);
        if (st?.confirmationStatus === "confirmed" || st?.confirmationStatus === "finalized") return sig;
        if (Date.now() > deadline) throw new Error(`${label} not confirmed in 60s (tx ${sig}) — check it before re-running.`);
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
