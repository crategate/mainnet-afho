import { useCallback, useState } from 'react';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { BN } from '@coral-xyz/anchor';
import { ComputeBudgetProgram, PublicKey, SendTransactionError, SystemProgram, Transaction, TransactionMessage, VersionedTransaction, AddressLookupTableAccount, type TransactionInstruction } from '@solana/web3.js';
import {
    ASSOCIATED_TOKEN_PROGRAM_ID,
    getAccount,
    getAssociatedTokenAddressSync,
    TOKEN_2022_PROGRAM_ID,
    TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { STAKING_PROGRAM_ID, useAmmProgram } from '../../anchor/setup.ts';
import { formatSol, formatUsdc, lamportsForCost, lamportsForCostExact } from './offerMath.ts';
import type { ClaimAccounts, SolClaimAccounts } from './useAmmData.ts';
import {
    V1_CLAIM_CU_LIMIT,
    V1_CLAIM_DATA_SIZE_LIMIT,
    V1_SOL_CLAIM,
    buildV1MessageBytes,
    estimateMicroLamportsPerCu,
    estimateV1PriorityFeeLamports,
    sendV1Transaction,
    signV1Message,
    simulateV1Transaction,
} from '../../sdk/v1Transaction.ts';

export interface ClaimSelection {
    tier: number;   // 0 = sml, 1 = med, 2 = big
    units: number;
}

export type ClaimCurrency = 'usdc' | 'sol';

export type ClaimStatus = 'idle' | 'pending' | 'success' | 'error';

export interface UseOfferClaimReturn {
    claim: (
        selections: ClaimSelection[],
        estCostRaw: bigint,
        opts: {
            currency: ClaimCurrency;
            solPrice: bigint | null;
            solPoolReserves?: { wsolRaw: bigint; usdcRaw: bigint } | null;
            claimLookupTable?: string | null;
        },
    ) => Promise<boolean>;
    status: ClaimStatus;
    txSig: string | null;
    error: string | null;
    reset: () => void;
}

// One claim instruction per selected tier, bundled into a single transaction
// (one wallet prompt). Each claim creates a new staking position, so the
// position index increments per instruction starting from the buyer's
// next_index (LE u64 at offset 8 of the user_index account; 0 if it doesn't
// exist yet — create_amm_position inits it via CPI).
//
// Payment currency: 'usdc' → offer_claim (buyer's USDC ATA). 'sol' →
// offer_claim_sol (buyer lamports → wSOL → CPMM swap to USDC, buyer covers the
// 0.25% swap fee; requires the pinned SOL/USDC pool = solAccounts).
export function useOfferClaim(
    accounts: ClaimAccounts | null,
    solAccounts: SolClaimAccounts | null,
    usdcDecimals: number,
    altMode = false,
): UseOfferClaimReturn {
    const { connection } = useConnection();
    const { wallet } = useWallet();
    const program = useAmmProgram();
    const [status, setStatus] = useState<ClaimStatus>('idle');
    const [txSig, setTxSig] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    const reset = useCallback(() => {
        setStatus('idle');
        setTxSig(null);
        setError(null);
    }, []);

    const claim = useCallback(async (
        selections: ClaimSelection[],
        estCostRaw: bigint,
        opts: {
            currency: ClaimCurrency;
            solPrice: bigint | null;
            solPoolReserves?: { wsolRaw: bigint; usdcRaw: bigint } | null;
            claimLookupTable?: string | null;
        },
    ): Promise<boolean> => {
        if (!program || !accounts) return false;
        const active = selections.filter((s) => s.units > 0);
        if (active.length === 0) return false;

        setStatus('pending');
        setTxSig(null);
        setError(null);
        try {
            const buyer = program.provider.publicKey;
            const sendAndConfirm = program.provider.sendAndConfirm?.bind(program.provider);
            if (!buyer || !sendAndConfirm) throw new Error('Wallet not connected');

            const currency = opts.currency;
            // Captured parameter — copy to a local so TS can narrow it below.
            const sol = solAccounts;
            if (currency === 'sol' && !sol) {
                throw new Error('SOL payments need the SOL/USDC pool pinned — run anchor run set-sol-usdc-pool.');
            }

            // ── balance gate ──
            if (currency === 'usdc') {
                const buyerUsdc = getAssociatedTokenAddressSync(accounts.usdcMint, buyer, false, TOKEN_PROGRAM_ID);
                let balance: bigint;
                try {
                    balance = (await getAccount(connection, buyerUsdc, 'confirmed', TOKEN_PROGRAM_ID)).amount;
                } catch {
                    throw new Error('No USDC token account found — fund this wallet with devnet USDC first.');
                }
                if (balance < estCostRaw) {
                    throw new Error(
                        `Insufficient USDC: need ≈${formatUsdc(estCostRaw, usdcDecimals)}, have ${formatUsdc(balance, usdcDecimals)}.`
                    );
                }
            } else {
                if (!sol) {
                    throw new Error('SOL payments need the SOL/USDC pool pinned — run anchor run set-sol-usdc-pool.');
                }
                if (!opts.solPrice || opts.solPrice <= 0n) {
                    throw new Error('SOL price unavailable — cannot estimate the SOL cost.');
                }
                // Mirror the on-chain charge exactly: offer_claim_sol solves
                // its wSOL input from the SOL/USDC pool's live reserves
                // (cpmm_swap_input_for_out). With reserves loaded the
                // estimate IS the charge (until they move); a null solve is
                // the on-chain InsufficientPoolLiquidity revert — surface it
                // here instead of failing at the wallet prompt.
                const exact = lamportsForCostExact(estCostRaw, opts.solPoolReserves);
                if (opts.solPoolReserves && exact === null) {
                    throw new Error(
                        'SOL/USDC pool cannot serve this order — its USDC reserve is smaller than the order cost. Try a smaller order or wait for the pool to be re-seeded.'
                    );
                }
                const lamportsEst = exact ?? lamportsForCost(estCostRaw, opts.solPrice);
                const haveLamports = await connection.getBalance(buyer);
                if (BigInt(haveLamports) < lamportsEst) {
                    throw new Error(
                        `Insufficient SOL: need ≈${formatSol(lamportsEst)} SOL, have ${formatSol(BigInt(haveLamports))} SOL.`
                    );
                }
            }

            // ── Pre-flight the on-chain gates against FRESH state ──
            // The wallet's preflight simulation runs the real claim logic,
            // whose gates (DeskClosed / StaleOfferSheet / InsufficientOffer)
            // read the market-status PDA and the sheet AT EXECUTION TIME. The
            // UI's polled snapshot can be stale at click time (in watch mode
            // the state only moves on a manual set-oracle flip), so a click
            // that passed the UI gate can still fail the wallet's simulation — and the wallet's
            // immediate "try again" re-simulates the SAME transaction, failing
            // again. Re-read both accounts here and fail with an actionable
            // message instead of a raw simulation error.
            const statusInfo = await connection.getAccountInfo(accounts.marketStatus);
            const onChainState = statusInfo && statusInfo.data.length >= 9 ? statusInfo.data[8] : 99;
            if (altMode) {
                // Alt desk: claimable ONLY in the suspended state (3) — the
                // mirror of alt_offers::quote_alt_claim's NotActive gate.
                if (onChainState !== 3) {
                    throw new Error(
                        'This offer window just closed — it only exists while the market is suspended. '
                    );
                }
            } else if (onChainState !== 1 && onChainState !== 2) {
                throw new Error(
                    `The desk just closed (market state ${onChainState}) — offers are claimable in ` +
                        'after-hours (1) and closed (2) sessions only. Try again once the state cycles back.'
                );
            }
            // Alt desk uses its own sheet account (same layout, separate PDA).
            const sheetKey = altMode
                ? PublicKey.findProgramAddressSync(
                      [Buffer.from('alt_offer_list'), accounts.afhoMint.toBuffer()],
                      program.programId,
                  )[0]
                : accounts.offerList;
            const freshSheet = (await (program.account as unknown as {
                offerList: { fetch: (key: PublicKey) => Promise<unknown> };
            }).offerList.fetch(sheetKey)) as unknown as Record<string, unknown>;
            const tierNames = ['sml', 'med', 'big'] as const;
            for (const s of active) {
                const name = tierNames[s.tier];
                const offer = (freshSheet[`${name}Offer`] ?? freshSheet[`${name}_offer`]) as
                    | { remaining: number }
                    | undefined;
                const remaining = offer ? Number(offer.remaining) : 0;
                if (remaining < s.units) {
                    throw new Error(
                        `Only ${remaining} lot(s) remain in that tier — someone claimed while you were checking out. Pick a smaller amount or another tier.`
                    );
                }
            }

            const [userIndexPda] = PublicKey.findProgramAddressSync(
                [Buffer.from('user_index'), buyer.toBuffer()], STAKING_PROGRAM_ID
            );
            let nextIndex = 0n;
            const userIndexInfo = await connection.getAccountInfo(userIndexPda);
            if (userIndexInfo && userIndexInfo.data.length >= 16) {
                nextIndex = new DataView(userIndexInfo.data.buffer, userIndexInfo.data.byteOffset)
                    .getBigUint64(8, true);
            }

            const tx = new Transaction();
            // Priority fee (helius skill: estimate from live data, never
            // hardcode). One fetch feeds the ComputeBudget price for the
            // legacy/v0 paths AND the v1 config total-lamports field.
            const priorityAccountKeys = [
                buyer.toBase58(),
                accounts.ammState.toBase58(),
                accounts.marketStatus.toBase58(),
            ];
            let microLamportsPerCu = 1;
            try {
                microLamportsPerCu = await estimateMicroLamportsPerCu(connection, priorityAccountKeys);
            } catch {
                // fee estimation is best-effort — floor at 1 microLamport/CU
            }
            // Bake a FINALIZED blockhash + fee payer here rather than letting
            // the wallet fill them: wallets preflight against their OWN RPC
            // node, and a blockhash fetched at `confirmed` can be a slot or
            // two ahead of that node — the wallet's simulation then dies
            // with a raw BlockhashNotFound (bright red in Backpack) even
            // though the transaction is perfect. A finalized blockhash is
            // known to every node in the cluster. Fees bill consumed CU, not
            // the limit — the ceiling is free.
            tx.feePayer = buyer;
            tx.recentBlockhash = (await connection.getLatestBlockhash('finalized')).blockhash;
            // Raise the CU ceiling: a transaction with no compute-budget
            // instruction defaults to 200k CU per instruction.
            tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: microLamportsPerCu }));
            tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 }));
            // Chunking: the USDC instruction is ~950 bytes, so all tiers fit in
            // one transaction. A single SOL instruction is ~1180 bytes (+33 for
            // the CPMM program remaining account), so two would exceed the
            // 1232-byte packet limit — SOL claims go out as one transaction per
            // tier (one wallet prompt each).
            const txs: (Transaction | VersionedTransaction)[] = currency === 'usdc' ? [tx] : [];
            const solIxs: TransactionInstruction[] = [];
            for (let i = 0; i < active.length; i++) {
                const { tier, units } = active[i];
                const index = nextIndex + BigInt(i);
                const [stakePositionPda] = PublicKey.findProgramAddressSync(
                    [
                        Buffer.from('position'),
                        accounts.stakingPool.toBuffer(),
                        buyer.toBuffer(),
                        new BN(index.toString()).toArrayLike(Buffer, 'le', 8),
                    ],
                    STAKING_PROGRAM_ID
                );
                if (currency === 'usdc') {
                    const buyerUsdc = getAssociatedTokenAddressSync(accounts.usdcMint, buyer, false, TOKEN_PROGRAM_ID);
                    const claimMethod = altMode
                        ? program.methods.altOfferClaim(tier, units, new BN(index.toString()))
                        : program.methods.offerClaim(tier, units, new BN(index.toString()));
                    tx.add(
                        await claimMethod
                            .accounts({
                                buyer,
                                ammState: accounts.ammState,
                                // Alt desk claims read the alt sheet account.
                                ...(altMode
                                    ? { altList: sheetKey }
                                    : { offerList: accounts.offerList }),
                                afhoMint: accounts.afhoMint,
                                usdcMint: accounts.usdcMint,
                                marketStatus: accounts.marketStatus,
                                buyerUsdc,
                                ammUsdcVault: accounts.ammUsdcVault,
                                usdcDip: accounts.usdcDip,
                                usdcRewards: accounts.usdcRewards,
                                cpmmPoolState: accounts.cpmmPoolState,
                                cpmmObservation: accounts.cpmmObservation,
                                cpmmInputVault: accounts.cpmmInputVault,
                                cpmmOutputVault: accounts.cpmmOutputVault,
                                stakingProgram: STAKING_PROGRAM_ID,
                                stakingPool: accounts.stakingPool,
                                userIndex: userIndexPda,
                                stakePosition: stakePositionPda,
                                ammAfhoVault: accounts.ammAfhoVault,
                                stakingVault: accounts.stakingVault,
                                tokenProgram: TOKEN_PROGRAM_ID,
                                token2022Program: TOKEN_2022_PROGRAM_ID,
                                systemProgram: SystemProgram.programId,
                            })
                            .instruction()
                    );
                } else {
                    if (!sol) {
                        throw new Error('SOL payments need the SOL/USDC pool pinned — run anchor run set-sol-usdc-pool.');
                    }
                    const solMethod = altMode
                        ? program.methods.altOfferClaimSol(tier, units, new BN(index.toString()))
                        : program.methods.offerClaimSol(tier, units, new BN(index.toString()));
                    const solIx = await solMethod
                        .accounts({
                            buyer,
                            ammState: accounts.ammState,
                            // Alt desk claims read the alt sheet account.
                            ...(altMode
                                ? { altList: sheetKey }
                                : { offerList: accounts.offerList }),
                            afhoMint: accounts.afhoMint,
                            usdcMint: accounts.usdcMint,
                            marketStatus: accounts.marketStatus,
                            usdcVault: accounts.ammUsdcVault,
                            usdcDip: accounts.usdcDip,
                            usdcRewards: accounts.usdcRewards,
                            wsolVault: sol.wsolVault,
                            wrappedSolMint: sol.wrappedSolMint,
                            solUsdcPoolState: sol.solUsdcPoolState,
                            solUsdcAmmConfig: sol.solUsdcAmmConfig,
                            solUsdcInputVault: sol.solUsdcInputVault,
                            solUsdcOutputVault: sol.solUsdcOutputVault,
                            solUsdcObservation: sol.solUsdcObservation,
                            solUsdcAuthority: sol.solUsdcAuthority,
                            stakingProgram: STAKING_PROGRAM_ID,
                            stakingPool: accounts.stakingPool,
                            userIndex: userIndexPda,
                            stakePosition: stakePositionPda,
                            ammAfhoVault: accounts.ammAfhoVault,
                            stakingVault: accounts.stakingVault,
                            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
                            tokenProgram: TOKEN_PROGRAM_ID,
                            token2022Program: TOKEN_2022_PROGRAM_ID,
                            systemProgram: SystemProgram.programId,
                            // Pool-only pricing: the pinned-pool accounts are
                            // the only price sources (the mock oracles are gone
                            // from the program). Anchor optional accounts must
                            // still be passed, and programId is the sentinel
                            // that means "omitted". Because they live at the
                            // end of the account list, the sentinel does not
                            // shift any required account.
                            cpmmPoolState: accounts.cpmmPoolState,
                            cpmmObservation: accounts.cpmmObservation,
                            cpmmInputVault: accounts.cpmmInputVault,
                            cpmmOutputVault: accounts.cpmmOutputVault,
                        })
                        // The program CPIs the wSOL→USDC swap into
                        // amm_state.cpmm_program (Raydium CPMM). Solana's
                        // runtime refuses a CPI unless the callee program id
                        // is itself among the caller instruction's accounts
                        // (otherwise: "Unknown program DRay…" +
                        // "An account required by the instruction is missing").
                        // The deployed amm program has no struct slot for it,
                        // so pass it as a read-only remaining account — it is
                        // appended after the optional-account sentinels and
                        // never consumed by Anchor's account deserializer.
                        .remainingAccounts([
                            {
                                pubkey: sol.cpmmProgram,
                                isSigner: false,
                                isWritable: false,
                            },
                        ])
                        .instruction();
                    // ── v0 + address lookup table when available ──────────
                    // The legacy SOL claim tx is ~1213 bytes — 19 under the
                    // packet limit — so it cannot carry a compute-budget
                    // instruction and runs on the 200k CU default while
                    // consuming ~150-165k (measured on devnet: 153-163k).
                    // With the claim ALT (scripts/launch/create-claim-alt.ts) the
                    // same instruction rides a v0 message at ~484 bytes,
                    // freeing room for setComputeUnitLimit(400_000) —
                    // ~2.4× observed consumption, so the sim and the send
                    // agree. The blockhash is taken at `finalized` (see the
                    // USDC branch above): wallets preflight against their
                    // own RPC, and a too-fresh blockhash fails that sim
                    // with BlockhashNotFound before the buyer can even
                    // decide.
                    solIxs.push(solIx);
                    const solTx = new Transaction();
                    solTx.add(solIx);
                    solTx.feePayer = buyer;
                    solTx.recentBlockhash = tx.recentBlockhash;
                    let pushed = false;
                    if (opts.claimLookupTable) {
                        let lookup: AddressLookupTableAccount | null = null;
                        // One retry on a transient RPC error before falling
                        // back: the legacy tx cannot carry a CU instruction
                        // (it sits ~19 bytes under the 1232-byte packet limit),
                        // so the fallback is a strictly worse simulation
                        // profile, not a stylistic choice — and it has no room
                        // for a priority-fee instruction either.
                        for (let attempt = 0; attempt < 2 && !lookup; attempt++) {
                            try {
                                lookup = (await connection.getAddressLookupTable(
                                    new PublicKey(opts.claimLookupTable), { commitment: 'confirmed' }
                                )).value ?? null;
                            } catch {
                                // Transient — retry, else legacy fallback.
                            }
                        }
                        if (lookup) {
                            // Per-tx fresh finalized blockhash: three popups
                            // means the last tx is approved tens of seconds
                            // after the first was compiled, and a blockhash
                            // is only valid ~150 slots. Fall back to the
                            // earlier fetch if this one fails.
                            let blockhash = tx.recentBlockhash;
                            try {
                                blockhash = (await connection.getLatestBlockhash('finalized')).blockhash;
                            } catch {
                                // keep the earlier finalized hash
                            }
                            const msg = new TransactionMessage({
                                payerKey: buyer,
                                recentBlockhash: blockhash,
                                instructions: [
                                    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: microLamportsPerCu }),
                                    ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
                                    solIx,
                                ],
                            }).compileToV0Message([lookup]);
                            txs.push(new VersionedTransaction(msg));
                            pushed = true;
                        }
                    }
                    if (!pushed) txs.push(solTx);
                }
            }

            // ── v1 single-tx SOL claim (SIMD-0385) ──────────────────────────
            // One v1 transaction carries every SOL tier (3 instructions ≈
            // 1.5–2KB < 4096, no ALT, explicit CU + data-size limits and the
            // priority fee in the transaction config) → one wallet prompt
            // instead of one per tier. Signing covers the message bytes via
            // the wallet's signMessage, so no wallet v1 support is required.
            // Built + dry-run FIRST: a null sim (RPC refused v1) or a sim
            // error (desk closed, floor held, …) falls back to the v0+ALT
            // txs above, whose preflight surfaces the same readable errors.
            const adapter = wallet?.adapter as unknown as {
                signMessage?: (m: Uint8Array) => Promise<Uint8Array>;
            } | null;
            const signMessage = adapter?.signMessage
                ? adapter.signMessage.bind(adapter)
                : undefined;
            let v1Message: Uint8Array | null = null;
            if (currency === 'sol' && solIxs.length > 0 && V1_SOL_CLAIM && signMessage) {
                try {
                    const v1Blockhash = (await connection.getLatestBlockhash('finalized')).blockhash;
                    const v1Fee = await estimateV1PriorityFeeLamports(connection, priorityAccountKeys);
                    const msg = buildV1MessageBytes({
                        feePayer: buyer,
                        recentBlockhash: v1Blockhash,
                        instructions: solIxs,
                        config: {
                            priorityFeeLamports: v1Fee,
                            computeUnitLimit: V1_CLAIM_CU_LIMIT,
                            loadedAccountsDataSizeLimit: V1_CLAIM_DATA_SIZE_LIMIT,
                        },
                    });
                    const sim = await simulateV1Transaction(connection, msg);
                    if (sim !== null && !sim.err) {
                        v1Message = msg;
                    }
                } catch {
                    v1Message = null; // any v1-specific failure → v0+ALT path
                }
            }

            // One wallet prompt per transaction — each dry-run FIRST. The
            // wallet (Backpack, Phantom) preflights the SAME transaction
            // against its own RPC and paints a bright red simulation-failed
            // box when that fails, with no explanation in the popup. Running
            // the simulation here, against this cluster, catches every real
            // failure (desk closed, sheet stale, floor held, lots taken, CU
            // budget) with an actionable message BEFORE the wallet opens, and
            // guarantees the wallet only ever sees transactions that already
            // pass. The loop is sequential (sendAndConfirm awaits each tx),
            // so the later SOL txs' preflights run after the earlier
            // positions landed — their indices exist by then.
            const preflight = async (t: Transaction | VersionedTransaction): Promise<void> => {
                // web3.js takes a SimulateTransactionConfig only on the
                // versioned overload, so legacy transactions ride a synthetic
                // v0 message for the dry run — identical instructions and
                // accounts, no ALTs.
                let vt: VersionedTransaction;
                if (t instanceof VersionedTransaction) {
                    vt = t;
                } else {
                    if (!t.feePayer || !t.recentBlockhash) return; // cannot compile — the wallet still preflights on submit
                    vt = new VersionedTransaction(new TransactionMessage({
                        payerKey: t.feePayer,
                        recentBlockhash: t.recentBlockhash,
                        instructions: t.instructions,
                    }).compileToV0Message([]));
                }
                let sim;
                try {
                    sim = await connection.simulateTransaction(vt, { sigVerify: false, replaceRecentBlockhash: true });
                } catch {
                    // Our RPC refused the dry run (rate limit / outage) — do
                    // not block the claim on our own infrastructure; the
                    // wallet still preflights on submit.
                    return;
                }
                if (sim.value.err) {
                    const logs = sim.value.logs ?? [];
                    const headline = logs.find((l) => l.includes('Error Code') || l.includes('Error Message') || l.includes('failed'))
                        ?? `Simulation failed: ${JSON.stringify(sim.value.err)}`;
                    // Translate the price-gate reverts into the same language
                    // the desk tiles use (singleOffer's floor-held note) —
                    // the buyer should never have to parse program logs to
                    // learn the desk went dark between page load and click.
                    const friendly = /FloorHeldAtSpot|floor holds|no discount available/.test(headline)
                        ? 'Buyback floor is at/above the live pool price — this offer is no longer below spot. The desk resumes when the floor decays or the pool price recovers.'
                        : /DeskClosed|state 1 or 2|desk trades at night/.test(headline)
                            ? 'Desk closed — bond sales only run in the after-hours and closed sessions.'
                            : /StaleOfferSheet|only tonight's sheet/.test(headline)
                                ? 'Offer sheet expired — waiting for tonight\'s new sheet.'
                                : null;
                    throw new Error(
                        (friendly ? `${friendly} ` : '') +
                        `Dry run failed — nothing was signed or spent. ${headline}` +
                        (logs.length ? `\n\nLogs:\n${logs.join('\n')}` : '')
                    );
                }
            };
            let lastSig: string | null = null;
            if (v1Message && signMessage) {
                // One prompt: the wallet signs the v1 message bytes, the
                // signature is appended, and the raw tx goes out (the dry
                // run above already passed against this cluster).
                const signed = await signV1Message(v1Message, signMessage);
                lastSig = await sendV1Transaction(connection, signed);
                await connection.confirmTransaction(lastSig, 'confirmed');
            } else {
                for (const t of txs) {
                    await preflight(t);
                    lastSig = await sendAndConfirm(t);
                }
            }
            if (!lastSig) throw new Error('Claim produced no transactions');
            setTxSig(lastSig);
            setStatus('success');
            return true;
        } catch (err) {
            let message = err instanceof Error ? err.message : 'Claim transaction failed';
            // Anchor/Solana transaction errors carry simulator logs; surface them
            // so the UI shows the same detail the wallet would show on simulation.
            if (err instanceof SendTransactionError) {
                try {
                    const logs = await err.getLogs(connection);
                    if (logs && logs.length > 0) {
                        message = `${message}\n\nLogs:\n${logs.join('\n')}`;
                    }
                } catch {
                    // getLogs can fail if the connection is gone; keep the original message.
                }
            } else if (
                err &&
                typeof err === 'object' &&
                'logs' in err &&
                Array.isArray((err as { logs: string[] }).logs)
            ) {
                const logs = (err as { logs: string[] }).logs;
                message = `${message}\n\nLogs:\n${logs.join('\n')}`;
            }
            setError(message);
            setStatus('error');
            return false;
        }
    }, [program, accounts, solAccounts, connection, usdcDecimals, wallet]);

    return { claim, status, txSig, error, reset };
}
