import { useEffect, useMemo, useRef, useState } from 'react';
import { useConnection } from '@solana/wallet-adapter-react';
import { PublicKey } from '@solana/web3.js';
import { usePoolStats } from '../../hooks/usePoolStats';
import { useChainData } from '../../context/useChainData';
import './SupplyChart.css';

/* SupplyStakeChart — three lines: available, locked, frozen.
 *
 *   • AVAILABLE — released supply: total supply − bond-desk inventory
 *     (amm afho_vault). Starts at the 200M launch release (1B minted −
 *     800M desk seed) and rises as the desk releases supply out of the
 *     protocol lock. Bond-desk volume itself is NOT charted.
 *   • LOCKED — staked AFHO (staking pool total_staked). Starts at zero,
 *     rises when people stake (bond vesting positions stake automatically,
 *     so releases flow in here too) and falls when people unstake.
 *
 * Both series are real on-chain quantities — nothing modeled. There is no
 * on-chain time series, so history is seeded from the shared records ledger
 * (app/public/records.json — one row per trading day, written by the keeper
 * via scripts/keeper/record-day.ts on every →0 transition, the same source the
 * /records page renders). Browser localStorage can NOT be the source: every
 * visitor would start with an empty (or worse, divergent) history. The live
 * right edge is appended in memory from the current poll; points are keyed
 * by the on-chain trading_day_index exactly like the ledger. Keep
 * GENESIS_AVAILABLE in sync with AFHO_TO_LP in scripts/launch/create-pool.ts. */

const RECORDS_URL = 'records.json';
const MAX_POINTS = 400;
const GENESIS_AVAILABLE = 200_000_000;
const AFHO_DECIMALS = 1e9; // raw → whole tokens (9 dp mint)

type Sample = {
    day: string; // YYYY-MM-DD (ET) — the calendar date the sample was taken
    tday: number | null; // on-chain trading_day_index (null = unknown)
    t: number; // ms epoch of the sample
    available: number; // total supply − bond-desk inventory
    locked: number; // staked AFHO
    frozen: number | null; // staked AFHO carrying a freeze (null = not recorded)
};

/* Current date in US Eastern time (the protocol's day boundary), YYYY-MM-DD. */
function etDayString(d = new Date()): string {
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/New_York',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).format(d);
}

function dayBefore(day: string): string {
    const [y, m, d] = day.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    dt.setUTCDate(dt.getUTCDate() - 1);
    return dt.toISOString().slice(0, 10);
}

/* Ledger row shape (app/public/records.json — scripts/keeper/record-day.ts). */
type RecordRow = {
    dayIndex: number;
    recordedAt: number; // unix seconds
    date: string; // YYYY-MM-DD
    marketState: number;
    market: { afhoVault: string | null };
    staking: { totalStaked: string | null; totalSupply: string | null; frozenAmount?: string | null };
};

/* Seed history from the shared records ledger. Rows missing either the
   desk-inventory or staking read (older rows recorded before the ledger
   captured them) are skipped — a gap in the chart beats an invented flat
   line. Rows are ordered by trading day; the state-99 sentinel is excluded
   by the writer, but filter defensively anyway. */
async function fetchLedgerSamples(): Promise<Sample[]> {
    try {
        const res = await fetch(`${import.meta.env.BASE_URL}${RECORDS_URL}`, { cache: 'no-store' });
        if (!res.ok) return [];
        const ledger = (await res.json()) as { rows?: RecordRow[] };
        const rows = [...(ledger.rows ?? [])]
            .filter((r) => r.marketState !== 99)
            .sort((a, b) => a.dayIndex - b.dayIndex);
        const samples: Sample[] = [];
        for (const r of rows) {
            if (r.market.afhoVault === null || r.staking.totalStaked === null) continue;
            const supply = r.staking.totalSupply !== null ? Number(r.staking.totalSupply) : null;
            const available = Math.max(0, (supply ?? 0) - Number(r.market.afhoVault)) / AFHO_DECIMALS;
            const locked = Number(r.staking.totalStaked) / AFHO_DECIMALS;
            const frozen = r.staking.frozenAmount != null
                ? Number(r.staking.frozenAmount) / AFHO_DECIMALS
                : null;
            if (supply === null) continue;
            samples.push({
                day: r.date,
                tday: r.dayIndex,
                t: r.recordedAt * 1000,
                available,
                locked,
                frozen,
            });
        }
        return samples.slice(-MAX_POINTS);
    } catch {
        return [];
    }
}

async function fetchTokenUiAmount(
    connection: ReturnType<typeof useConnection>['connection'],
    account: PublicKey,
): Promise<number | null> {
    try {
        const info = await connection.getTokenAccountBalance(account, 'confirmed');
        return info.value.uiAmount ?? null;
    } catch {
        return null;
    }
}

const fmtTokens = (n: number) =>
    n >= 1e6
        ? `${(n / 1e6).toLocaleString('en-US', { maximumFractionDigits: 0 })}M`
        : n.toLocaleString('en-US', { maximumFractionDigits: 0 });

const fmtExact = (n: number) => Math.round(n).toLocaleString('en-US');

const fmtDelta = (d: number) => `${d >= 0 ? '+' : '−'}${fmtTokens(Math.abs(d))}`;

function fmtDayLabel(day: string): string {
    const [y, m, d] = day.split('-').map(Number);
    return new Intl.DateTimeFormat('en-US', {
        timeZone: 'UTC',
        month: 'short',
        day: 'numeric',
        year: 'numeric',
    }).format(new Date(Date.UTC(y, m - 1, d)));
}

const W = 560; // viewBox units
const H = 220;
const PAD_L = 52;
const PAD_R = 14;
const PAD_T = 14;
const PAD_B = 26;

export function SupplyStakeChart() {
    const { stats, loading } = usePoolStats();
    const { ammState, marketStatus } = useChainData();
    const { connection } = useConnection();
    const [history, setHistory] = useState<Sample[]>([]);
    const [deskVault, setDeskVault] = useState<number | null>(null);
    const svgRef = useRef<SVGSVGElement | null>(null);
    const [hover, setHover] = useState<{ i: number; yv: number } | null>(null);

    useEffect(() => {
        let cancelled = false;
        void fetchLedgerSamples().then((samples) => {
            if (!cancelled && samples.length) setHistory(samples);
        });
        return () => {
            cancelled = true;
        };
    }, []);

    // Bond-desk inventory (amm afho_vault) — the protocol lock. A light poll
    // keeps the right edge current between react-query refreshes.
    const vaultKey = ammState?.afhoVault ?? ammState?.afho_vault ?? null;
    useEffect(() => {
        if (!vaultKey) return;
        let cancelled = false;
        const vault = new PublicKey(vaultKey);
        fetchTokenUiAmount(connection, vault).then((v) => {
            if (!cancelled && v !== null) setDeskVault(v);
        });
        const id = window.setInterval(() => {
            fetchTokenUiAmount(connection, vault).then((v) => {
                if (!cancelled && v !== null) setDeskVault(v);
            });
        }, 60_000);
        return () => {
            cancelled = true;
            window.clearInterval(id);
        };
    }, [vaultKey, connection]);

    const available = stats && deskVault !== null ? Math.max(0, stats.totalSupply - deskVault) : null;
    const locked = stats?.totalStaked ?? null;
    const frozenLive = stats?.frozen ?? null;

    // Record one point per TRADING DAY, keyed by the on-chain day index the
    // same way the records ledger is. A point is appended when the trading
    // day rolls OR values move materially — so two points can share a
    // calendar date (both plotted) and the stairstep stays visible.
    const tday = marketStatus?.tradingDay ?? null;
    useEffect(() => {
        if (available === null || locked === null || frozenLive === null || !stats || stats.totalSupply <= 0) return;
        setHistory((prev) => {
            const last = prev[prev.length - 1];
            const next: Sample = { day: etDayString(), tday, t: Date.now(), available, locked, frozen: frozenLive };
            if (!last) return [next];
            const dayRolled = tday !== null && last.tday !== null && tday !== last.tday;
            const moved =
                Math.abs(last.available - available) > Math.max(1, last.available * 0.005) ||
                Math.abs(last.locked - locked) > Math.max(1, last.locked * 0.005);
            // Never regress: a ledger-seeded point for the CURRENT day is
            // replaced in place; anything older is kept.
            if (dayRolled || moved) {
                if (last.tday !== null && tday !== null && tday === last.tday) {
                    return [...prev.slice(0, -1), next].slice(-MAX_POINTS);
                }
                return [...prev, next].slice(-MAX_POINTS);
            }
            return prev;
        });
    }, [stats, available, locked, frozenLive, tday]);

    const {
        pathAvailable,
        pathLocked,
        pathFrozen,
        areaLocked,
        areaBand,
        areaFrozen,
        yTicks,
        xLabels,
        pctLabel,
        bandLabel,
        series,
        xs,
        ysAvail,
        ysLocked,
        ysFrozen,
    } = useMemo(() => {
        if (available === null || locked === null) {
            return {
                pathAvailable: '',
                pathLocked: '',
                pathFrozen: '',
                areaLocked: '',
                areaBand: '',
                areaFrozen: '',
                yTicks: [],
                xLabels: [],
                pctLabel: null,
                bandLabel: null as { x: number; y: number } | null,
                series: [] as Sample[],
                xs: [] as number[],
                ysAvail: [] as number[],
                ysLocked: [] as number[],
                ysFrozen: [] as (number | null)[],
            };
        }
        const live: Sample = { day: etDayString(), tday, t: Date.now(), available, locked, frozen: frozenLive };
        const recorded = [...history];
        // Anchor the series at the launch release: 200M available, nothing
        // staked, dated one day before the oldest recorded sample.
        const oldest = recorded[0];
        const genesis: Sample = {
            day: dayBefore(oldest ? oldest.day : live.day),
            tday: null,
            t: oldest ? oldest.t - 86_400_000 : live.t - 86_400_000,
            available: GENESIS_AVAILABLE,
            locked: 0,
            frozen: null,
        };
        const pts: Sample[] = [genesis, ...recorded];
        if (pts.length === 1 || pts[pts.length - 1].tday !== live.tday) pts.push(live);
        else pts[pts.length - 1] = live;

        // Simple shared axis: 0 at the baseline (so the locked line starts
        // AT zero and is always visible) up to just above the highest value.
        const yMax = Math.max(1, ...pts.map((p) => Math.max(p.available, p.locked))) * 1.06;
        const x = (i: number) =>
            PAD_L + (pts.length <= 1 ? 0 : (i / (pts.length - 1)) * (W - PAD_L - PAD_R));
        const y = (v: number) => PAD_T + (1 - v / yMax) * (H - PAD_T - PAD_B);

        const xs = pts.map((_, i) => x(i));
        const ysAvail = pts.map((p) => y(p.available));
        const ysLocked = pts.map((p) => y(p.locked));
        const ysFrozen = pts.map((p) => (p.frozen === null ? null : y(p.frozen)));

        // Step-after rendering: each value HOLDS until the next recorded
        // point, so day-boundary releases and stake changes read as stairsteps.
        const stepPath = (ys: number[]) => {
            if (ys.length === 0) return '';
            let d = `M${xs[0].toFixed(1)},${ys[0].toFixed(1)}`;
            for (let i = 1; i < ys.length; i++) {
                d += ` H${xs[i].toFixed(1)} V${ys[i].toFixed(1)}`;
            }
            return d;
        };
        const pathAvailable = stepPath(ysAvail);
        const pathLocked = stepPath(ysLocked);
        // The frozen line starts at the first recorded frozen sample (older
        // ledger rows predate the field — no invented flat line).
        const firstFrozen = ysFrozen.findIndex((v) => v !== null);
        const pathFrozen =
            firstFrozen >= 0 && pts.length - firstFrozen > 1
                ? stepPath(ysFrozen.slice(firstFrozen) as number[])
                : '';

        // Shaded regions: locked to the baseline (green), the LIQUID band
        // between the available and locked lines (pink), frozen over the
        // green (blue).
        const base = y(0).toFixed(1);
        let areaLocked = '';
        if (pts.length > 1) {
            areaLocked = `${pathLocked} L${x(pts.length - 1).toFixed(1)},${base} L${x(0).toFixed(1)},${base} Z`;
        }
        let areaBand = '';
        if (pts.length > 1) {
            let rev = `M${x(pts.length - 1).toFixed(1)},${ysLocked[pts.length - 1].toFixed(1)}`;
            for (let i = pts.length - 2; i >= 0; i--) {
                rev += ` H${x(i).toFixed(1)} V${ysLocked[i].toFixed(1)}`;
            }
            areaBand = `${pathAvailable} ${rev} Z`;
        }
        let areaFrozen = '';
        if (pathFrozen) {
            const lastF = pts.length - 1;
            const firstX = x(firstFrozen).toFixed(1);
            areaFrozen = `${pathFrozen} L${x(lastF).toFixed(1)},${base} L${firstX},${base} Z`;
        }

        // In-chart label for the liquid band, anchored near the left edge
        // where the band is wide enough to hold it.
        let bandLabel: { x: number; y: number } | null = null;
        for (let i = 0; i < pts.length; i++) {
            const gap = ysLocked[i] - ysAvail[i];
            if (gap >= 22) {
                bandLabel = { x: xs[i] + 8, y: ysAvail[i] + gap / 2 };
                break;
            }
        }

        const ticks = [0, yMax / 2, yMax].map((v) => ({
            y: y(v),
            label: v === 0 ? '0' : fmtTokens(v),
        }));
        const labels =
            pts.length > 1
                ? [
                    { x: x(0), label: pts[0].day.slice(5) },
                    { x: x(pts.length - 1), label: pts[pts.length - 1].day.slice(5) },
                ]
                : [];

        const pct =
            stats && available !== null && available > 0
                ? `${((locked / available) * 100).toFixed(1)}% of available`
                : null;

        return { pathAvailable, pathLocked, pathFrozen, areaLocked, areaBand, areaFrozen, yTicks: ticks, xLabels: labels, pctLabel: pct, bandLabel, series: pts, xs, ysAvail, ysLocked, ysFrozen };
    }, [history, stats, available, locked, frozenLive]);

    /* ── hover: snap to the nearest recorded day ── */
    const snapToNearest = (clientX: number, clientY: number) => {
        const svg = svgRef.current;
        if (!svg || xs.length === 0) return;
        const rect = svg.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return;
        const xv = ((clientX - rect.left) / rect.width) * W;
        const yv = ((clientY - rect.top) / rect.height) * H;
        let best = 0;
        let bestD = Infinity;
        for (let i = 0; i < xs.length; i++) {
            const d = Math.abs(xs[i] - xv);
            if (d < bestD) {
                bestD = d;
                best = i;
            }
        }
        setHover((prev) => (prev && prev.i === best ? { i: best, yv } : { i: best, yv }));
    };

    const onKeyDown = (e: React.KeyboardEvent<SVGSVGElement>) => {
        if (xs.length === 0) return;
        if (e.key === 'Escape') {
            setHover(null);
            return;
        }
        let next: number | null = null;
        if (e.key === 'ArrowLeft') next = hover ? Math.max(0, hover.i - 1) : xs.length - 1;
        else if (e.key === 'ArrowRight') next = hover ? Math.min(xs.length - 1, hover.i + 1) : xs.length - 1;
        else if (e.key === 'Home') next = 0;
        else if (e.key === 'End') next = xs.length - 1;
        if (next !== null) {
            e.preventDefault();
            setHover({ i: next, yv: ysAvail[next] ?? 0 });
        }
    };

    if (loading || available === null || locked === null || series.length === 0) {
        return <div className="supply-chart loading">Loading supply chart…</div>;
    }

    const liquid = Math.max(0, available - locked);
    const h = hover && hover.i < xs.length ? hover : null;
    const hovered = h ? series[h.i] : null;
    const prevHovered = h && h.i > 0 ? series[h.i - 1] : null;
    const dAvail = hovered && prevHovered ? hovered.available - prevHovered.available : null;
    const dLocked = hovered && prevHovered ? hovered.locked - prevHovered.locked : null;
    const hoverPct =
        hovered && hovered.available > 0
            ? `${((hovered.locked / hovered.available) * 100).toFixed(1)}%`
            : null;
    // Popover anchor: clamp inside the plot on both axes so it never overflows.
    const tipLeft = h ? Math.min(84, Math.max(16, (xs[h.i] / W) * 100)) : 50;
    const tipTop = h ? Math.min(72, Math.max(14, (h.yv / H) * 100)) : 40;

    return (
        <div className="supply-chart glass-pane neon-shadow shadow-wander-a neon-glitch">
            <header className="supply-chart-head">
                <h3 className="supply-chart-title">Liquid Supply:</h3>
                <p className="supply-chart-value supply-chart-value-liquid">{fmtTokens(liquid)}</p>
                <p className="supply-chart-sub">
                    (available supply minus locked — the AFHO in the LP pool and unstaked wallets)
                </p>
            </header>
            <div className="supply-chart-plot">
                <svg
                    ref={svgRef}
                    className="supply-chart-svg"
                    viewBox={`0 0 ${W} ${H}`}
                    role="img"
                    tabIndex={0}
                    aria-label={`Liquid supply chart. Use left and right arrow keys to inspect each day. Latest: ${fmtTokens(available)} available, ${fmtTokens(locked)} locked, ${fmtTokens(stats?.frozen ?? 0)} frozen, ${fmtTokens(liquid)} liquid.`}
                    onPointerMove={(e) => snapToNearest(e.clientX, e.clientY)}
                    onPointerDown={(e) => snapToNearest(e.clientX, e.clientY)}
                    onPointerLeave={() => setHover(null)}
                    onKeyDown={onKeyDown}
                    onBlur={() => setHover(null)}
                >
                    {yTicks.map((t, i) => (
                        <g key={i}>
                            <line className="supply-chart-gridline" x1={PAD_L} x2={W - PAD_R} y1={t.y} y2={t.y} />
                            <text className="supply-chart-ytick" x={PAD_L - 6} y={t.y + 3} textAnchor="end">
                                {t.label}
                            </text>
                        </g>
                    ))}

                    {/* shaded regions: locked to baseline, liquid band above it, frozen over that */}
                    {areaLocked && <path className="supply-chart-area-locked" d={areaLocked} />}
                    {areaBand && <path className="supply-chart-area-band" d={areaBand} />}
                    {areaFrozen && <path className="supply-chart-area-frozen" d={areaFrozen} />}

                    {/* the lines, each with a slow traveling trace segment */}
                    <path className="supply-chart-line" d={pathAvailable} />
                    <path className="supply-chart-line-locked" d={pathLocked} />
                    {pathFrozen && <path className="supply-chart-line-frozen" d={pathFrozen} />}
                    <path className="supply-chart-trace supply-chart-trace-available" d={pathAvailable} pathLength={100} />
                    <path className="supply-chart-trace supply-chart-trace-locked" d={pathLocked} pathLength={100} />
                    {pathFrozen && (
                        <path className="supply-chart-trace supply-chart-trace-frozen" d={pathFrozen} pathLength={100} />
                    )}

                    {/* in-chart label for the liquid band between the lines */}
                    {bandLabel && (
                        <text className="supply-chart-band-label" x={bandLabel.x} y={bandLabel.y}>
                            LIQUID
                        </text>
                    )}

                    {/* hover crosshair + highlight dots */}
                    {h && (
                        <g aria-hidden="true">
                            <line
                                className="supply-chart-crosshair"
                                x1={xs[h.i]}
                                x2={xs[h.i]}
                                y1={PAD_T}
                                y2={H - PAD_B}
                            />
                            <circle className="supply-chart-dot" cx={xs[h.i]} cy={ysAvail[h.i]} r={3.2} />
                            <circle className="supply-chart-dot-locked" cx={xs[h.i]} cy={ysLocked[h.i]} r={3.2} />
                            {ysFrozen[h.i] !== null && (
                                <circle className="supply-chart-dot-frozen" cx={xs[h.i]} cy={ysFrozen[h.i] as number} r={3.2} />
                            )}
                        </g>
                    )}

                    {xLabels.map((l, i) => (
                        <text key={i} className="supply-chart-xtick" x={l.x} y={H - 8} textAnchor={i === 0 ? 'start' : 'end'}>
                            {l.label}
                        </text>
                    ))}
                </svg>

                {/* day popover — anchored at the crosshair, clamped inside the plot */}
                {h && hovered && (
                    <div className="supply-chart-tooltip" role="status" style={{ left: `${tipLeft}%`, top: `${tipTop}%` }}>
                        <div className="supply-chart-tooltip-date">
                            {h.i === 0
                                ? 'Launch'
                                : `${hovered.tday !== null ? `Day #${hovered.tday} · ` : ''}${fmtDayLabel(hovered.day)}`}
                        </div>
                        <div className="supply-chart-tooltip-row">
                            <span className="tt-label">
                                <i className="supply-chart-swatch swatch-available" /> Available
                            </span>
                            <span className="tt-value">
                                {fmtExact(hovered.available)}
                                {dAvail !== null && <em className={dAvail >= 0 ? 'tt-up' : 'tt-down'}> {fmtDelta(dAvail)}</em>}
                            </span>
                        </div>
                        <div className="supply-chart-tooltip-row">
                            <span className="tt-label">
                                <i className="supply-chart-swatch swatch-staked" /> Locked
                            </span>
                            <span className="tt-value">
                                {fmtExact(hovered.locked)}
                                {hoverPct && <em className="tt-pct"> · {hoverPct}</em>}
                                {dLocked !== null && (
                                    <em className={dLocked >= 0 ? 'tt-up' : 'tt-down'}> {fmtDelta(dLocked)}</em>
                                )}
                            </span>
                        </div>
                        {hovered.frozen !== null && (
                            <div className="supply-chart-tooltip-row">
                                <span className="tt-label">
                                    <i className="supply-chart-swatch swatch-frozen" /> Frozen
                                </span>
                                <span className="tt-value">
                                    {fmtExact(hovered.frozen)}
                                    {hovered.locked > 0 && (
                                        <em className="tt-pct"> · {((hovered.frozen / hovered.locked) * 100).toFixed(1)}%</em>
                                    )}
                                </span>
                            </div>
                        )}
                        <div className="supply-chart-tooltip-row">
                            <span className="tt-label">
                                <i className="supply-chart-swatch swatch-liquid" /> Liquid
                            </span>
                            <span className="tt-value">{fmtExact(hovered.available - hovered.locked)}</span>
                        </div>
                    </div>
                )}
            </div>
            <div className="supply-chart-legend">
                <span className="supply-chart-key">
                    <i className="supply-chart-swatch swatch-available" />Available {fmtTokens(available)}
                </span>
                <span className="supply-chart-key">
                    <i className="supply-chart-swatch swatch-liquid" />Liquid {fmtTokens(liquid)}
                </span>
                <span className="supply-chart-key">
                    <i className="supply-chart-swatch swatch-staked" />Locked {fmtTokens(locked)}
                    {pctLabel ? ` (${pctLabel})` : ''}
                </span>
                <span className="supply-chart-key">
                    <i className="supply-chart-swatch swatch-frozen" />Frozen {fmtTokens(stats?.frozen ?? 0)}
                </span>
            </div>
        </div>
    );
}
