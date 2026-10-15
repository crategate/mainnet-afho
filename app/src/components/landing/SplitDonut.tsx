import { useEffect, useRef } from 'react';

const SPLIT = [
    { label: 'Buybacks', value: 80, color: 'var(--neon-cyan)' },
    { label: 'Dip Reserve', value: 10, color: 'var(--neon-pink)' },
    { label: 'to Stakers', value: 10, color: 'var(--neon-purple)' },
] as const;

const VIEWBOX = 240;
const CENTER = VIEWBOX / 2;
const RADIUS = 72;
const STROKE = 34;
const LABEL_RADIUS = 112;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

export function SplitDonut() {
    const wrapperRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const wrapper = wrapperRef.current;
        if (!wrapper) return;

        const media = window.matchMedia('(prefers-reduced-motion: reduce)');
        if (media.matches) {
            wrapper.style.setProperty('--donut-rotation', '0deg');
            return;
        }

        let angle = 0;
        let last = performance.now();
        let raf = 0;

        const animate = (t: number) => {
            const dt = (t - last) / 1000;
            last = t;

            // Slow, meandering rotation — always positive, never fast.
            const speed = Math.max(
                0.35,
                2.2 + 1.1 * Math.sin(t / 13000) + 0.6 * Math.sin(t / 7100)
            );
            angle += speed * dt;
            wrapper.style.setProperty('--donut-rotation', `${angle}deg`);
            raf = requestAnimationFrame(animate);
        };

        raf = requestAnimationFrame(animate);
        return () => cancelAnimationFrame(raf);
    }, []);

    let accumulated = 0;

    return (
        <div className="split-donut" ref={wrapperRef} aria-label="Bond offer proceeds: 80% buybacks, 10% dip reserve, 10% to stakers">
            <svg
                className="donut-svg"
                viewBox={`0 0 ${VIEWBOX} ${VIEWBOX}`}
                role="img"
                aria-hidden="true"
            >
                <g className="donut-rotate">
                    {SPLIT.map((s, i) => {
                        const fraction = s.value / 100;
                        const arc = fraction * CIRCUMFERENCE;
                        const offset = -(accumulated * CIRCUMFERENCE);
                        accumulated += fraction;

                        return (
                            <circle
                                key={s.label}
                                className="donut-segment"
                                cx={CENTER}
                                cy={CENTER}
                                r={RADIUS}
                                fill="none"
                                stroke={s.color}
                                strokeWidth={STROKE}
                                strokeDasharray={`${arc} ${CIRCUMFERENCE}`}
                                strokeDashoffset={offset}
                                style={{ '--seg-color': s.color, '--seg-delay': `${-i * 7}s` } as React.CSSProperties}
                            />
                        );
                    })}

                    {SPLIT.map((s, i) => {
                        const fraction = s.value / 100;
                        const start = SPLIT.slice(0, i).reduce((a, b) => a + b.value, 0) / 100;
                        const midAngle = (start + fraction / 2) * 2 * Math.PI;
                        const x = CENTER + LABEL_RADIUS * Math.cos(midAngle);
                        const y = CENTER + LABEL_RADIUS * Math.sin(midAngle);

                        return (
                            <g
                                key={`label-${s.label}`}
                                className="donut-label"
                                style={{ '--label-x': `${x}px`, '--label-y': `${y}px`, '--seg-color': s.color } as React.CSSProperties}
                            >
                                <circle className="donut-label-dot" r={3} fill={s.color} />
                                <text className="donut-label-text" dy="-0.35em">
                                    <tspan className="donut-label-value" x={0}>{s.value}%</tspan>
                                    <tspan className="donut-label-name" x={0} dy="1.2em">{s.label}</tspan>
                                </text>
                            </g>
                        );
                    })}
                </g>
            </svg>

            <div className="donut-legend" aria-hidden="true">
                {SPLIT.map((s) => (
                    <span key={s.label} className="donut-legend-item">
                        <span className="donut-legend-swatch" style={{ backgroundColor: s.color }} />
                        {s.label}
                    </span>
                ))}
            </div>
        </div>
    );
}
