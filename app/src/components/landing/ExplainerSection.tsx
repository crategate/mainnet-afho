import { GlitchText } from '../GlitchText';
import { SplitDonut } from './SplitDonut';

const EXPLAINERS = [
    {
        // Market-hours clock
        icon: (
            <svg viewBox="0 0 24 24" aria-hidden="true">
                <circle cx="12" cy="12" r="9" />
                <polyline points="12 7 12 12 15 14" />
            </svg>
        ),
        title: 'NYSE Hours',
        body: 'When the market is open, after-hours, closed, and halted decides rewards, penalties, and the bond sales.',
    },
    {
        // Stacked layers — stake & multiply
        icon: (
            <svg viewBox="0 0 24 24" aria-hidden="true">
                <polygon points="12 2 2 7 12 12 22 7 12 2" />
                <polyline points="2 17 12 22 22 17" />
                <polyline points="2 12 12 17 22 12" />
            </svg>
        ),
        title: 'Stake & Multiply',
        body: 'Lock AFHO for a cut of bond sales, and fees from impatient exits. Unlock after hours and penalties apply.',
    },
    {
        // Downtrend — buy the dip
        icon: (
            <svg viewBox="0 0 24 24" aria-hidden="true">
                <polyline points="22 17 13.5 8.5 8.5 13.5 2 7" />
                <polyline points="16 17 22 17 22 11" />
            </svg>
        ),
        title: 'Buy the Dip',
        body: '10% of bond proceeds fuel an always active dip sniper, refilling the offer desk and buffering market turbulence',
    },
    {
        // Bank — the bond desk
        icon: (
            <svg viewBox="0 0 24 24" aria-hidden="true">
                <line x1="3" y1="22" x2="21" y2="22" />
                <line x1="6" y1="18" x2="6" y2="11" />
                <line x1="10" y1="18" x2="10" y2="11" />
                <line x1="14" y1="18" x2="14" y2="11" />
                <line x1="18" y1="18" x2="18" y2="11" />
                <polygon points="12 2 20 7 4 7" />
            </svg>
        ),
        title: 'Bond Offer Desk',
        body: "After hours, the offer desk sells vested AFHO bonds. The bonds' metrics depend on the token's own performance.",
    },
];

export function ExplainerSection() {
    return (
        <section className="landing-section alt">
            <div className="landing-section-inner">
                <img src="/Logo/light-on-transparent-logo.png" className='logo' />
                <h2 className="section-title"><GlitchText text="Reward Mechanics" /></h2>
                <p className="section-subtitle">
                    <GlitchText text="AFHO ties token incentives to the tradFi market rhythm." variant="light" split="word" step={0.35} />
                </p>
                <p className="section-subtitle" style={{} as React.CSSProperties}>
                    <GlitchText text="staking, buybacks, and bond sales change with Wall St's market status" variant="light" split="word" step={0.4} />
                </p>
                <div className="explainer-grid">
                    {EXPLAINERS.map((item, index) => (
                        <div
                            key={item.title}
                            className={`explainer-card neon-glitch neon-shadow glass-pane ${['glitch-violet', 'glitch-streetlight', 'glitch-ghost', 'glitch-rose'][index]} ${['shadow-corner-tl', 'shadow-corner-br', 'shadow-corner-bl', 'shadow-corner-tr'][index]}`}
                            style={{
                                '--glitch-delay': `${(index * .2).toFixed(2)}s`,
                                '--shadow-delay': `${(index * 0.9 + 0.4).toFixed(2)}s`,
                            } as React.CSSProperties}
                        >
                            <div className="explainer-icon">{item.icon}</div>
                            <h4>{item.title}</h4>
                            <p>{item.body}</p>
                        </div>
                    ))}
                </div>

                <div
                    className="split-chart neon-glitch neon-shadow shadow-corner-bl glass-pane"
                    style={{ '--glitch-delay': '1.4s', '--shadow-delay': '2s' } as React.CSSProperties}
                >
                    <h4 className="split-title">Bond Offer Proceeds:</h4>
                    <img className="soyjack-point" src="/img/soyjack-2.png" alt="" aria-hidden="true" />
                    <SplitDonut />
                </div>
            </div>
        </section >
    );
}
