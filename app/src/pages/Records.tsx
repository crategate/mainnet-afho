import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Helmet } from 'react-helmet-async';
import { GlitchText } from '../components/GlitchText';
import './Records.css';
import { Snowflake } from '../components/Snowflake';

/* Trading Day Metric Ledger — /records
 * A marketing-facing, deliberately dry ledger of one row per trading day,
 * recorded at start of trade day (app/public/records.json, written by
 * scripts/keeper/record-day.ts — the keeper fires it on every →0 transition). */

type TierRow = {
    lotTier: number;
    lotTokens: number;
    vestingDays: number;
    discountBps: number; // tenths of a percent (115 = 11.5%)
    remaining: number;
    totalOffered: number;
} | null;

type RecordRow = {
    dayIndex: number;
    recordedAt: number;
    date: string; // YYYY-MM-DD
    marketState: number;
    offerDesk: {
        big: TierRow;
        med: TierRow;
        sml: TierRow;
        totalComplete: number | null;
        sheetDayIndex: number | null;
    };
    fills: { big: number[]; med: number[]; sml: number[] } | null;
    market: {
        afhoPrice: string | null; // floor units (nano-USD per whole token)
        spotMin: string | null;
        spotMax: string | null;
        spotSamples: number;
        priceChanges: number[]; // centi-percent i16 ring, on-chain order
        sampleHead: number;
        momentum: number; // 0-10000 (5000 = flat), 0 = cold
        momentumSamples: number;
        highestBuybackBasis: string | null;
        afhoVault: string | null;
        usdcVault: string | null;
        usdcDip: string | null;
    };
    staking: {
        totalStaked: string | null;
        totalWeightedStake: string | null;
        totalSupply: string | null;
        stakedPct: number | null;
        trailingStakeHealth: number[];
        stakeVault: string | null;
        rewardVault: string | null;
        penaltyVault: string | null;
        posrVault: string | null;
        frozenAmount: string | null;
    };
};

type Ledger = { version: number; rows: RecordRow[] };
type ArchiveManifest = {
    version: number;
    archives: { firstDay: number; lastDay: number; days: number; pdf: string }[];
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MARKET_LABELS = ['open', 'after-hours', 'closed', 'halted'];

const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 });

function fmtDate(iso: string): string {
    const parts = iso.split('-').map(Number);
    if (parts.length !== 3 || parts.some((p) => !Number.isFinite(p))) return iso;
    return `${MONTHS[parts[1] - 1] ?? '?'} ${parts[2]}`;
}

function fmtTokens(raw: string | number | null, decimals = 9): string {
    if (raw === null || raw === undefined || raw === '') return '—';
    const n = Number(raw) / 10 ** decimals;
    if (!Number.isFinite(n)) return '—';
    return compact.format(n);
}

function fmtPrice(floor: string | null): string {
    if (floor === null || floor === undefined || floor === '') return '—';
    const dollars = Number(floor) / 1e9;
    if (!Number.isFinite(dollars) || dollars <= 0) return '—';
    return '$' + dollars.toFixed(9).replace(/0+$/, '').replace(/\.$/, '');
}

function fmtSignedPct(cp: number): string {
    return `${cp > 0 ? '+' : ''}${(cp / 100).toFixed(2)}%`;
}

/* Newest nonzero entry of the daily close→close change ring (centi-percent). */
function latestPriceChange(priceChanges: number[], sampleHead: number): number | null {
    const n = priceChanges.length;
    if (n === 0) return null;
    const head = ((sampleHead % n) + n) % n;
    for (let age = n - 1; age >= 0; age--) {
        const v = priceChanges[(head + age) % n];
        if (v !== 0) return v;
    }
    return null;
}

type Trend = 'up' | 'down' | null;

/* Day-over-day direction against the older (chronologically previous) row. */
function trend(cur: number | null, prev: number | null): Trend {
    if (cur === null || prev === null || !Number.isFinite(cur) || !Number.isFinite(prev) || cur === prev) return null;
    return cur > prev ? 'up' : 'down';
}

function trendClass(t: Trend): string {
    return t ? ` records-${t}` : '';
}

function Line({ label, children }: { label: string; children: ReactNode }) {
    return (
        <div className="records-line">
            <span className="records-line-label">{label}</span>
            <span className="records-line-value">{children}</span>
        </div>
    );
}

function lotLine(name: string, t: TierRow): ReactNode {
    if (!t) return null;
    return (
        <Line label={name} key={name}>
            lot {t.lotTokens.toLocaleString('en-US')} · {t.vestingDays}d vest · {(t.discountBps / 10).toFixed(1)}% off ·{' '}
            {t.remaining.toLocaleString('en-US')}/{t.totalOffered.toLocaleString('en-US')} left
        </Line>
    );
}

function RecordRowTr({ row, prev }: { row: RecordRow; prev: RecordRow | null }) {
    const m = row.market;
    const st = row.staking;

    const changeCp = latestPriceChange(m.priceChanges, m.sampleHead);
    const changeTrend: Trend = changeCp === null ? null : changeCp > 0 ? 'up' : changeCp < 0 ? 'down' : null;

    const momCold = m.momentumSamples < 5;
    const momTrend = momCold ? null : trend(m.momentum, prev?.market.momentum ?? null);

    const priceCur = m.afhoPrice !== null ? Number(m.afhoPrice) : null;
    const pricePrev = prev?.market.afhoPrice != null ? Number(prev.market.afhoPrice) : null;

    const stakedPctTrend = trend(st.stakedPct, prev?.staking.stakedPct ?? null);

    return (
        <tr className="records-row">
            <td className="records-date-cell">
                <span className="records-date">{fmtDate(row.date)}</span>
                <span className="records-day-index">day #{row.dayIndex}</span>
            </td>
            <td className="records-offer-cell">
                {lotLine('Big', row.offerDesk.big)}
                {lotLine('Med', row.offerDesk.med)}
                {lotLine('Sml', row.offerDesk.sml)}
                <Line label="Sold">
                    {row.offerDesk.totalComplete !== null
                        ? `${row.offerDesk.totalComplete.toLocaleString('en-US')} AFHO`
                        : '—'}
                </Line>
                <Line label="Ratchet floor">{fmtPrice(m.highestBuybackBasis)}</Line>
                {row.fills && (
                    <Line label="Fills 5d">
                        B {row.fills.big.join('·')} / M {row.fills.med.join('·')} / S {row.fills.sml.join('·')}
                    </Line>
                )}
            </td>
            <td className="records-cell">
                <Line label="State">{stateLabel(row.marketState)}</Line>
                <Line label="AFHO">
                    <span className={'records-num' + trendClass(trend(priceCur, pricePrev))}>{fmtPrice(m.afhoPrice)}</span>
                </Line>
                <Line label="24h chg">
                    <span className={'records-num' + trendClass(changeTrend)}>
                        {changeCp === null ? '—' : fmtSignedPct(changeCp)}
                    </span>
                </Line>
                <Line label="Momentum">
                    <span className={'records-num' + trendClass(momTrend)}>
                        {momCold ? '· cold' : `${m.momentum} / 10000`}
                    </span>
                </Line>
                <Line label="Range">
                    {fmtPrice(m.spotMin)} – {fmtPrice(m.spotMax)}
                </Line>
                <Line label="AFHO vault">{fmtTokens(m.afhoVault)}</Line>
                <Line label="Dip reserve">{m.usdcDip !== null ? `${fmtTokens(m.usdcDip, 6)} USDC` : '—'}</Line>
            </td>
            <td className="records-cell">
                <Line label="Staked">
                    {st.totalStaked !== null ? (
                        <>
                            {fmtTokens(st.totalStaked)}
                            {st.stakedPct !== null && (
                                <>
                                    {' ('}
                                    <span className={'records-num' + trendClass(stakedPctTrend)}>
                                        {st.stakedPct.toFixed(2)}%
                                    </span>
                                    {' of supply)'}
                                </>
                            )}
                        </>
                    ) : (
                        '—'
                    )}
                </Line>
                <Line label="Health 5d">{st.trailingStakeHealth.length ? st.trailingStakeHealth.join(' → ') : '—'}</Line>
                <Line label="Reward vault">{fmtTokens(st.rewardVault)}</Line>
                <Line label="Penalty vault">{fmtTokens(st.penaltyVault)}</Line>
                <Line label="POSR vault">{fmtTokens(st.posrVault)}</Line>
                <Line label="Frozen"><Snowflake /> {fmtTokens(st.frozenAmount)}</Line>
            </td>
        </tr>
    );
}

/* /records renders the newest LATEST_DAYS trading days; the recorder caps the
 * live ledger at the same size and archives everything older into
 * 60-trading-day PDF blocks (listed below the table). */
const LATEST_DAYS = 100;

function stateLabel(state: number): string {
    return MARKET_LABELS[state] ?? `state ${state}`;
}

export default function Records() {
    const [ledger, setLedger] = useState<Ledger | null>(null);
    const [archives, setArchives] = useState<ArchiveManifest | null>(null);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [rotateDismissed, setRotateDismissed] = useState(
        () => window.localStorage.getItem('records-rotate-dismissed') === '1',
    );

    /* Floating header: once the page scrolls past the header it sticks to
     * the viewport top. A zero-height sentinel above it detects "stuck"
     * (for the glass background), and a ResizeObserver publishes the header
     * height as a CSS var so the table's own sticky thead parks BELOW the
     * floating header instead of underneath it. The stuck state shrinks the
     * header's padding, so the observer must watch the BORDER box (the
     * default content box ignores padding changes and never fires) and the
     * stuck toggle re-measures after the shrink lands. */
    const shellRef = useRef<HTMLDivElement>(null);
    const headerRef = useRef<HTMLElement>(null);
    const sentinelRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const shell = shellRef.current;
        const header = headerRef.current;
        const sentinel = sentinelRef.current;
        if (!shell || !header || !sentinel) return;
        const publish = () => {
            shell.style.setProperty('--records-head-h', `${header.offsetHeight}px`);
        };
        const ro = new ResizeObserver(publish);
        ro.observe(header, { box: 'border-box' });
        const io = new IntersectionObserver(
            ([entry]) => {
                header.classList.toggle('is-stuck', !entry.isIntersecting);
                // re-measure one frame after the stuck padding lands
                requestAnimationFrame(publish);
            },
            { rootMargin: '-1px 0px 0px 0px' },
        );
        io.observe(sentinel);
        return () => {
            ro.disconnect();
            io.disconnect();
        };
    }, []);

    useEffect(() => {
        let cancelled = false;
        const load = () => {
            fetch(`${import.meta.env.BASE_URL}records.json`)
                .then((r) => {
                    if (!r.ok) throw new Error(`records.json HTTP ${r.status}`);
                    return r.json() as Promise<Ledger>;
                })
                .then((j) => {
                    if (!cancelled) setLedger(j);
                })
                .catch((e: Error) => {
                    if (!cancelled) setLoadError(e.message);
                });
            // Optional — only present once days have rolled off into the archive.
            fetch(`${import.meta.env.BASE_URL}records/archives.json`)
                .then((r) => (r.ok ? (r.json() as Promise<ArchiveManifest>) : null))
                .then((j) => {
                    if (!cancelled) setArchives(j);
                })
                .catch(() => {
                    /* no archives yet — section stays hidden */
                });
        };
        load();
        // The keeper writes records.json while it runs (test cycles land a
        // new row every full cycle) — poll so an open tab sees rows appear
        // without a manual reload.
        const id = window.setInterval(load, 20_000);
        return () => {
            cancelled = true;
            window.clearInterval(id);
        };
    }, []);

    const rowsDesc = useMemo(
        () => (ledger?.rows ?? []).slice().sort((a, b) => b.dayIndex - a.dayIndex),
        [ledger],
    );
    const displayRows = rowsDesc.slice(0, LATEST_DAYS);

    const dismissRotate = () => {
        window.localStorage.setItem('records-rotate-dismissed', '1');
        setRotateDismissed(true);
    };
    const showRotate = !rotateDismissed;

    const body: ReactNode[] = [];
    displayRows.forEach((row, i) => {
        // previous row = the older one; across the slice boundary fall through
        // to the first hidden (older) row so a year band still renders correctly
        const prev = i > 0 ? displayRows[i - 1] : rowsDesc[displayRows.length];
        const year = row.date.slice(0, 4);
        if (!prev || prev.date.slice(0, 4) !== year) {
            body.push(
                <tr className="records-year-row" key={`year-${year}-${row.dayIndex}`}>
                    <th colSpan={4}>{year}</th>
                </tr>,
            );
        }
        body.push(<RecordRowTr key={row.dayIndex} row={row} prev={prev ?? null} />);
    });

    return (
        <div className={`records-shell${showRotate ? ' with-banner' : ''}`} ref={shellRef}>
            <Helmet>
                <title>Trading Day Ledger | AFHO</title>
                <meta
                    name="description"
                    content="One row per NYSE trading day: AFHO offer desk terms, fill scores and market metrics recorded at the open."
                />
            </Helmet>
            {showRotate && (
                <div className="records-rotate-banner" role="status">
                    <span>Rotate your phone; the ledger is built for wide screens.</span>
                    <button className="records-rotate-dismiss" onClick={dismissRotate} aria-label="Dismiss">
                        ✕
                    </button>
                </div>
            )}
            <div ref={sentinelRef} aria-hidden="true" />
            <header className="records-header" ref={headerRef}>
                <nav className="records-nav">
                    <Link to="/">AFHO</Link>
                    <Link to="/offer-desk">Offer desk</Link>
                    <Link to="/litepaper">Litepaper</Link>
                    <Link to="/dash">Dev dash</Link>
                </nav>
                <h2 className="records-title">
                    <GlitchText text="Trading Day Metric Ledger" variant="ghost" split="group" step={0.2} />
                </h2>
                <p className="records-subtitle">one row per trading day; numbers recorded at start of trade day</p>
            </header>

            {loadError && <div className="records-card">Could not load the ledger: {loadError}</div>}
            {!ledger && !loadError && <div className="records-card">Loading the ledger…</div>}
            {ledger && ledger.rows.length === 0 && (
                <div className="records-card">
                    No recorded days yet. The keeper records one row at every market open, or run{' '}
                    <code>anchor run record</code> to snapshot today.
                </div>
            )}

            {ledger && ledger.rows.length > 0 && (
                <div className="records-table-wrap">
                    <table className="records-table">
                        <thead>
                            <tr>
                                <th className="records-th-date">Date</th>
                                <th className="records-th-offer">Offer desk metrics</th>
                                <th>Market numbers</th>
                                <th>Staking / lockups</th>
                            </tr>
                        </thead>
                        <tbody>{body}</tbody>
                    </table>
                </div>
            )}

            {archives && archives.archives.length > 0 && (
                <section className="records-archives">
                    <h3>Older trading days</h3>
                    <p className="records-archives-note">
                        The table above shows the last {LATEST_DAYS} trading days. Every 60 trading days rolls off
                        into a PDF:
                    </p>
                    <ul>
                        {archives.archives.map((a) => (
                            <li key={a.pdf}>
                                <a
                                    href={`${import.meta.env.BASE_URL}records/${a.pdf}`}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                >
                                    Trading days #{a.firstDay}–#{a.lastDay}, {a.days} days (PDF)
                                </a>
                            </li>
                        ))}
                    </ul>
                </section>
            )}
        </div>
    );
}
