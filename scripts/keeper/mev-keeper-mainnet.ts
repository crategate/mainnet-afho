// ─────────────────────────────────────────────────────────────────────
// mev-keeper-mainnet — PRODUCTION keeper (mainnet).
//
// Production-only copy of scripts/keeper/mev-keeper.ts: no --test-state,
// no test_set_state / test_collect_bounty, no devnet genesis gate, no
// TEST_* env/argv knobs. Cranks the on-chain calendar (schedule-as-data
// fires the same transition sequences (update_tradeday_stats →
// make_offers, calc_completed_offers, dex_buyback, buy_the_dip,
// bounty_top_up) and the records snapshot.
//
// MAINNET CONFIG CHECKLIST (everything this file assumes):
//   1. ANCHOR_PROVIDER_URL = mainnet RPC (helius/quicknode/etc — not the
//      public api.mainnet-beta.solana.com for a crank loop) and
//      ANCHOR_WALLET = the keeper keypair (rotate off authority via
//      set_keeper; the keeper does NOT need authority).
//   2. deployment.json points at the MAINNET deployment (program IDs,
//      mint, marketCalendar).
//   3. AmmState pool pins: cpmm_pool_state = the AFHO/USDC pool created by
//      create-pool, cpmm_sol_usdc_pool = the deep canonical wSOL/USDC pool
//      (creator fee OFF) — set via set-cpmm-pool / set-sol-usdc-pool with
//      DEVNET_SOL_USDC_POOL/_CONFIG pointing at it. Bounty pricing and
//      SOL claims read these pins from bounty_config/amm_state, so nothing
//      is hardcoded here.
//   4. Env: BOUNTY_RECYCLE=0 to disable bounty recycling
//      (ON by default — see the note below). Optional VITE-style RPC url is
//      NOT used here; the provider URL above is the single endpoint.
//   5. Solana price sanity: the bounty is USD-denominated but converts at
//      the pinned pool's price, so keep an eye on the logged sol_price
//      until the canonical pool proves anchored.
// ─────────────────────────────────────────────────────────────────────
import * as anchor from "@coral-xyz/anchor";
import { BN } from "@coral-xyz/anchor";  // Anchor re-exports BN
import * as dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { asV0Tx } from "../lib/tx";
import { evalState, fromAnchorAccount, fromAnchorData } from "../lib/calendar";
import { haltPoolKeys } from "../lib/clmm";
import {
    getAssociatedTokenAddressSync,
    ASSOCIATED_TOKEN_PROGRAM_ID,
    TOKEN_PROGRAM_ID,
    TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";
import type { CrankOracle } from "../../target/types/crank_oracle";
import { ANSI, ev, evc, skip, dim } from "../lib/keeper-log";

dotenv.config();

async function main() {
    // AnchorUtils.loadEnv replacement (Switchboard removed 2026-09-19):
    // same env contract — ANCHOR_PROVIDER_URL + ANCHOR_WALLET.
    const rpcUrl = process.env.ANCHOR_PROVIDER_URL!;
    const walletPath = (process.env.ANCHOR_WALLET ?? "~/.config/solana/id.json").replace(
        /^~/,
        process.env.HOME ?? "~"
    );
    const connection = new Connection(rpcUrl, "confirmed");
    const keypair = Keypair.fromSecretKey(
        Buffer.from(JSON.parse(fs.readFileSync(walletPath, "utf-8")))
    );
    const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(keypair), {});

    const idlPath = path.join(process.cwd(), "target", "idl", "crank_oracle.json");
    if (!fs.existsSync(idlPath)) {
        throw new Error(`IDL not found at ${idlPath}. Run 'anchor build' first.`);
    }

    const idl = JSON.parse(fs.readFileSync(idlPath, "utf-8"));
    const program = new anchor.Program(idl, provider) as unknown as anchor.Program<CrankOracle>;
    const programId = program.programId;

    const [marketStatusPda] = anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("market_status")],
        programId
    );
    const [bountyConfigPda] = anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("bounty_config")],
        programId
    );
    const [bountyVaultPda] = anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("bounty_vault")],
        programId
    );

    const deployment = JSON.parse(
        fs.readFileSync(path.join(process.cwd(), "app", "public", "deployment.json"), "utf-8")
    );
    // Market calendar PDA — the schedule-as-data account the crank derives
    // state from (see init-calendar.ts and MEV-BOUNTY.md). The keeper's TS
    // evaluator mirror (./calendar) uses it to know WHEN to crank. The
    // halt_state PDA carries the breaker bookkeeping; the immutable CLMM pool
    // accounts are the breaker's price source (read on-chain, never pushed).
    const [marketCalendarPda] = anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("market_calendar")],
        programId
    );
    const [haltStatePda] = anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("halt_state")],
        programId
    );

    // AMM program client for firing make_offers at end of trading day
    const ammIdl = JSON.parse(
        fs.readFileSync(path.join(process.cwd(), "target", "idl", "amm.json"), "utf-8")
    );
    const ammProgram = new anchor.Program(ammIdl as anchor.Idl, provider);
    const afhoMint = new PublicKey(deployment.mint);
    const WSOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");
    const ammPda = (seed: string) =>
        anchor.web3.PublicKey.findProgramAddressSync(
            [Buffer.from(seed), afhoMint.toBuffer()],
            ammProgram.programId
        )[0];
    const ammStatePda = ammPda("amm_state");
    const offerListPda = ammPda("offer_list");
    // Alt desk sheet (state-3 second bond sheet). Created lazily on-chain;
    // the PDA is deterministic so the keeper can pass it pre-creation.
    const altListPda = ammPda("alt_offer_list");
    const metricsPda = ammPda("metrics");
    const acceptedOffersPda = ammPda("accepted_offers");

    // Raydium CPMM accounts for the swap adapter. When the pool is pinned in
    // The CPMM pool is the ONLY swap venue and price source. The pool pins
    // live in AmmState; an unpinned pool is a hard error (the on-chain
    // instructions reject it with PoolNotPinned) — never a stub price.
    function cpmmAccountsFor(
        ammState: any,
        usdcMint: PublicKey
    ) {
        if (!ammState.cpmmPoolState || !ammState.cpmmProgram) {
            throw new Error(
                "CPMM pool not pinned in AmmState — run 'anchor run set-cpmm-pool' (and 'set-sol-usdc-pool' for the SOL leg)."
            );
        }
        const program = new PublicKey(ammState.cpmmProgram);
        const pool = new PublicKey(ammState.cpmmPoolState);
        const [authority] = PublicKey.findProgramAddressSync(
            [Buffer.from("vault_and_lp_mint_auth_seed")],
            program
        );
        const [observation] = PublicKey.findProgramAddressSync(
            [Buffer.from("observation"), pool.toBuffer()],
            program
        );
        const [inputVault] = PublicKey.findProgramAddressSync(
            [Buffer.from("pool_vault"), pool.toBuffer(), usdcMint.toBuffer()],
            program
        );
        const [outputVault] = PublicKey.findProgramAddressSync(
            [Buffer.from("pool_vault"), pool.toBuffer(), afhoMint.toBuffer()],
            program
        );
        return {
            cpmmPoolState: pool,
            cpmmAmmConfig: new PublicKey(ammState.cpmmAmmConfig),
            cpmmInputVault: inputVault,
            cpmmOutputVault: outputVault,
            cpmmObservation: observation,
            cpmmAuthority: authority,
            // The CPMM program itself must be among the instruction's
            // accounts or the swap CPI fails with MissingAccount.
            cpmmProgram: program,
        };
    }

    // Raydium SOL/USDC CPMM accounts for bounty_top_up / offer_claim_sol.
    // Returns null when the pool isn't pinned in state.
    function solUsdcAccountsFor(ammState: any) {
        if (!ammState.cpmmSolUsdcPool || !ammState.cpmmProgram) {
            return null;
        }
        const program = new PublicKey(ammState.cpmmProgram);
        const pool = new PublicKey(ammState.cpmmSolUsdcPool);
        const usdcMint = new PublicKey(ammState.usdcMint);
        const [authority] = PublicKey.findProgramAddressSync(
            [Buffer.from("vault_and_lp_mint_auth_seed")],
            program
        );
        const [observation] = PublicKey.findProgramAddressSync(
            [Buffer.from("observation"), pool.toBuffer()],
            program
        );
        const [inputVault] = PublicKey.findProgramAddressSync(
            [Buffer.from("pool_vault"), pool.toBuffer(), WSOL_MINT.toBuffer()],
            program
        );
        const [outputVault] = PublicKey.findProgramAddressSync(
            [Buffer.from("pool_vault"), pool.toBuffer(), usdcMint.toBuffer()],
            program
        );
        return {
            solUsdcPoolState: pool,
            solUsdcAmmConfig: new PublicKey(ammState.cpmmSolUsdcConfig),
            solUsdcInputVault: inputVault,
            solUsdcOutputVault: outputVault,
            solUsdcObservation: observation,
            solUsdcAuthority: authority,
        };
    }

    // SOL/USDC pool vaults for the crank bounty's USD price read — null when
    // the pool isn't pinned in the bounty config (fixed-lamport fallback).
    // Shared by the production crank and the test-mode fee collection.
    function solUsdcCrankVaults(cfg: any) {
        if (!cfg.solUsdcPool || new PublicKey(cfg.solUsdcPool).equals(PublicKey.default)) {
            return null;
        }
        const cpmmProgram = new PublicKey(cfg.cpmmProgram);
        const pool = new PublicKey(cfg.solUsdcPool);
        const usdcMint = new PublicKey(cfg.usdcMint);
        const [wsolVault] = PublicKey.findProgramAddressSync(
            [Buffer.from("pool_vault"), pool.toBuffer(), WSOL_MINT.toBuffer()],
            cpmmProgram
        );
        const [usdcVault] = PublicKey.findProgramAddressSync(
            [Buffer.from("pool_vault"), pool.toBuffer(), usdcMint.toBuffer()],
            cpmmProgram
        );
        return { solUsdcWsolVault: wsolVault, solUsdcUsdcVault: usdcVault };
    }

    // ── descriptive-log helpers (amounts + % of vaults) ───────────────────
    const fmtRaw = (raw: bigint, decimals: number, maxFrac = 4): string => {
        const unit = 10n ** BigInt(decimals);
        const whole = raw / unit;
        let frac = (raw % unit).toString().padStart(decimals, "0").slice(0, maxFrac);
        frac = frac.replace(/0+$/, "");
        return frac ? `${whole.toLocaleString("en-US")}.${frac}` : whole.toLocaleString("en-US");
    };
    const fmtUsdc = (raw: bigint) => `${fmtRaw(raw, 6)} USDC`;
    const fmtSolL = (raw: bigint) => `${fmtRaw(raw, 9)} SOL`;
    const fmtAfho = (raw: bigint) => `${fmtRaw(raw, 9, 2)} AFHO`;
    // Floor units = price per whole token × 1e9 (nano-USD).
    const fmtPrice = (floor: bigint) => `$${fmtRaw(floor, 9, 9)}`;
    const pctOf = (num: bigint, den: bigint): string =>
        den <= 0n ? "—" : `${(Number((num * 10000n) / den) / 100).toFixed(2)}%`;
    const bn = (v: unknown): bigint => BigInt((v as any).toString());

    // Custom error code out of a failed simulation ({"InstructionError":[..,{"Custom":N}]}).
    function customErrCode(err: unknown): number | null {
        const m = JSON.stringify(err).match(/"Custom":(\d+)/);
        return m ? parseInt(m[1], 10) : null;
    }
    const reason = (err: unknown, map: Record<number, string>): string => {
        const code = customErrCode(err);
        return code !== null ? (map[code] ?? `custom ${code}`) : JSON.stringify(err);
    };

    // SPL token amount (u64 LE at offset 64) — null when the account is absent.
    async function tokenAmount(pk: PublicKey): Promise<bigint | null> {
        const a = await connection.getAccountInfo(pk, "confirmed");
        if (!a || a.data.length < 72) return null;
        return new DataView(a.data.buffer, a.data.byteOffset, a.data.byteLength).getBigUint64(64, true);
    }

    // Bounty recycling: immediately re-fund the bounty vault with whatever
    // the crank just paid out. While this keeper is the only earner the
    // operator is effectively paying themselves (the keeper nets ~0 minus
    // the recycle tx fee), and the vault stays above the 10-payment
    // bounty_top_up low water so AFHO-funded top-ups never fire. Set
    // BOUNTY_RECYCLE=0 once third-party keepers win transitions — their
    // collections then drain the vault and top-ups resume as designed.
    const RECYCLE = process.env.BOUNTY_RECYCLE ?? "1";
    const recycleBounty = RECYCLE === "1";

    console.log(` ${ev(ANSI.cyan, "Keeper started")}`);
    console.log(`${evc(ANSI.cyan, "Program ID")}${programId.toBase58()}`);
    console.log(`${evc(ANSI.cyan, "Market Status")}${marketStatusPda.toBase58()}`);
    console.log(`${evc(ANSI.cyan, "Bounty Config")}${bountyConfigPda.toBase58()}`);
    console.log(`${evc(ANSI.cyan, "Bounty Vault")}${bountyVaultPda.toBase58()}`);
    if (recycleBounty) console.log(dim("Bounty recycling: ON (BOUNTY_RECYCLE=0 to disable)"));

    // ET wall-clock hour, host-timezone-independent: Intl resolves
    // America/New_York with correct EDT/EST DST handling. (The old
    // `getTimezoneOffset() === 240 ? -4 : -5` inference read the HOST's
    // offset — on a UTC host it subtracted 5 all year, so the cadence was
    // an hour off during EDT.)
    function getSleepDuration(): number {
        const etHour = Number(
            new Intl.DateTimeFormat("en-US", {
                timeZone: "America/New_York",
                hour: "numeric",
                hourCycle: "h23",
            }).format(new Date())
        );

        if ((etHour >= 9 && etHour < 10) || (etHour >= 15 && etHour < 16)) {
            return 60_000;
        }
        if (etHour >= 10 && etHour < 15) {
            return 300_000;
        }
        if (etHour >= 4 && etHour < 20) {
            return 900_000;
        }
        return 3_600_000;
    }

    while (true) {
        const sleepMs = getSleepDuration();
        try {
            const marketStatus = await program.account.marketStatus.fetch(marketStatusPda);
            const bountyConfig = await program.account.bountyConfig.fetch(bountyConfigPda);
            await logSlotTimeOnce(connection);
            // (prevState removed 2026-09-17: day-flow triggers are day-lag
            // driven now — see the state-driven catch-up block below.)
            let newStatus: any = null;
            // Calendar-driven trigger (TS mirror of the on-chain evaluator):
            // crank when the derived state differs from the stored state —
            // under the active calendar OR a queued pending update (the
            // program activates the pending at the bell and re-derives).
            // No quote to poll: nothing to send when the states agree.
            const calAcc = await program.account.marketCalendar.fetch(marketCalendarPda);
            const nowTs = Math.floor(Date.now() / 1000);
            let expected = evalState(fromAnchorAccount(calAcc), nowTs);
            if (calAcc.hasPending) {
                const pendingExpected = evalState(fromAnchorData(calAcc.pending), nowTs);
                if (pendingExpected !== expected) expected = pendingExpected;
            }

            // Breaker pools: when pinned, every crank carries both CLMM
            // pool accounts — the program reads live market state directly;
            // there is nothing to push (a missing pool fails 6015 loudly).
            const haltPools = haltPoolKeys(bountyConfig);

            if (expected !== Number(marketStatus.currentState)) {
                // Real crank (production path): the program derives the
                // state from the calendar PDA + its own clock — there is no
                // quote to push, so the tx is just the crank itself.
                const crankAccounts: any = {
                    cranker: keypair.publicKey,
                    bountyConfig: bountyConfigPda,
                    bountyVault: bountyVaultPda,
                    clock: anchor.web3.SYSVAR_CLOCK_PUBKEY,
                    marketStatus: marketStatusPda,
                    marketCalendar: marketCalendarPda,
                    haltState: haltStatePda,
                    haltPoolA: haltPools?.a ?? anchor.web3.SystemProgram.programId,
                    haltPoolB: haltPools?.b ?? anchor.web3.SystemProgram.programId,
                    systemProgram: anchor.web3.SystemProgram.programId,
                };
                Object.assign(crankAccounts, solUsdcCrankVaults(bountyConfig));

                const crankIx = await program.methods.permissionlessCrank().accountsStrict(crankAccounts).instruction();

                const ixs = [crankIx];

                const tx = await asV0Tx({
                    connection,
                    ixs,
                    signers: [keypair],
                    computeUnitPrice: 20_000,
                });

                const sim = await connection.simulateTransaction(tx);
                if (sim.value.err) {
                    console.error(`${evc(ANSI.red, "Simulation failed")}${sim.value.err}`);
                    console.error(sim.value.logs?.join("\n") || "NO LOGS :(")
                    await sleep(sleepMs);
                    continue;
                }

                const bountyBalBefore = await connection.getBalance(bountyVaultPda);
                const sig = await connection.sendTransaction(tx);
                await connection.confirmTransaction(sig, "confirmed");
                console.log(`${ev(ANSI.green, "Cranked!")} ${sig}`);
                if (recycleBounty) {
                    // Vault delta = the bounty that just paid out (only the
                    // crank instruction moves the bounty vault). Recycle it.
                    try {
                        const paid = BigInt(await connection.getBalance(bountyVaultPda)) - BigInt(bountyBalBefore);
                        if (paid > 0n) {
                            const recycleTx = await asV0Tx({
                                connection,
                                ixs: [
                                    anchor.web3.SystemProgram.transfer({
                                        fromPubkey: keypair.publicKey,
                                        toPubkey: bountyVaultPda,
                                        lamports: Number(paid),
                                    }),
                                ],
                                signers: [keypair],
                                computeUnitPrice: 20_000,
                            });
                            const recycleSig = await connection.sendTransaction(recycleTx);
                            await connection.confirmTransaction(recycleSig, "confirmed");
                            console.log(`${evc(ANSI.brightGreen, "bounty recycled")}${fmtSolL(paid)} straight back into the bounty vault — ${recycleSig}`);
                        }
                    } catch (e) {
                        console.error(`${evc(ANSI.red, "!! bounty recycle failed")}${(e as Error).message}`);
                    }
                }
                }

                // ── State-driven day-flow catch-up (2026-09-17) ──
                // Fetch fresh state EVERY loop — not only after our own crank —
                // and derive the triggers from DAY-LAG instead of observing a
                // transition inside this loop. A transition won by a third-party
                // keeper between our loops (or while we were down) used to be
                // invisible: prevState was re-read at loop top AFTER the flip,
                // so no sheet posted that night and no fill-ring/floor-decay ran
                // next morning. The on-chain day-index idempotency guards make
                // these checks safe on every loop — every body below simulates
                // first and skips as an expected no-op when the day is done.
                newStatus = await program.account.marketStatus.fetch(marketStatusPda);

                if (newStatus !== null) {
                const currentDay = Number(bn(newStatus.tradingDayIndex));
                const [offerListAcc, acceptedAcc, altAcc] = await Promise.all([
                    (ammProgram.account as any).offerList.fetchNullable(offerListPda),
                    (ammProgram.account as any).acceptedOffers.fetchNullable(acceptedOffersPda),
                    (ammProgram.account as any).altOfferList.fetchNullable(altListPda),
                ]);
                // Day-index guards init to u64::MAX — an absurdly large value is
                // the sentinel, not a real day.
                const dayOf = (acc: any) => (acc ? Number(bn(acc.dayIndex)) : null);
                const isSentinel = (d: number | null) => d === null || d > 2 ** 53;
                const sheetDay = dayOf(offerListAcc);
                const acceptedDay = dayOf(acceptedAcc);
                const altDay = dayOf(altAcc);
                const sheetStale = isSentinel(sheetDay) || sheetDay !== currentDay;
                const yesterdaySheet = !isSentinel(sheetDay) && sheetDay === currentDay - 1;
                const acceptedMissing = isSentinel(acceptedDay) || acceptedDay !== currentDay;
                const altMissing = isSentinel(altDay) || altDay !== currentDay;

                // Day flow due: the market is in a night state (extended 1 or
                // closed 2) but tonight's sheet is not built (first loop after
                // the 16:00 close, a transition we lost the crank race on, a
                // keeper restart, or an earlier make_offers failure — all
                // self-heal from here). Fire update_tradeday_stats FIRST (it
                // owns all end-of-day metric writes), then make_offers.
                const dayEnded =
                    (newStatus.currentState === 1 || newStatus.currentState === 2) && sheetStale;
                if (dayEnded) {
                    console.log(`${ev(ANSI.magenta, "Day flow due")} (state ${newStatus.currentState}, sheet day ${sheetDay ?? "none"} ≠ day ${currentDay}). Firing update_tradeday_stats + make_offers...`);
                    try {
                        const ammStateForStats = await (ammProgram.account as any).ammState.fetch(ammStatePda);
                        const statsUsdcMint = new PublicKey(ammStateForStats.usdcMint);
                        const statsCpmm = cpmmAccountsFor(ammStateForStats, statsUsdcMint);
                        const statsIx = await ammProgram.methods
                            .updateTradedayStats()
                            .accountsStrict({
                                cranker: keypair.publicKey,
                                ammState: ammStatePda,
                                marketMetrics: metricsPda,
                                marketStatus: marketStatusPda,
                                cpmmPoolState: statsCpmm.cpmmPoolState,
                                cpmmObservation: statsCpmm.cpmmObservation,
                                cpmmInputVault: statsCpmm.cpmmInputVault,
                                cpmmOutputVault: statsCpmm.cpmmOutputVault,
                                stakingPool: ammStateForStats.stakingPool,
                                afhoMint,
                                afhoVault: ammStateForStats.afhoVault,
                            })
                            .instruction();
                        const statsTx = await asV0Tx({
                            connection,
                            ixs: [statsIx],
                            signers: [keypair],
                            computeUnitPrice: 20_000,
                        });
                        const statsSim = await connection.simulateTransaction(statsTx);
                        if (statsSim.value.err) {
                            console.error(`${evc(ANSI.red, "update_tradeday_stats simulation failed (already updated today?)")}${statsSim.value.err}`);
                        } else {
                            const statsSig = await connection.sendTransaction(statsTx);
                            await connection.confirmTransaction(statsSig, "confirmed");
                            console.log(`${ev(ANSI.cyan, "update_tradeday_stats fired!")} ${statsSig}`);
                        }

                        const makeOffersIx = await ammProgram.methods
                            .makeOffers()
                            .accountsStrict({
                                cranker: keypair.publicKey,
                                ammState: ammStatePda,
                                offerList: offerListPda,
                                marketStatus: marketStatusPda,
                                metrics: metricsPda,
                                acceptedOffers: acceptedOffersPda,
                                afhoMint: afhoMint,
                                afhoVault: new PublicKey(deployment.ammAfhoVault),
                            })
                            .instruction();

                        const offersTx = await asV0Tx({
                            connection,
                            ixs: [makeOffersIx],
                            signers: [keypair],
                            computeUnitPrice: 20_000,
                        });
                        const offersSim = await connection.simulateTransaction(offersTx);
                        if (offersSim.value.err) {
                            console.error(`${evc(ANSI.red, "make_offers simulation failed (already built today?)")}${offersSim.value.err}`);
                        } else {
                            const offersSig = await connection.sendTransaction(offersTx);
                            await connection.confirmTransaction(offersSig, "confirmed");
                            console.log(`${ev(ANSI.cyan, "make_offers fired!")} ${offersSig}`);
                        }
                    } catch (e) {
                        // Never let an offer-sheet failure kill the crank loop
                        console.error(`${evc(ANSI.red, "!! end-of-day AMM sequence failed")}${e}`);
                    }
                }

                // The alt desk: while the market sits in the halted state with
                // no alt sheet for THIS trading day, post the second,
                // fixed-terms sheet (restart- and lost-race-safe). One sheet
                // per trading day is enforced on-chain (alt_list.day_index
                // cooldown); the "already posted today" simulation failure is
                // normal noise when a halt flaps. Never let it kill the loop.
                const haltStarted = newStatus.currentState === 3 && altMissing;
                if (haltStarted) {
                    console.log(`${ev(ANSI.brightYellow, "Alt sheet window")} (state 3, alt sheet day ${altDay ?? "none"} ≠ day ${currentDay}). Firing make_alt_offers...`);
                    try {
                        const altOffersIx = await ammProgram.methods
                            .makeAltOffers()
                            .accountsStrict({
                                cranker: keypair.publicKey,
                                ammState: ammStatePda,
                                altList: altListPda,
                                marketStatus: marketStatusPda,
                                afhoMint: afhoMint,
                                afhoVault: new PublicKey(deployment.ammAfhoVault),
                                systemProgram: anchor.web3.SystemProgram.programId,
                            })
                            .instruction();
                        const altTx = await asV0Tx({
                            connection,
                            ixs: [altOffersIx],
                            signers: [keypair],
                            computeUnitPrice: 20_000,
                        });
                        const altSim = await connection.simulateTransaction(altTx);
                        if (altSim.value.err) {
                            console.error(`${evc(ANSI.red, "make_alt_offers simulation failed (already posted today?)")}${altSim.value.err}`);
                        } else {
                            const altSig = await connection.sendTransaction(altTx);
                            await connection.confirmTransaction(altSig, "confirmed");
                            console.log(`${ev(ANSI.cyan, "make_alt_offers fired!")} ${altSig}`);
                        }
                    } catch (e) {
                        // Never let an alt-sheet failure kill the crank loop
                        console.error(`${evc(ANSI.red, "!! alt sheet sequence failed")}${e}`);
                    }
                }

                // Trading day STARTS when the market opens (state 0). The crank
                // rolls trading_day_index at the OPEN ((1|2)→0), so this fires
                // on the first loop after the open bell when yesterday's sheet
                // is still the latest and its fill ring is unrecorded —
                // regardless of who won the transition crank or when the
                // keeper last restarted.
                const dayStarted =
                    newStatus.currentState === 0 && yesterdaySheet && acceptedMissing;
                if (dayStarted) {
                    console.log(`${ev(ANSI.brightMagenta, "Day started")} (state 0, sheet day ${sheetDay} = day ${currentDay}-1, fills unrecorded). Firing calc_completed_offers...`);
                    try {
                        // Live price for ratchet decay: the pinned CPMM pool
                        // (TWAP / vault-ratio) — the only price source.
                        const ammStateForCalc = await (ammProgram.account as any).ammState.fetch(ammStatePda);
                        const calcUsdcMint = new PublicKey(ammStateForCalc.usdcMint);
                        const calcCpmm = cpmmAccountsFor(ammStateForCalc, calcUsdcMint);
                        const calcIx = await ammProgram.methods
                            .calcCompletedOffers()
                            .accountsStrict({
                                cranker: keypair.publicKey,
                                ammState: ammStatePda,
                                offerList: offerListPda,
                                marketStatus: marketStatusPda,
                                acceptedOffers: acceptedOffersPda,
                                cpmmPoolState: calcCpmm.cpmmPoolState,
                                cpmmObservation: calcCpmm.cpmmObservation,
                                cpmmInputVault: calcCpmm.cpmmInputVault,
                                cpmmOutputVault: calcCpmm.cpmmOutputVault,
                            })
                            .instruction();
                        const calcTx = await asV0Tx({
                            connection,
                            ixs: [calcIx],
                            signers: [keypair],
                            computeUnitPrice: 20_000,
                        });
                        const calcSim = await connection.simulateTransaction(calcTx);
                        if (calcSim.value.err) {
                            console.error(`${evc(ANSI.red, "calc_completed_offers simulation failed (already recorded today?)")}${calcSim.value.err}`);
                        } else {
                            const calcSig = await connection.sendTransaction(calcTx);
                            await connection.confirmTransaction(calcSig, "confirmed");
                            console.log(`${ev(ANSI.cyan, "calc_completed_offers fired!")} ${calcSig}`);
                        }
                    } catch (e) {
                        console.error(`${evc(ANSI.red, "!! calc_completed_offers failed")}${e}`);
                    }

                    // Staker distribution: swap yesterday's 10% USDC share to
                    // AFHO and deposit into the staking reward vault. Once per
                    // day (on-chain day_index guard); a sim failure (nothing
                    // collected / no stakers) is expected and skipped.
                    try {
                        const ammStateForDist = await (ammProgram.account as any).ammState.fetch(ammStatePda);
                        const usdcMint = new PublicKey(ammStateForDist.usdcMint);
                        const stakingPoolPda = new PublicKey(ammStateForDist.stakingPool);
                        const stakingIdl = JSON.parse(fs.readFileSync(path.join(process.cwd(), "target", "idl", "staking.json"), "utf-8"));
                        const stakingProgramId = new PublicKey(stakingIdl.address ?? stakingIdl.metadata?.address);
                        const [stakingRewardVault] = PublicKey.findProgramAddressSync(
                            [Buffer.from("rewards"), stakingPoolPda.toBuffer()],
                            stakingProgramId
                        );
                        const distIx = await ammProgram.methods
                            .distributeStakerRewards()
                            .accountsStrict({
                                cranker: keypair.publicKey,
                                ammState: ammStatePda,
                                marketStatus: marketStatusPda,
                                usdcRewards: ammStateForDist.usdcRewards,
                                afhoVault: ammStateForDist.afhoVault,
                                afhoMint,
                                usdcMint,
                                ...cpmmAccountsFor(ammStateForDist, usdcMint),
                                stakingProgram: stakingProgramId,
                                stakingPool: stakingPoolPda,
                                stakingRewardVault,
                                tokenProgram: TOKEN_PROGRAM_ID,
                                token2022Program: TOKEN_2022_PROGRAM_ID,
                            })
                            .instruction();
                        const distTx = await asV0Tx({
                            connection,
                            ixs: [distIx],
                            signers: [keypair],
                            computeUnitPrice: 20_000,
                        });
                        const distSim = await connection.simulateTransaction(distTx);
                        if (distSim.value.err) {
                            console.log(`${skip("distribute_staker_rewards skipped (already done / nothing to distribute / no stakers)")}${JSON.stringify(distSim.value.err)}`);
                            console.log(`  ${ANSI.dim}${ANSI.gray}last logs:${ANSI.reset}`, distSim.value.logs?.slice(-4) ?? []);
                        } else {
                            const distSig = await connection.sendTransaction(distTx);
                            await connection.confirmTransaction(distSig, "confirmed");
                            console.log(`${ev(ANSI.cyan, "distribute_staker_rewards fired!")} ${distSig}`);
                        }
                    } catch (e) {
                        console.error(`${evc(ANSI.red, "!! distribute_staker_rewards failed")}${(e as Error).message}`);
                    }

                    // Records ledger: snapshot the day-start state for the
                    // /records page (app/public/records.json). Best-effort —
                    // a failed snapshot never fails the crank loop. Logs
                    // NEW vs updated so a stuck day index is obvious: the row
                    // is keyed by the on-chain trading_day_index, NOT the
                    // calendar date — a new row only appears when the day
                    // index rolls (1/2 → 0 transition).
                    try {
                        const { recordDay } = await import("./record-day");
                        const { row, inserted } = await recordDay(connection);
                        console.log(
                            `${ev(ANSI.cyan, "records ledger")} ${inserted ? "NEW trading day" : "updated existing day"} ` +
                                `#${row.dayIndex} (${row.date}, state ${row.marketState}) -> app/public/records.json`,
                        );
                    } catch (e) {
                        console.error(`${evc(ANSI.red, "!! records snapshot failed")}${(e as Error).message}`);
                    }
                }
            } else {
                console.log(dim("No transition due — nothing to crank."));
            }

            // dex_buyback slices: attempt every loop while the market is open.
            // On-chain pacing (MIN_SLICE_SLOTS) turns extra fires into cheap
            // no-ops; sim failures (no fills, budget spent) are expected.
            try {
                const statusNow = await program.account.marketStatus.fetch(marketStatusPda);
                if (statusNow.currentState === 0) {
                    const ammState = await (ammProgram.account as any).ammState.fetch(ammStatePda);
                    const usdcMint = new PublicKey(ammState.usdcMint);
                    const bbVault = (await tokenAmount(ammState.usdcVault)) ?? 0n;
                    const bbAfhoBefore = (await tokenAmount(ammState.afhoVault)) ?? 0n;
                    const bbBudget = bn(ammState.bbBudgetUsdc);
                    const bbSpent = bn(ammState.bbSpentUsdc);
                    const bbRemaining = bbBudget > bbSpent ? bbBudget - bbSpent : 0n;
                    const bbSpendable = bbRemaining < bbVault ? bbRemaining : bbVault;
                    const bbElapsed = Math.max(
                        0,
                        Math.floor(Date.now() / 1000) - Number(bn(statusNow.lastUpdatedTimestamp))
                    );
                    const slotNow = BigInt(await connection.getSlot());
                    const bbX =
                        slotNow ^ (bn(statusNow.tradingDayIndex) << 16n) ^ bn(ammState.bbSliceCount);
                    // Mirror the on-chain per-day hour-1 target (30–60%) and
                    // its derived per-slice weight; the tail keeps the
                    // 0.5x–1.5x spread.
                    let bbWeight: bigint;
                    let bbFactor: bigint;
                    if (bbElapsed < 3600) {
                        const mintBytes = afhoMint.toBytes();
                        const daySeed =
                            ((bn(statusNow.tradingDayIndex) * 0x9e37_79b9_7f4a_7c15n) &
                                0xffff_ffff_ffff_ffffn) ^
                            (BigInt(mintBytes[0]) << 56n) ^
                            (BigInt(mintBytes[31]) << 32n);
                        const hour1TargetBps = 3000n + (mix64(daySeed) % 3001n);
                        bbWeight = firstHourSliceWeightBps(hour1TargetBps);
                        bbFactor = 10000n;
                    } else {
                        bbWeight = 500n;
                        bbFactor = 5000n + (bbX % 10001n);
                    }
                    const estSlice = (bbSpendable * bbWeight * bbFactor) / 100_000_000n;
                    const estSliceCapped = estSlice > bbSpendable ? bbSpendable : estSlice;
                    const pacingLeft =
                        bn(ammState.bbLastSlot) > 0n &&
                        slotNow - bn(ammState.bbLastSlot) < BigInt(PACE_SLOTS)
                            ? Number(BigInt(PACE_SLOTS) - (slotNow - bn(ammState.bbLastSlot)))
                            : 0;
                    console.log(
                        `${evc(ANSI.blue, "dex_buyback")}budget=${fmtUsdc(bbBudget)} spent=${fmtUsdc(bbSpent)} ` +
                        `(${pctOf(bbSpent, bbBudget)} of budget) vault=${fmtUsdc(bbVault)} ` +
                        `est slice=${fmtUsdc(estSliceCapped)} (${pctOf(estSliceCapped, bbVault)} of vault)` +
                        `${pacingLeft ? `, pacing ${pacingLeft} slots` : ""}`
                    );
                    const bbIx = await ammProgram.methods
                        .dexBuyback()
                        .accountsStrict({
                            cranker: keypair.publicKey,
                            ammState: ammStatePda,
                            marketStatus: marketStatusPda,
                            usdcVault: ammState.usdcVault,
                            afhoVault: ammState.afhoVault,
                            afhoMint,
                            usdcMint,
                            ...cpmmAccountsFor(ammState, usdcMint),
                            tokenProgram: TOKEN_PROGRAM_ID,
                            token2022Program: TOKEN_2022_PROGRAM_ID,
                        })
                        .instruction();
                    const bbTx = await asV0Tx({
                        connection,
                        ixs: [bbIx],
                        signers: [keypair],
                        computeUnitPrice: 20_000,
                    });
                    const bbSim = await connection.simulateTransaction(bbTx);
                    if (bbSim.value.err) {
                        const bbReasons: Record<number, string> = {
                            6000: "unauthorized caller",
                            6001: "invalid market status",
                            6002: "market not open",
                            6003: "no offers taken last night — nothing to buy back",
                            6004: "slippage exceeded",
                            6005: "invalid oracle (or a Raydium CPI code propagated)",
                            6006: "CPMM pool account mismatch",
                            6007: "CPMM pool not pinned",
                        };
                        console.log(
                            `${skip(`dex_buyback skipped (${reason(bbSim.value.err, bbReasons)})`)}` +
                            `spendable=${fmtUsdc(bbSpendable)} (${pctOf(bbSpendable, bbVault)} of vault)`
                        );
                        console.log(`  ${ANSI.dim}${ANSI.gray}last logs:${ANSI.reset}`, bbSim.value.logs?.slice(-4) ?? []);
                    } else {
                        const bbSig = await connection.sendTransaction(bbTx);
                        await connection.confirmTransaction(bbSig, "confirmed");
                        const after = await (ammProgram.account as any).ammState.fetch(ammStatePda);
                        const spentDelta = bn(after.bbSpentUsdc) - bbSpent;
                        const bbVaultAfter = (await tokenAmount(ammState.usdcVault)) ?? 0n;
                        const bbAfhoAfter = (await tokenAmount(ammState.afhoVault)) ?? 0n;
                        console.log(
                            `${ev(ANSI.blue, "dex_buyback slice fired")} +${fmtUsdc(spentDelta)} ` +
                            `(${pctOf(spentDelta, bbVault)} of vault, ${pctOf(bn(after.bbSpentUsdc), bn(after.bbBudgetUsdc))} of budget) ` +
                            `+${fmtAfho(bbAfhoAfter - bbAfhoBefore)} → vault now=${fmtUsdc(bbVaultAfter)} — ${bbSig}`
                        );
                    }
                }
            } catch (e) {
                // Never let a buyback attempt kill the crank loop
                console.error(`${evc(ANSI.red, "!! dex_buyback attempt failed")}${(e as Error).message}`);
            }

            // buy_the_dip: attempt EVERY loop, any market state — the dip
            // buyer is always on. Calling it is also what keeps the spot-price
            // ring sampled. On-chain pacing + trigger turn most fires into
            // cheap no-ops; sim failures (cold start, no dip, day cap) are
            // expected.
            try {
                const ammState = await (ammProgram.account as any).ammState.fetch(ammStatePda);
                const usdcMint = new PublicKey(ammState.usdcMint);
                const dipMetrics = await (ammProgram.account as any).marketMetrics.fetch(metricsPda);
                const cp = cpmmAccountsFor(ammState, usdcMint);
                // Client-side mirror of the on-chain trigger, for the log:
                // spot ≈ pool vault ratio (the on-chain read prefers the TWAP
                // when fresh, so this can drift slightly — marked "≈").
                const afhoPool = (await tokenAmount(cp.cpmmOutputVault)) ?? 0n;
                const usdcPool = (await tokenAmount(cp.cpmmInputVault)) ?? 0n;
                const dipSpot = afhoPool > 0n && usdcPool > 0n ? (usdcPool * 1_000_000_000_000n) / afhoPool : null;
                const dipReserve = (await tokenAmount(ammState.usdcDip)) ?? 0n;
                const dipAfhoBefore = (await tokenAmount(ammState.afhoVault)) ?? 0n;
                const ring: bigint[] = (dipMetrics.spotPrices as unknown[]).map((v) => bn(v));
                let refSum = 0n;
                let dipSamples = 0;
                for (const p of ring) {
                    if (p > 0n) {
                        refSum += p;
                        dipSamples++;
                    }
                }
                const dipRef = dipSamples > 0 ? refSum / BigInt(dipSamples) : 0n;
                let dipDepthBps = 0n;
                if (dipSpot !== null && dipSamples >= 5 && dipRef > 0n && dipSpot < dipRef) {
                    dipDepthBps = ((dipRef - dipSpot) * 10_000n) / dipRef;
                }
                // trend slope (port of trend_slope_cp): recent-5 minus older-15
                // mean of the 20-day price_changes ring, ±1000 per sample, zeros skipped.
                const changes: number[] = (dipMetrics.priceChanges as unknown[]).map((v) => Number(v));
                const n = changes.length;
                const head = Number(bn(dipMetrics.sampleHead)) % n;
                let recentSum = 0;
                let recentN = 0;
                let olderSum = 0;
                let olderN = 0;
                for (let age = 0; age < n; age++) {
                    const raw = changes[(head + age) % n];
                    if (raw === 0) continue;
                    const v = Math.max(-1000, Math.min(1000, raw));
                    if (age >= n - 5) {
                        recentSum += v;
                        recentN++;
                    } else {
                        olderSum += v;
                        olderN++;
                    }
                }
                const dipSlope = (recentN ? recentSum / recentN : 0) - (olderN ? olderSum / olderN : 0);
                // spend bps (port of dip_spend_bps): 2500 × depth² × trend mult.
                let dipSpendBps = 0n;
                if (dipDepthBps >= 300n) {
                    const clamped = dipDepthBps > 1000n ? 1000n : dipDepthBps;
                    const depth2 = (clamped * clamped * 10_000n) / 1_000_000n;
                    const mult = Math.max(2500, Math.min(12500, 10000 + Math.trunc(dipSlope) * 10));
                    dipSpendBps = (2500n * depth2 * BigInt(mult)) / 100_000_000n;
                }
                const dipDayCap = (bn(ammState.dipDayUsdc) * 4000n) / 10_000n;
                const dipCapLeft = dipDayCap > bn(ammState.dipSpentUsdc) ? dipDayCap - bn(ammState.dipSpentUsdc) : 0n;
                const dipSliceRaw = (dipReserve * dipSpendBps) / 10_000n;
                const dipEstSlice = dipSliceRaw > dipCapLeft ? dipCapLeft : dipSliceRaw;
                const dipSlot = BigInt(await connection.getSlot());
                const dipPacingLeft =
                    bn(ammState.dipLastSlot) > 0n &&
                    dipSlot - bn(ammState.dipLastSlot) < BigInt(PACE_SLOTS)
                        ? Number(BigInt(PACE_SLOTS) - (dipSlot - bn(ammState.dipLastSlot)))
                        : 0;
                console.log(
                    `${evc(ANSI.yellow, "buy_the_dip")}reserve=${fmtUsdc(dipReserve)} dayBudget=${fmtUsdc(bn(ammState.dipDayUsdc))} ` +
                    `spent=${fmtUsdc(bn(ammState.dipSpentUsdc))} (${pctOf(bn(ammState.dipSpentUsdc), dipDayCap)} of 40% day cap) ` +
                    `spot≈${dipSpot !== null ? fmtPrice(dipSpot) : "—"} ref=${dipRef > 0n ? fmtPrice(dipRef) : "—"} ` +
                    `depth=${(Number(dipDepthBps) / 100).toFixed(2)}% (trigger 3%) samples=${dipSamples} slope=${Math.trunc(dipSlope)}cp ` +
                    `→ est slice=${fmtUsdc(dipEstSlice)} (${pctOf(dipEstSlice, dipReserve)} of reserve)` +
                    `${dipPacingLeft ? `, pacing ${dipPacingLeft} slots` : ""}`
                );
                const dipIx = await ammProgram.methods
                    .buyTheDip()
                    .accountsStrict({
                        cranker: keypair.publicKey,
                        ammState: ammStatePda,
                        marketStatus: marketStatusPda,
                        metrics: metricsPda,
                        usdcDip: ammState.usdcDip,
                        afhoVault: ammState.afhoVault,
                        afhoMint,
                        usdcMint,
                        ...cpmmAccountsFor(ammState, usdcMint),
                        tokenProgram: TOKEN_PROGRAM_ID,
                        token2022Program: TOKEN_2022_PROGRAM_ID,
                    })
                    .instruction();
                const dipTx = await asV0Tx({
                    connection,
                    ixs: [dipIx],
                    signers: [keypair],
                    computeUnitPrice: 20_000,
                });
                const dipSim = await connection.simulateTransaction(dipTx);
                if (dipSim.value.err) {
                    const dipReasons: Record<number, string> = {
                        6000: "unauthorized caller",
                        6001: "invalid market status",
                        6002: "invalid oracle (or a Raydium CPI code propagated)",
                        6003: "CPMM pool account mismatch",
                        6004: "CPMM pool not pinned",
                        6005: "Raydium ExceededSlippage propagated (see last logs)",
                        6006: "Raydium ZeroTradingTokens propagated (see last logs)",
                        6007: "Raydium NotSupportMint propagated (see last logs)",
                        6008: "Raydium InvalidVault propagated (see last logs)",
                    };
                    console.log(
                        `${skip(`buy_the_dip skipped (${reason(dipSim.value.err, dipReasons)})`)}` +
                        `reserve=${fmtUsdc(dipReserve)} est slice=${fmtUsdc(dipEstSlice)}`
                    );
                    console.log(`  ${ANSI.dim}${ANSI.gray}last logs:${ANSI.reset}`, dipSim.value.logs?.slice(-4) ?? []);
                } else {
                    const dipSig = await connection.sendTransaction(dipTx);
                    await connection.confirmTransaction(dipSig, "confirmed");
                    // NB: a successful tx is usually a no-op (ring sampling / no dip
                    // / pacing) — the on-chain trigger decides whether a slice is spent.
                    const after = await (ammProgram.account as any).ammState.fetch(ammStatePda);
                    const spentDelta = bn(after.dipSpentUsdc) - bn(ammState.dipSpentUsdc);
                    const dipReserveAfter = (await tokenAmount(ammState.usdcDip)) ?? 0n;
                    const dipAfhoAfter = (await tokenAmount(ammState.afhoVault)) ?? 0n;
                    if (spentDelta > 0n) {
                        console.log(
                            `${ev(ANSI.yellow, "buy_the_dip slice FIRED")} +${fmtUsdc(spentDelta)} ` +
                            `(${pctOf(spentDelta, dipReserve)} of reserve, ${pctOf(bn(after.dipSpentUsdc), dipDayCap)} of day cap) ` +
                            `+${fmtAfho(dipAfhoAfter - dipAfhoBefore)} → reserve now=${fmtUsdc(dipReserveAfter)} — ${dipSig}`
                        );
                    } else {
                        const noopWhy =
                            dipSamples < 5
                                ? `cold start (${dipSamples}/5 samples)`
                                : dipDepthBps < 300n
                                    ? `no dip (depth ${(Number(dipDepthBps) / 100).toFixed(2)}% < 3%)`
                                    : dipPacingLeft
                                        ? `pacing (${dipPacingLeft} slots left)`
                                        : "day cap reached / reserve empty";
                        console.log(`${skip(`buy_the_dip no-op (${noopWhy})`)} — ${dipSig}`);
                    }
                }
            } catch (e) {
                // Never let a dip attempt kill the crank loop
                console.error(`${evc(ANSI.red, "!! buy_the_dip attempt failed")}${(e as Error).message}`);
            }

            // bounty_top_up: attempt every loop — permissionless, and the
            // on-chain low-water check turns healthy vaults into a cheap no-op.
            try {
                const ammState = await (ammProgram.account as any).ammState.fetch(ammStatePda);
                const solUsdc = solUsdcAccountsFor(ammState);
                const afhoUsdc = cpmmAccountsFor(
                    ammState,
                    new PublicKey(ammState.usdcMint)
                );
                if (solUsdc && ammState.cpmmPoolState && !new PublicKey(ammState.cpmmPoolState).equals(PublicKey.default)) {
                    const usdcMint = new PublicKey(ammState.usdcMint);
                    const afhoMint = new PublicKey(ammState.afhoMint);
                    const wsolVault = getAssociatedTokenAddressSync(WSOL_MINT, ammStatePda, true);
                    // Amounts for the log: bounty balance, both pool prices
                    // (vault-ratio ≈), and the AFHO the top-up would sell.
                    const bountyBal = BigInt(await connection.getBalance(bountyVaultPda));
                    const afhoVaultBal = (await tokenAmount(ammState.afhoVault)) ?? 0n;
                    const afhoPoolRaw = (await tokenAmount(afhoUsdc.cpmmOutputVault)) ?? 0n;
                    const usdcPoolRaw = (await tokenAmount(afhoUsdc.cpmmInputVault)) ?? 0n;
                    const wsolPoolRaw = (await tokenAmount(solUsdc.solUsdcInputVault)) ?? 0n;
                    const solPoolUsdc = (await tokenAmount(solUsdc.solUsdcOutputVault)) ?? 0n;
                    const afhoPrice = afhoPoolRaw > 0n && usdcPoolRaw > 0n ? (usdcPoolRaw * 1_000_000_000_000n) / afhoPoolRaw : 0n;
                    const solPrice = wsolPoolRaw > 0n && solPoolUsdc > 0n ? (solPoolUsdc * 1_000_000_000_000n) / wsolPoolRaw : 0n;
                    // Bounty sizing mirrors the on-chain math (bounty_top_up):
                    // refill by TOPUP_PAYMENTS × bounty_usd when the vault's
                    // USDC value (at the pinned pool's SOL price) is at/below
                    // LOW_WATER_PAYMENTS × bounty_usd. bounty_usd_raw is u64 LE
                    // at offset 48..56 of the crank's BountyConfig.
                    const LOW_WATER_PAYMENTS = 10n;
                    const TOPUP_PAYMENTS = 10n;
                    const cfgInfo = await connection.getAccountInfo(bountyConfigPda);
                    const bountyUsd = cfgInfo && cfgInfo.data.length >= 56
                        ? cfgInfo.data.readBigUInt64LE(48)
                        : 0n;
                    const vaultUsdc = solPrice > 0n ? (bountyBal * solPrice) / 1_000_000_000_000n : 0n;
                    const payments = bountyUsd > 0n ? vaultUsdc / bountyUsd : 0n;
                    const neededLamports = solPrice > 0n ? (TOPUP_PAYMENTS * bountyUsd * 1_000_000_000_000n) / solPrice : 0n;
                    const usdcNeeded = solPrice > 0n ? (neededLamports * solPrice * 10_025n) / 1_000_000_000_000n / 10_000n : 0n;
                    const afhoIn = afhoPrice > 0n ? (usdcNeeded * 1_000_000_000_000n * 10_025n) / afhoPrice / 10_000n : 0n;
                    console.log(
                        `${evc(ANSI.brightBlue, "bounty_top_up")}bounty=${fmtSolL(bountyBal)} ≈${payments} payments (${fmtUsdc(vaultUsdc)}) ` +
                        `afho_price=${afhoPrice > 0n ? fmtPrice(afhoPrice) : "—"} sol_price=${solPrice > 0n ? fmtPrice(solPrice) : "—"} ` +
                        `→ refill +${TOPUP_PAYMENTS} payments (${fmtUsdc(usdcNeeded)}) when ≤${LOW_WATER_PAYMENTS} ` +
                        `est AFHO sold=${fmtAfho(afhoIn)} (${pctOf(afhoIn, afhoVaultBal)} of afho_vault)`
                    );
                    const topupIx = await ammProgram.methods
                        .bountyTopUp()
                        .accountsStrict({
                            cranker: keypair.publicKey,
                            ammState: ammStatePda,
                            bountyVault: bountyVaultPda,
                            bountyConfig: bountyConfigPda,
                            afhoVault: ammState.afhoVault,
                            usdcVault: ammState.usdcVault,
                            afhoMint,
                            usdcMint,
                            wsolVault,
                            wrappedSolMint: WSOL_MINT,
                            cpmmPoolState: afhoUsdc.cpmmPoolState,
                            cpmmAmmConfig: afhoUsdc.cpmmAmmConfig,
                            cpmmInputVault: afhoUsdc.cpmmInputVault,
                            cpmmOutputVault: afhoUsdc.cpmmOutputVault,
                            cpmmObservation: afhoUsdc.cpmmObservation,
                            cpmmAuthority: afhoUsdc.cpmmAuthority,
                            cpmmProgram: afhoUsdc.cpmmProgram,
                            ...solUsdc,
                            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
                            tokenProgram: TOKEN_PROGRAM_ID,
                            token2022Program: TOKEN_2022_PROGRAM_ID,
                            systemProgram: anchor.web3.SystemProgram.programId,
                        })
                        .instruction();
                    const topupTx = await asV0Tx({
                        connection,
                        ixs: [topupIx],
                        signers: [keypair],
                        computeUnitPrice: 20_000,
                    });
                    const topupSim = await connection.simulateTransaction(topupTx);
                    if (topupSim.value.err) {
                        const topupReasons: Record<number, string> = {
                            6000: "invalid pool price oracle",
                            6001: "AFHO/USDC or SOL/USDC pool not pinned",
                            6002: "computed AFHO amount is zero",
                            6003: "treasury AFHO too low to top up",
                            6004: "CPMM pool account mismatch",
                            6005: "AFHO→USDC swap returned nothing (or a Raydium CPI code propagated)",
                            6006: "math overflow",
                        };
                        console.log(
                            `${skip(`bounty_top_up skipped (${reason(topupSim.value.err, topupReasons)})`)}` +
                            `bounty=${fmtSolL(bountyBal)} est AFHO=${fmtAfho(afhoIn)} (${pctOf(afhoIn, afhoVaultBal)} of afho_vault)`
                        );
                        console.log(`  ${ANSI.dim}${ANSI.gray}last logs:${ANSI.reset}`, topupSim.value.logs?.slice(-4) ?? []);
                    } else if (bountyUsd > 0n && vaultUsdc > LOW_WATER_PAYMENTS * bountyUsd) {
                        // Simulation passed because the on-chain low-water check
                        // no-ops — don't spend a tx on a healthy vault.
                        console.log(`${skip(`bounty_top_up no-op (vault healthy: ${payments} payments > ${LOW_WATER_PAYMENTS} low water)`)}`);
                    } else {
                        const topupSig = await connection.sendTransaction(topupTx);
                        await connection.confirmTransaction(topupSig, "confirmed");
                        const bountyAfter = BigInt(await connection.getBalance(bountyVaultPda));
                        console.log(
                            `${ev(ANSI.brightBlue, "bounty_top_up fired")} bounty ${fmtSolL(bountyBal)} → ${fmtSolL(bountyAfter)} ` +
                            `(+${fmtSolL(bountyAfter - bountyBal)} SOL, sold ≈${fmtAfho(afhoIn)} AFHO = ${pctOf(afhoIn, afhoVaultBal)} of afho_vault) — ${topupSig}`
                        );
                    }
                }
            } catch (e) {
                console.error(`${evc(ANSI.red, "!! bounty_top_up attempt failed")}${(e as Error).message}`);
            }
        } catch (e) {
            console.error(`${evc(ANSI.red, "!! Crank attempt failed")}${e}`);
        }

        await sleep(sleepMs);
    }
}

function sleep(ms: number) {
    return new Promise((r) => setTimeout(r, ms));
}

// Mirror of dex_buyback.rs's per-day hour-1 target → per-slice weight
// conversion (first_hour_slice_weight_bps). Est-slice logging only.
function mix64(x: bigint): bigint {
    let h = x & 0xffff_ffff_ffff_ffffn;
    h ^= h >> 29n;
    h = (h * 0xbf58_476d_1ce4_e5b9n) & 0xffff_ffff_ffff_ffffn;
    h ^= h >> 32n;
    return h;
}

function firstHourSliceWeightBps(hour1TargetBps: bigint): bigint {
    // -ln(1-F) scaled by 1e12, F = hour1TargetBps / 10_000.
    const f = hour1TargetBps;
    let term = f * 100_000_000n; // F × 1e12
    let ln = 0n;
    for (let k = 1n; k <= 8n && term > 0n; k += 1n) {
        ln += term / k;
        term = (term * f) / 10_000n;
    }
    return (ln * 10_000n) / (60n * 1_000_000_000_000n);
}

// ── Slot-time assumption watch ─────────────────────────────────────────────
// All on-chain pacing (MIN_SLICE_SLOTS / DIP_MIN_SLICE_SLOTS / SPOT_SAMPLE_SLOTS)
// derives from NOMINAL_SLOT_MS in dex_buyback.rs at compile time; this is the
// keeper-side mirror (PACE_SLOTS). ACTIVE: 200ms (2026-09-09 — baked the
// floor of SIMD-0525's staged 400→200 plan so the program can be finalized
// immediately; see dex_buyback.rs + MAINNET_CHECKLIST.md 2026-09-08 pass).
// While mainnet runs slower than 200ms, pacing runs SLOWER than design
// (400ms-real → 120s/slice), the conservative direction; devnet's ~167ms
// today → ~50s/slice, slightly hot but bounded. This log prints the chain's
// MEASURED slot time (getRecentPerformanceSamples) against the active
// assumption every ~5 min so the transition is visible as it lands.
const NOMINAL_SLOT_MS = 200; // mirrors dex_buyback.rs — 2026-09-09 decision
const PACE_SLOTS = 60_000 / NOMINAL_SLOT_MS; // 300 slots ≈ 60s @ 200ms — mirrors MIN_SLICE_SLOTS
let lastSlotTimeCheck = 0;
async function logSlotTimeOnce(connection: anchor.web3.Connection) {
    const now = Date.now();
    if (now - lastSlotTimeCheck < 300_000) return;
    lastSlotTimeCheck = now;
    try {
        const samples = await connection.getRecentPerformanceSamples(3);
        if (samples.length < 2) return;
        const span = samples[0].slot - samples[samples.length - 1].slot;
        const secs = samples.reduce((acc, s) => acc + s.samplePeriodSecs, 0);
        if (span > 0) {
            const msPerSlot = (secs * 1000) / span;
            console.log(
                `${skip("slot time")}~${msPerSlot.toFixed(0)}ms/slot measured vs ${NOMINAL_SLOT_MS}ms ` +
                    `assumed for pacing constants (MIN_SLICE = ${PACE_SLOTS} slots ≈ 60s)`
            );
        }
    } catch {
        // informational only — perf samples unavailable on this RPC
    }
}

main();