import './charts.css';

/* Shared dependency-free SVG charts for the feature pages. Donut/Bars/
   Legend mirror the Litepaper chart language (LitepaperCharts.tsx — kept
   separate so the /litepaper chunk stays untouched); MultiplierCurve is
   the real on-chain staking formula drawn as a line. */

const C = {
    blue: 'var(--neon-blue)',
    green: 'var(--neon-green)',
    pink: 'var(--neon-pink)',
    purple: 'var(--neon-purple)',
    amber: 'var(--neon-amber)',
    cyan: 'var(--neon-cyan)',
} as const;

export function Donut({
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

export function Bars({
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

export function Legend({ items }: { items: { color: string; label: string }[] }) {
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

/* The staking multiplier as drawn on /locking — the ACTUAL on-chain
 * formula (programs/staking calculate_multiplier):
 *   weight = amount × multiplier / 10_000
 *   multiplier = 10_000 + days × (cap − 10_000) / (days + 60),  cap 30_000
 * i.e. 1.0x at day zero, ~2.0x at day 60, approaching 3.0x forever. */
export function MultiplierCurve() {
    const W = 340;
    const H = 190;
    const padL = 34;
    const padR = 12;
    const padT = 14;
    const padB = 30;
    const xMax = 365;
    const yMin = 1;
    const yMax = 3;

    const mult = (d: number) => 1 + (2 * d) / (d + 60);
    const X = (d: number) => padL + (d / xMax) * (W - padL - padR);
    const Y = (m: number) => padT + (1 - (m - yMin) / (yMax - yMin)) * (H - padT - padB);

    // smooth polyline sampled weekly
    const pts: string[] = [];
    for (let d = 0; d <= xMax; d += 7) pts.push(`${X(d).toFixed(1)},${Y(mult(d)).toFixed(1)}`);

    const marks = [
        { d: 0, label: 'day 0' },
        { d: 60, label: 'day 60' },
        { d: 180, label: 'day 180' },
        { d: 365, label: 'day 365' },
    ];

    return (
        <svg viewBox={`0 0 ${W} ${H}`} className="chart-svg" role="img"
            aria-label="Reward multiplier: 1x at day zero, about 2x by day 60, approaching 3x">
            {/* y grid */}
            {[1, 1.5, 2, 2.5, 3].map((m) => (
                <g key={m}>
                    <line x1={padL} y1={Y(m)} x2={W - padR} y2={Y(m)} stroke="rgba(255,255,255,0.07)" strokeWidth="1" />
                    <text x={padL - 6} y={Y(m) + 3} textAnchor="end" className="chart-label">{m.toFixed(1)}x</text>
                </g>
            ))}
            {/* the 3x cap */}
            <line x1={padL} y1={Y(3)} x2={W - padR} y2={Y(3)} stroke={C.amber} strokeWidth="1" strokeDasharray="3 5" opacity="0.7" />
            <text x={W - padR} y={Y(3) - 5} textAnchor="end" className="chart-label" fill={C.amber}>3x cap</text>
            {/* curve */}
            <polyline points={pts.join(' ')} fill="none" stroke={C.cyan} strokeWidth="2.5" strokeLinecap="round" />
            {/* markers */}
            {marks.map((m) => (
                <g key={m.d}>
                    <circle cx={X(m.d)} cy={Y(mult(m.d))} r="3.5" fill={C.cyan} />
                    <text x={X(m.d)} y={Y(mult(m.d)) - 9} textAnchor="middle" className="chart-value">
                        {mult(m.d).toFixed(1)}x
                    </text>
                    <text x={X(m.d)} y={H - 9} textAnchor="middle" className="chart-label">{m.label}</text>
                </g>
            ))}
            <line x1={padL} y1={padT} x2={padL} y2={H - padB} stroke="rgba(255,255,255,0.15)" strokeWidth="1" />
        </svg>
    );
}
