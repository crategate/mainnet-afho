import { FeaturePage, FeatureCard, FeatureCta } from '../components/FeaturePage';
import { FREEZE_DEFAULTS, freezeBonusBps, freezeMaxDays, freezeRegimeBps } from '../lib/freezeCurve';

/* /freeze — the Freeze explainer. Same shell as the other feature pages:
 * static visuals computed from the real on-chain curve, no wallets. */

const P = FREEZE_DEFAULTS;

/* Chart 1: the rate card. Bonus vs freeze length at three momentum
 * readings, straight from the client mirror of the on-chain formula. */
function RateCardChart() {
    const W = 520, H = 210, PL = 40, PR = 62, PT = 14, PB = 26;
    const maxDaysAll = 120;
    const yMax = 50; // percent
    const x = (d: number) => PL + ((d - P.freezeMinDays) / (maxDaysAll - P.freezeMinDays)) * (W - PL - PR);
    const y = (pct: number) => PT + (1 - pct / yMax) * (H - PT - PB);

    const regimes = [
        { m: 0, label: 'deep bear', color: 'var(--neon-pink)' },
        { m: 4000, label: 'mid tape', color: 'var(--neon-amber)' },
        { m: 8000, label: 'bull', color: 'var(--neon-cyan)' },
    ];
    const series = regimes.map(({ m, ...rest }) => {
        const md = freezeMaxDays(freezeRegimeBps(m, P), P);
        const pts: string[] = [];
        for (let d = P.freezeMinDays; d <= md; d += 1) {
            const pct = freezeBonusBps(d, m, 0, P) / 100;
            pts.push(`${x(d).toFixed(1)},${y(pct).toFixed(1)}`);
        }
        return { ...rest, md, pts, endPct: freezeBonusBps(md, m, 0, P) / 100 };
    });

    return (
        <svg viewBox={`0 0 ${W} ${H}`} className="freeze-chart-svg" role="img"
            aria-label="Freeze bonus by length at three momentum readings. Deep bear reaches 50 percent at 120 days; bull tops out near 7.5 percent at 52 days.">
            {[0, 10, 20, 30, 40, 50].map((v) => (
                <g key={v}>
                    <line className="freeze-grid" x1={PL} x2={W - PR} y1={y(v)} y2={y(v)} />
                    <text className="freeze-tick" x={PL - 6} y={y(v) + 3} textAnchor="end">{v}%</text>
                </g>
            ))}
            {[P.freezeMinDays, 60, maxDaysAll].map((d) => (
                <text key={d} className="freeze-tick" x={x(d)} y={H - 8} textAnchor="middle">{d}d</text>
            ))}
            {series.map((s) => (
                <g key={s.label}>
                    <polyline className="freeze-line" points={s.pts.join(' ')} style={{ stroke: s.color }} />
                    <text className="freeze-line-label" x={W - PR + 6} y={y(s.endPct) + 3} style={{ fill: s.color }}>
                        {s.label}
                    </text>
                </g>
            ))}
        </svg>
    );
}

/* Chart 2: the tape sets the term. Best bonus and longest allowed freeze
 * against momentum: both shrink as the market heats up. */
function TapeSetsTermChart() {
    const W = 520, H = 210, PL = 40, PR = 46, PT = 14, PB = 26;
    const x = (m: number) => PL + (m / 10000) * (W - PL - PR);
    const yPct = (pct: number) => PT + (1 - pct / 50) * (H - PT - PB);
    const yDays = (d: number) => PT + (1 - d / 120) * (H - PT - PB);

    const pctPts: string[] = [];
    const dayPts: string[] = [];
    for (let m = 0; m <= 10000; m += 250) {
        const regime = freezeRegimeBps(m, P);
        const md = freezeMaxDays(regime, P);
        pctPts.push(`${x(m).toFixed(1)},${yPct(freezeBonusBps(md, m, 0, P) / 100).toFixed(1)}`);
        dayPts.push(`${x(m).toFixed(1)},${yDays(md).toFixed(1)}`);
    }

    return (
        <svg viewBox={`0 0 ${W} ${H}`} className="freeze-chart-svg" role="img"
            aria-label="Best bonus and longest allowed freeze versus momentum. Both fall as momentum rises; the bonus collapses to 7.5 percent and the term to 52 days in euphoria.">
            {[0, 10, 20, 30, 40, 50].map((v) => (
                <g key={v}>
                    <line className="freeze-grid" x1={PL} x2={W - PR} y1={yPct(v)} y2={yPct(v)} />
                    <text className="freeze-tick" x={PL - 6} y={yPct(v) + 3} textAnchor="end">{v}%</text>
                </g>
            ))}
            {[0, 60, 120].map((d) => (
                <text key={d} className="freeze-tick" x={W - PR + 6} y={yDays(d) + 3}>{d}d</text>
            ))}
            {[0, 2500, 5000, 7500, 10000].map((m) => (
                <text key={m} className="freeze-tick" x={x(m)} y={H - 8} textAnchor="middle">{m / 1000}k</text>
            ))}
            <polyline className="freeze-line" points={pctPts.join(' ')} style={{ stroke: 'var(--neon-pink)' }} />
            <polyline className="freeze-line" points={dayPts.join(' ')} style={{ stroke: 'var(--neon-green)' }} />
            <text className="freeze-line-label" x={x(500) } y={yPct(50) - 4} style={{ fill: 'var(--neon-pink)' }}>best bonus</text>
            <text className="freeze-line-label" x={x(6500)} y={yDays(96)} style={{ fill: 'var(--neon-green)' }}>longest term</text>
        </svg>
    );
}

export default function Freeze() {
    return (
        <FeaturePage
            eyebrow="Freeze"
            headline="The worse the tape, the better the term."
            lede="Any vested stake can freeze itself for a stretch of trading days. The principal locks, the reward weight picks up a bonus, and the market sets the rate: weak tape means long terms and fat bonuses. Euphoria gets a shrug."
            title="Freeze | After Hours"
            description="Freeze a vested stake for a trading-day term and multiply its reward weight. Anti-cyclical rates fixed on-chain at the moment of the freeze."
        >
            <div className="feature-chart-row">
                <div className="feature-chart glass-pane">
                    <h3>The rate card</h3>
                    <RateCardChart />
                    <p className="chart-note">
                        The real curve, computed from the on-chain formula at
                        three momentum readings. Every line ends where the
                        market stops offering: 120 days in a deep bear, 52 in
                        a bull run.
                    </p>
                </div>
                <div className="feature-chart glass-pane">
                    <h3>The tape sets the term</h3>
                    <TapeSetsTermChart />
                    <p className="chart-note">
                        Both knobs turn with momentum. When the tape is
                        bleeding, the protocol pays the most for the longest
                        commitments. When it is running, it barely pays at all.
                    </p>
                </div>
            </div>

            <div className="feature-grid">
                <FeatureCard title="A term deposit, on chain">
                    <p>
                        The rate is fixed the moment you freeze. Momentum can
                        swing, the card can reprice for everyone else, and
                        your bonus stays exactly where it was when you signed.
                    </p>
                </FeatureCard>
                <FeatureCard title="Tenure still counts">
                    <p>
                        The bonus multiplies your base multiplier; it never
                        replaces it. A stake with history always outweighs a
                        fresh one at the same rate, so churning into new
                        freezes can never pay.
                    </p>
                </FeatureCard>
                <FeatureCard title="Claim by the bell">
                    <p>
                        Rewards stay claimable at every opening bell while
                        frozen. When a freeze ends you get a short grace
                        window to collect; anything still sitting after that
                        goes back to the pool for the stakers who stayed.
                    </p>
                </FeatureCard>
                <FeatureCard title="Demand cools the card">
                    <p>
                        Freeze enough of the staked supply and the offered
                        rates step down on their own. No new tokens are
                        minted: the bonus only re-slices the existing reward
                        flow toward committed capital.
                    </p>
                </FeatureCard>
            </div>

            <FeatureCta
                href="/"
                label="Stake AFHO"
                note="Freeze buttons live on your position cards, market hours only."
                internal
            />
        </FeaturePage>
    );
}
