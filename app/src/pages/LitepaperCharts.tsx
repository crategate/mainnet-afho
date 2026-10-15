/* LitepaperCharts — the key numbers of the litepaper as three small,
 * dependency-free SVG charts. Values mirror litepaper.md (single source of
 * truth for the prose; these are the visuals). */

const C = {
    blue: 'var(--neon-blue)',
    green: 'var(--neon-green)',
    pink: 'var(--neon-pink)',
    purple: 'var(--neon-purple)',
    amber: 'var(--neon-amber)',
    label: 'var(--text-secondary)',
    value: 'var(--text-primary)',
} as const;

function Donut({
    size = 168,
    stroke = 26,
    segments,
    centerTop,
    centerBottom,
    label,
}: {
    size?: number;
    stroke?: number;
    segments: { pct: number; color: string; label: string }[];
    centerTop: string;
    centerBottom: string;
    label: string;
}) {
    const r = (size - stroke) / 2;
    const circ = 2 * Math.PI * r;
    let acc = 0;
    const cx = size / 2;
    return (
        <svg viewBox={`0 0 ${size} ${size}`} className="chart-svg" role="img" aria-label={label}>
            {/* track */}
            <circle cx={cx} cy={cx} r={r} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth={stroke} />
            {segments.map((s, i) => {
                const len = (s.pct / 100) * circ;
                const dash = `${len} ${circ - len}`;
                const rot = (acc / 100) * 360 - 90;
                acc += s.pct;
                return (
                    <circle
                        key={i}
                        cx={cx}
                        cy={cx}
                        r={r}
                        fill="none"
                        stroke={s.color}
                        strokeWidth={stroke}
                        strokeDasharray={dash}
                        transform={`rotate(${rot} ${cx} ${cx})`}
                    />
                );
            })}
            <text x={cx} y={cx - 4} textAnchor="middle" className="chart-center chart-center-top">{centerTop}</text>
            <text x={cx} y={cx + 14} textAnchor="middle" className="chart-center chart-center-bottom">{centerBottom}</text>
        </svg>
    );
}

function Bars({
    bars,
    max = 20,
    label,
}: {
    bars: { label: string; pct: number; color: string }[];
    max?: number;
    label: string;
}) {
    const h = 150;
    const w = 210;
    const pad = 8;
    const bw = (w - pad * 2) / bars.length;
    const baseY = h - 26;
    return (
        <svg viewBox={`0 0 ${w} ${h}`} className="chart-svg" role="img" aria-label={label}>
            <line x1={pad} y1={baseY} x2={w - pad} y2={baseY} stroke="rgba(255,255,255,0.15)" strokeWidth="1" />
            {bars.map((b, i) => {
                const bh = Math.max((b.pct / max) * (baseY - 18), b.pct > 0 ? 2 : 0);
                const x = pad + i * bw + bw * 0.18;
                const width = bw * 0.64;
                return (
                    <g key={i}>
                        {b.pct > 0 && (
                            <rect x={x} y={baseY - bh} width={width} height={bh} rx="2" fill={b.color} />
                        )}
                        <text x={x + width / 2} y={baseY - bh - 6} textAnchor="middle" className="chart-value">
                            {b.pct}%
                        </text>
                        <text x={x + width / 2} y={h - 8} textAnchor="middle" className="chart-label">
                            {b.label}
                        </text>
                    </g>
                );
            })}
        </svg>
    );
}

function Legend({ items }: { items: { color: string; label: string }[] }) {
    return (
        <ul className="chart-legend">
            {items.map((it, i) => (
                <li key={i}>
                    <span className="chart-swatch" style={{ background: it.color }} />
                    {it.label}
                </li>
            ))}
        </ul>
    );
}

export default function LitepaperCharts() {
    return (
        <div className="charts-grid">
            <div className="chart-card">
                <h3 className="chart-title">Supply split</h3>
                <Donut
                    segments={[
                        { pct: 80, color: C.blue, label: 'Bond desk vault' },
                        { pct: 20, color: C.green, label: 'Raydium pool' },
                    ]}
                    centerTop="1B"
                    centerBottom="AFHO"
                    label="Donut chart: 80% of supply in the bond desk vault, 20% in the Raydium pool"
                />
                <Legend
                    items={[
                        { color: C.blue, label: '80% bond desk vault' },
                        { color: C.green, label: '20% Raydium pool' },
                    ]}
                />
            </div>

            <div className="chart-card">
                <h3 className="chart-title">Bond proceeds split</h3>
                <Donut
                    segments={[
                        { pct: 80, color: C.pink, label: 'Buybacks' },
                        { pct: 10, color: C.amber, label: 'Lockup rewards' },
                        { pct: 10, color: C.purple, label: 'Dip reserve' },
                    ]}
                    centerTop="100%"
                    centerBottom="proceeds"
                    label="Donut chart: 80% of bond proceeds buy back AFHO, 10% funds lockup rewards, 10% refills the dip reserve"
                />
                <Legend
                    items={[
                        { color: C.pink, label: '80% buybacks' },
                        { color: C.amber, label: '10% lockup rewards' },
                        { color: C.purple, label: '10% dip reserve' },
                    ]}
                />
            </div>

            <div className="chart-card">
                <h3 className="chart-title">Unstake penalty by state</h3>
                <Bars
                    bars={[
                        { label: 'OPEN', pct: 0, color: C.green },
                        { label: 'AFTER HRS', pct: 3, color: C.blue },
                        { label: 'CLOSED', pct: 6, color: C.amber },
                        { label: 'HALTED', pct: 18, color: C.pink },
                    ]}
                    max={20}
                    label="Bar chart: unstake penalty by market state, 0% open, 3% after hours, 6% closed, 18% halted"
                />
                <p className="chart-note">principal %, taken on unstake</p>
            </div>
        </div>
    );
}
