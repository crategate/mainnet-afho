import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Helmet } from 'react-helmet-async';
import { useDashData, type DashSection } from '../hooks/useDashData';
import './Dash.css';

function StatusDot({ on }: { on: boolean }) {
    return <span className={`dash-dot ${on ? 'on' : 'off'}`} title={on ? 'initialized' : 'not initialized'} />;
}

function Section({ section, hideAddresses }: { section: DashSection; hideAddresses: boolean }) {
    return (
        <section className={`dash-section ${section.initialized ? 'active' : ''}`}>
            <header className="dash-section-header">
                <StatusDot on={section.initialized} />
                <h2>{section.title}</h2>
                <span className="dash-state-label">{section.initialized ? 'active' : 'not initialized'}</span>
            </header>
            <div className="dash-grid">
                {section.fields.map((f) => (
                    <div className="dash-row" key={f.label}>
                        <span className="dash-label">{f.label}</span>
                        <p className="dash-value">{f.value}</p>
                    </div>
                ))}
                {!hideAddresses &&
                    section.addresses.map((a) => (
                        <div className="dash-row dash-addr" key={a.label}>
                            <span className="dash-label">{a.label}</span>
                            <span className="dash-value mono">{a.value}</span>
                        </div>
                    ))}
            </div>
        </section>
    );
}

export default function Dash() {
    const { data, error } = useDashData();
    const [hideAddresses, setHideAddresses] = useState(false);

    return (
        <div className="dash-shell">
            <Helmet>
                <title>Dashboard | AFHO</title>
                <meta
                    name="description"
                    content="Live AFHO protocol dashboard: market status, offer desk, vault balances and on-chain state on Solana."
                />
            </Helmet>
            <header className="dash-topbar">
                <h1>AFHO dev dashboard</h1>
                <div className="dash-controls">
                    {data && <span className="dash-updated">updated {new Date(data.updatedAt).toLocaleTimeString()}</span>}
                    <Link className="dash-toggle" to="/records">
                        Records ledger →
                    </Link>
                    <button className="dash-toggle" onClick={() => setHideAddresses((v) => !v)}>
                        {hideAddresses ? 'Show addresses' : 'Hide all addresses'}
                    </button>
                </div>
            </header>
            {error && <div className="dash-error">RPC error: {error} — showing last known state</div>}
            {!data && !error && <div className="dash-loading">Loading deployment + chain state…</div>}
            {data && (
                <main className="dash-board">
                    {data.sections.map((s) => (
                        <Section key={s.title} section={s} hideAddresses={hideAddresses} />
                    ))}
                    {data.missing.length > 0 && (
                        <footer className="dash-missing">
                            Not found on-chain: {data.missing.join(' · ')}
                        </footer>
                    )}
                </main>
            )}
        </div>
    );
}
