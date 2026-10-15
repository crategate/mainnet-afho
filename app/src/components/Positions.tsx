import { useEffect, useMemo, useState } from 'react';
import { usePositions } from '../hooks/stake/usePositions';
import { usePositionRewards } from '../hooks/stake/usePositionRewards';
import type { EnrichedPosition } from '../hooks/stake/usePositionRewards';
import { useClaimAll } from '../hooks/stake/useClaimAll';
import { useMarketStatus } from '../hooks/useMarketStatus';
import { useUnstake } from '../hooks/stake/useUnstake';
import { Snowflake } from './Snowflake';
import { useFreeze } from '../hooks/stake/useFreeze';
import { usePool } from '../hooks/stake/usePool';
import { PublicKey } from '@solana/web3.js';
import { useConnection } from '@solana/wallet-adapter-react';
import { AMM_PROGRAM_ID } from '../anchor/setup';
import { freezeBonusBps, freezeQuote } from '../lib/freezeCurve';
import type { FreezeParamsLike } from '../lib/freezeCurve';
import { useTxResult } from '../context/TxResultProvider';
import { WalletMark } from './WalletMark';

interface PositionsProps {
    mint: PublicKey;
    marketStatusPda?: PublicKey;
}

// The momentum scalar lives at ACCOUNT offset 360 of the amm's metrics PDA
// (cross-program layout contract — see offers_state.rs).
const METRICS_MOMENTUM_OFFSET = 8 + 352;

export function Positions({ mint, marketStatusPda }: PositionsProps) {
    const { positions, loading: positionsLoading, refresh: refreshPositions } = usePositions(mint);
    const { data: marketData } = useMarketStatus(marketStatusPda);
    const { pool } = usePool(mint);
    const { enriched, claimableTotal, vestingTotal, vestingCount } = usePositionRewards(mint, positions, marketStatusPda);
    const { claimAll, loading: claimLoading } = useClaimAll(mint, positions, marketStatusPda);
    const { unstake, loadingIndex: unstakeLoadingIndex } = useUnstake(mint, marketStatusPda, marketData?.state, pool);
    const { freeze, loadingIndex: freezeLoadingIndex } = useFreeze(mint, marketStatusPda);
    const { connection } = useConnection();
    const reportTx = useTxResult();
    const claimsOpen = marketData?.state === 0;

    // ── Freeze modal state ──
    const [freezeTarget, setFreezeTarget] = useState<EnrichedPosition | null>(null);
    const [freezeDays, setFreezeDays] = useState(0);
    const [momentum, setMomentum] = useState<number | null>(null);
    const [freezing, setFreezing] = useState(false);

    const freezeParams: FreezeParamsLike | null = useMemo(() => {
        if (!pool || pool.freezeCapBps === undefined) return null;
        return {
            freezeCapBps: Number(pool.freezeCapBps),
            freezeMinDays: Number(pool.freezeMinDays ?? 5),
            freezeMaxFloorDays: Number(pool.freezeMaxFloorDays ?? 40),
            freezeMaxSpanDays: Number(pool.freezeMaxSpanDays ?? 80),
            freezeRegimeBear: Number(pool.freezeRegimeBear ?? 1500),
            freezeRegimeBull: Number(pool.freezeRegimeBull ?? 6500),
            freezeRegimeFloorBps: Number(pool.freezeRegimeFloorBps ?? 1500),
            freezePopKneeBps: Number(pool.freezePopKneeBps ?? 3000),
            freezePopFloorBps: Number(pool.freezePopFloorBps ?? 4000),
            freezeGraceDays: Number(pool.freezeGraceDays ?? 2),
        };
    }, [pool]);

    const frozenShareBps = useMemo(() => {
        if (!pool?.frozenAmount || !pool?.totalStaked) return 0;
        const frozen = Number(pool.frozenAmount.toString());
        const staked = Number(pool.totalStaked.toString());
        return staked > 0 ? Math.floor((frozen * 10000) / staked) : 0;
    }, [pool]);

    // One-shot momentum read when the modal opens (daily scalar on metrics).
    useEffect(() => {
        if (!freezeTarget || momentum !== null) return;
        let cancelled = false;
        (async () => {
            const [metricsPda] = PublicKey.findProgramAddressSync(
                [Buffer.from('metrics'), mint.toBuffer()],
                AMM_PROGRAM_ID,
            );
            const info = await connection.getAccountInfo(metricsPda);
            if (!cancelled && info?.data && info.data.length >= METRICS_MOMENTUM_OFFSET + 8) {
                const view = new DataView(info.data.buffer, info.data.byteOffset, info.data.byteLength);
                setMomentum(Number(view.getBigUint64(METRICS_MOMENTUM_OFFSET, true)));
            }
        })().catch(() => undefined);
        return () => { cancelled = true; };
    }, [freezeTarget, mint, connection, momentum]);

    const quote = useMemo(() => {
        if (!freezeParams || momentum === null) return null;
        // Range depends on regime only — the frozen-share popularity term
        // shapes the bonus (previewBonusBps), not the allowed days.
        return freezeQuote(momentum, freezeParams);
    }, [freezeParams, momentum]);

    // Snap the default selection into the allowed range as soon as the rate
    // card loads (the modal opens before momentum resolves).
    useEffect(() => {
        if (quote && freezeDays < quote.minDays) {
            setFreezeDays(Math.min(30, quote.maxDays));
        }
    }, [quote, freezeDays]);

    const previewBonusBps = useMemo(() => {
        if (!freezeParams || momentum === null || freezeDays <= 0) return 0;
        return freezeBonusBps(freezeDays, momentum, frozenShareBps, freezeParams);
    }, [freezeParams, momentum, freezeDays, frozenShareBps]);

    // Today's best possible bonus (at MAX length, current conditions) — what
    // the rate card can actually offer, as opposed to the hard protocol cap.
    const maxAvailableBonusBps = useMemo(() => {
        if (!freezeParams || !quote || momentum === null) return 0;
        return freezeBonusBps(quote.maxDays, momentum, frozenShareBps, freezeParams);
    }, [freezeParams, quote, momentum, frozenShareBps]);

    const openFreezeModal = (pos: EnrichedPosition) => {
        setMomentum(null);
        setFreezeTarget(pos);
        setFreezeDays(quote ? Math.max(quote.minDays, Math.min(30, quote.maxDays)) : 0);
    };

    const handleFreeze = async () => {
        if (!freezeTarget) return;
        setFreezing(true);
        try {
            const tx = await freeze(freezeTarget, freezeDays);
            reportTx({
                kind: 'success',
                headline: `Position #${freezeTarget.index} frozen for ${freezeDays} trading days`,
                signature: tx,
            });
            setFreezeTarget(null);
            refreshPositions();
        } catch (e) {
            reportTx({
                kind: 'error',
                headline: `Freeze of position #${freezeTarget.index} did not confirm`,
                detail: (e as Error).message,
            });
        } finally {
            setFreezing(false);
        }
    };


    // Exit penalties apply to principal and are tiered by market state
    // (0 = open, 1 = after-hours, 2 = closed, 3 = halted).
    const exitPenaltyBps = (() => {
        switch (marketData?.state) {
            case 1:
                return pool?.afterHoursPenaltyBps ?? 0;
            case 2:
                return pool?.closedPenaltyBps ?? 0;
            case 3:
                return pool?.haltedPenaltyBps ?? 0;
            default:
                return 0;
        }
    })();
    const exitPenaltyPct = (exitPenaltyBps / 100).toFixed(exitPenaltyBps % 100 === 0 ? 0 : 2);

    const handleClaimAll = async () => {
        try {
            const tx = await claimAll();
            reportTx({ kind: 'success', headline: 'All claims collected', signature: tx });
            refreshPositions();
        } catch (e) {
            reportTx({
                kind: 'error',
                headline: 'Claim-all did not confirm',
                detail: (e as Error).message,
            });
        }
    };

    const handleUnstake = async (position: typeof positions[number]) => {
        try {
            const tx = await unstake(position);
            reportTx({
                kind: 'success',
                headline: `Position #${position.index} exited`,
                signature: tx,
            });
            refreshPositions();
        } catch (e) {
            reportTx({
                kind: 'error',
                headline: `Exit of position #${position.index} did not confirm`,
                detail: (e as Error).message,
            });
        }
    };

    const handleExitAll = async () => {
        setExitingAll(true);
        let lastSig: string | undefined;
        for (const pos of positions) {
            try {
                lastSig = await unstake(pos);
            } catch (e) {
                reportTx({
                    kind: 'error',
                    headline: `Exit-all stopped at position #${pos.index}`,
                    detail: (e as Error).message,
                });
                setExitingAll(false);
                setConfirmingExitAll(false);
                refreshPositions();
                return;
            }
        }
        setExitingAll(false);
        setConfirmingExitAll(false);
        refreshPositions();
        reportTx({
            kind: 'success',
            headline: `Exited ${positions.length} position${positions.length === 1 ? '' : 's'}`,
            signature: lastSig,
        });
    };

    // ── Exit-all confirmation ──
    // Exiting wipes the stacked multiplier bonuses (the weighted-stake climb
    // that boosts reward accrual) — re-staking restarts the climb from 1x.
    // The modal makes that cost explicit before any transaction is signed.
    const [confirmingExitAll, setConfirmingExitAll] = useState(false);
    const [exitingAll, setExitingAll] = useState(false);
    const maxMultiplier = enriched.reduce((max, pos) => {
        const m = 'multiplierDisplay' in pos ? parseFloat(pos.multiplierDisplay) : NaN;
        return Number.isFinite(m) && m > max ? m : max;
    }, 0);
    const maxMultiplierLabel = maxMultiplier > 1 ? maxMultiplier.toFixed(maxMultiplier % 1 === 0 ? 0 : 2) : null;

    if (positionsLoading && !positions.length) return <div>Loading positions…</div>;
    if (positions.length === 0) return <div className="no-positions">No active stakes.</div>;

    const currentTradingDay = marketData?.tradingDay ?? null;

    const getDaysRemaining = (pos: typeof positions[number]) => {
        if (pos.daysToUnlock === 0 || currentTradingDay === null) return 0;
        const unlockDay = pos.entryTradingDay + pos.daysToUnlock;
        return Math.max(0, unlockDay - currentTradingDay);
    };

    // Freezeable cards ride to the top of the list: they carry the live
    // Freeze CTA, so they sort above frozen, bond, and ended-freeze
    // positions, with newest entries first as the tiebreak. Sharing the
    // card's button predicate keeps the order honest with the CTA.
    const isFreezeable = (pos: typeof positions[number]) => {
        const enrichedPos = pos as EnrichedPosition;
        return (
            claimsOpen
            && getDaysRemaining(pos) === 0
            && !(enrichedPos.isFrozen ?? false)
            && !(enrichedPos.freezeEnded ?? false)
            && freezeParams !== null
        );
    };

    const displayPositions = enriched.length > 0 ? enriched : positions.map(p => ({
        ...p,
        multiplierDisplay: '—',
        tradingDays: 0,
        netRewardDisplay: '—',
        penaltyRaw: 0,
        posrTaxRaw: 0,
    }));

    // The green tile shows CLAIMABLE AFHO only: rewards on still-vesting
    // bond positions are gated by the program (claim() rejects unvested
    // positions) and are surfaced in the vesting note below instead.
    const grandTotalDisplay = claimableTotal.toFixed(4);

    // Sum of all staked principal — the user's total balance locked in staking.
    const lockedTotal = positions.reduce((sum, pos) => sum + pos.amount, 0) / 1e9;
    const lockedTotalDisplay = lockedTotal.toFixed(2);

    return (
        <div className="positions-list">
            <div className="locked-total-header">
                <span className="locked-total-label text-glitch-light">Total locked:</span>
                <strong
                    className="locked-total-balance text-glitch"
                    style={{ '--glitch-delay': '0.9s' } as React.CSSProperties}
                >
                    {lockedTotalDisplay} AFHO
                </strong>
            </div>


            <div className="claims-header glass-pane neon-glitch ">
                <button
                    className="claim-collect"
                    onClick={handleClaimAll}
                    disabled={!claimsOpen || claimLoading || claimableTotal <= 0}
                >
                    <WalletMark />{' '}
                    {!claimsOpen ? 'Claim Available After Opening Bell' : claimLoading ? 'Collecting…' : 'Collect All Claims'}
                </button>
                <span className="grand-total">
                    Total rewards
                    <br />
                    available: <strong>{grandTotalDisplay} AFHO</strong>
                </span>
                <button
                    className="exit-all-button"
                    onClick={() => setConfirmingExitAll(true)}
                    disabled={positions.length === 0}
                >
                    Exit All Positions
                </button>
                {vestingCount > 0 && vestingTotal > 0 && (
                    <span className="vesting-note">
                        +{vestingTotal.toFixed(4)} AFHO locked in vesting bond positions, claimable when vesting ends
                    </span>
                )}
            </div>

            <div className="pos-contain">
                {[...displayPositions]
                    .sort((a, b) => {
                        const freezeableDelta =
                            Number(isFreezeable(a as typeof positions[number])) -
                            Number(isFreezeable(b as typeof positions[number]));
                        if (freezeableDelta !== 0) return freezeableDelta;
                        return b.entryTradingDay - a.entryTradingDay;
                    })
                    .map((pos) => {
                    const daysRemaining = getDaysRemaining(pos as typeof positions[number]);
                    const isVesting = daysRemaining > 0;
                    const isBond = pos.daysToUnlock > 0;
                    const enrichedPos = pos as EnrichedPosition;
                    const isFrozen = enrichedPos.isFrozen ?? false;
                    const freezeEnded = enrichedPos.freezeEnded ?? false;
                    const frozenDaysLeft = isFrozen && currentTradingDay !== null
                        ? Math.max(0, (enrichedPos.frozenUntilDay ?? 0) - currentTradingDay)
                        : 0;
                    const freezeBonusPct = ((enrichedPos.freezeBonusBps ?? 0) / 100).toFixed(2);
                    const canFreeze = isFreezeable(pos as typeof positions[number]);
                    return (
                        <div key={pos.index} className={`position-card neon-glitch glass-pane ${isVesting ? 'vesting' : ''} ${isFrozen ? 'frozen' : ''}`}>
                            <div className="position-row">
                                <span><strong>{(pos.amount / 1e9).toFixed(2)} </strong> AFHO</span>
                                <div className="position-side">
                                    <div className="position-badges">
                                        {isBond && (
                                            <span className="bond-badge neon-glitch" title="Purchased via night-desk bond offer">
                                                Bond
                                            </span>
                                        )}
                                        {'multiplierDisplay' in pos && pos.multiplierDisplay !== '—' && (
                                            <span className={`multiplier-badge${isFrozen ? ' frozen' : ''}`}>
                                                {isFrozen ? <><Snowflake /> {pos.multiplierDisplay}x</> : `${pos.multiplierDisplay}x`}
                                            </span>
                                        )}
                                    </div>
                                    {canFreeze && (
                                        <button
                                            className="freeze-button"
                                            onClick={() => openFreezeModal(enrichedPos)}
                                            disabled={freezeLoadingIndex === pos.index}
                                            title="Freeze this position for a bonus rewards multiplier"
                                        >
                                            {freezeLoadingIndex === pos.index ? <><Snowflake />…</> : <><Snowflake /> Freeze</>}
                                        </button>
                                    )}
                                </div>
                            </div>
                            {isFrozen && (
                                <div className="freeze-countdown">
                                    <Snowflake /> Frozen +{freezeBonusPct}%, {frozenDaysLeft} trading day{frozenDaysLeft === 1 ? '' : 's'} until unlock
                                </div>
                            )}
                            {freezeEnded && !isVesting && (
                                <div className="freeze-ended-note">
                                    Freeze ended. Claim to bank the frozen tail and re-freeze
                                </div>
                            )}
                            {isVesting && (
                                <div className="vesting-countdown">
                                    <span className="countdown-number">{daysRemaining}</span>
                                    <span className="countdown-label">
                                        trading day{daysRemaining === 1 ? '' : 's'} to unlock
                                    </span>
                                </div>
                            )}
                            <div><strong>Entry Day:</strong> #{pos.entryTradingDay}</div>
                            {'tradingDays' in pos && pos.tradingDays > 0 && (
                                <div><strong>Trading Days Elapsed:</strong> {pos.tradingDays}</div>
                            )}
                            {'netRewardDisplay' in pos && pos.netRewardDisplay !== '—' ? (
                                <>
                                    <div className="reward-line">
                                        <strong>Available Reward:</strong> {pos.netRewardDisplay}
                                    </div>
                                    {'penaltyRaw' in pos && pos.penaltyRaw > 0 && (
                                        <div className="penalty-warning">
                                            !! Market penalty: –{pos.penaltyRaw.toFixed(4)} AFHO
                                        </div>
                                    )}
                                    {'posrTaxRaw' in pos && pos.posrTaxRaw > 0 && (
                                        <div className="posr-line">
                                            Protocol tax: –{pos.posrTaxRaw.toFixed(4)} AFHO
                                        </div>
                                    )}
                                </>
                            ) : (
                                <div>Calculating rewards…</div>
                            )}
                            <div><strong>Last Claim:</strong> {new Date(pos.lastClaimTimestamp * 1000).toLocaleDateString()}</div>

                            <button
                                className="unstake"
                                onClick={() => handleUnstake(pos)}
                                disabled={isFrozen || unstakeLoadingIndex === pos.index}
                                title={isFrozen ? 'A freeze locks the principal until it ends' : undefined}
                            >
                                {isFrozen
                                    ? <><Snowflake /> Frozen; exit unlocks after the freeze</>
                                    : unstakeLoadingIndex === pos.index
                                        ? 'Exiting…'
                                        : `Exit Position (${exitPenaltyPct}% penalty)`}
                            </button>
                        </div>
                    );
                })}
            </div>

            {freezeTarget && (
                <div className="modal-overlay" onClick={() => !freezing && setFreezeTarget(null)}>
                    <div
                        className="exit-all-confirm glass-pane neon-glitch freeze-modal"
                        onClick={(e) => e.stopPropagation()}
                    >
                        <h3 className="text-glitch-light"><Snowflake /> Freeze position #{freezeTarget.index}</h3>
                        <p>
                            {(freezeTarget.amount / 1e9).toFixed(2)} AFHO, base{' '},
                            {(freezeTarget.multiplierBps / 10000).toFixed(2)}x. The bonus
                            multiplies your base for the whole freeze. Locked means locked:
                            no exit until the freeze ends (grace applies to claims only).
                        </p>
                        {!quote ? (
                            <p>Loading today&apos;s rate card…</p>
                        ) : (
                            <>
                                <div className="freeze-readout" aria-live="polite">
                                    <span className="freeze-readout-days">{freezeDays}</span>
                                    <span className="freeze-readout-unit">trading days</span>
                                    <span className="freeze-readout-bonus">+{(previewBonusBps / 100).toFixed(2)}%</span>
                                </div>
                                <div className="freeze-slider-wrap">
                                    <span className="freeze-endcap">{quote.minDays}d</span>
                                    <input
                                        type="range"
                                        className="freeze-slider"
                                        min={quote.minDays}
                                        max={quote.maxDays}
                                        step={1}
                                        value={freezeDays}
                                        onChange={(e) => setFreezeDays(Number(e.target.value))}
                                        style={{ '--freeze-fill': `${((freezeDays - quote.minDays) / Math.max(1, quote.maxDays - quote.minDays)) * 100}%` } as React.CSSProperties}
                                        aria-label="Freeze length in trading days"
                                    />
                                    <span className="freeze-endcap">{quote.maxDays}d</span>
                                </div>
                                <div className="freeze-presets" role="group" aria-label="Quick freeze lengths">
                                    {[quote.minDays, 30, 60, 90, quote.maxDays]
                                        .filter((d, i, a) => d >= quote.minDays && d <= quote.maxDays && a.indexOf(d) === i)
                                        .map((d) => (
                                            <button
                                                key={d}
                                                className={`freeze-preset${freezeDays === d ? ' active' : ''}`}
                                                onClick={() => setFreezeDays(d)}
                                            >
                                                {d === quote.maxDays ? 'MAX' : `${d}d`}
                                            </button>
                                        ))}
                                </div>
                                <div className="freeze-quote">
                                    Bonus multiplies your base for the whole freeze{' '}
                                    <span className="freeze-quote-cap">
                                        (today&apos;s best +{(maxAvailableBonusBps / 100).toFixed(2)}% at MAX ·
                                        protocol cap +{(quote.capBps / 100).toFixed(0)}% · market allows{' '}
                                        {quote.minDays}–{quote.maxDays} days)
                                    </span>
                                </div>
                                <div className="exit-all-confirm-actions">
                                    <button
                                        className="exit-all-cancel"
                                        onClick={() => setFreezeTarget(null)}
                                        disabled={freezing}
                                    >
                                        Keep liquid
                                    </button>
                                    <button
                                        className="exit-all-confirm-button"
                                        onClick={handleFreeze}
                                        disabled={freezing || previewBonusBps <= 0}
                                    >
                                        <WalletMark size={14} /> {freezing ? 'Freezing…' : `Freeze ${freezeDays} days`}
                                    </button>
                                </div>
                            </>
                        )}
                    </div>
                </div>
            )}

            {confirmingExitAll && (
                <div className="modal-overlay" onClick={() => !exitingAll && setConfirmingExitAll(false)}>
                    <div
                        className="exit-all-confirm glass-pane neon-glitch"
                        onClick={(e) => e.stopPropagation()}
                    >
                        <h3 className="text-glitch-light">Exit all positions?</h3>
                        <p>
                            Exiting {positions.length} position{positions.length !== 1 ? 's' : ''} forfeits
                            your <strong>stacked multiplier bonuses</strong>
                            {maxMultiplierLabel ? ` (currently up to ${maxMultiplierLabel}x)` : ''} —
                            re-staking restarts every multiplier climb from 1x.
                        </p>
                        <p>
                            Exit penalties apply on the way out
                            ({exitPenaltyPct}% of principal in the current session), and rewards
                            still vesting stay locked until their vesting ends.
                        </p>
                        <div className="exit-all-confirm-actions">
                            <button
                                className="exit-all-cancel"
                                onClick={() => setConfirmingExitAll(false)}
                                disabled={exitingAll}
                            >
                                Keep staking
                            </button>
                            <button
                                className="exit-all-confirm-button"
                                onClick={handleExitAll}
                                disabled={exitingAll}
                            >
                                <WalletMark size={14} /> {exitingAll ? 'Exiting…' : 'Confirm: exit everything'}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};
