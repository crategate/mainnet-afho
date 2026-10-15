import { memo, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Helmet } from 'react-helmet-async';
import { useWallet } from '@solana/wallet-adapter-react';
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui';
import { GlitchText } from '../components/GlitchText';
import { AfhoWalletButton } from '../components/AfhoWalletButton';
import { Snowflake } from '../components/Snowflake';
import { SolscanMark } from '../components/BrandIcons';
import { useDeployment } from '../hooks/useDeployment';
import { useWalletActivity } from '../hooks/useWalletActivity';
import type { ActivityEvent } from '../lib/activityDecode';
import './Activity.css';

/* The Tape (/activity) — every confirmed transaction the connected wallet
   has made against the AFHO programs (stake, freeze, claims, bond desk),
   newest on top. Plain wallet-to-wallet transfers and DEX fills ride
   behind a reveal toggle; failed attempts never print. */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const TIER_NAMES = ['sml', 'med', 'big'];

const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 });

function fmtWhen(ts: number | null): { date: string; time: string; full: string } {
    if (ts === null) return { date: '—', time: '', full: '' };
    const d = new Date(ts * 1000);
    const year = d.getFullYear() !== new Date().getFullYear() ? ` ${d.getFullYear()}` : '';
    return {
        date: `${MONTHS[d.getMonth()]} ${d.getDate()}${year}`,
        time: `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(
            d.getSeconds(),
        ).padStart(2, '0')}`,
        full: d.toLocaleString(),
    };
}

function fmtAfho(delta: bigint | null): string {
    if (delta === null || delta === 0n) return '—';
    const sign = delta > 0n ? '+' : '−';
    return sign + compact.format(Number(delta < 0n ? -delta : delta) / 1e9);
}

function afhoSign(delta: bigint | null): 'pos' | 'neg' | 'zero' {
    if (delta === null || delta === 0n) return 'zero';
    return delta > 0n ? 'pos' : 'neg';
}

function fmtSol(lamports: number): string {
    return (lamports / 1e9).toFixed(3).replace(/0+$/, '').replace(/\.$/, '') + ' SOL';
}

function shortAddr(a: string): string {
    return `${a.slice(0, 4)}…${a.slice(-4)}`;
}

function solscanUrl(signature: string, cluster?: string): string {
    const suffix =
        cluster && cluster !== 'mainnet' && cluster !== 'mainnet-beta' ? `?cluster=${cluster}` : '';
    return `https://solscan.io/tx/${signature}${suffix}`;
}

function detailLine(e: ActivityEvent): string {
    switch (e.kind) {
        case 'stake':
            return `position #${e.positionIndex ?? '?'}${e.days ? ` · ${e.days}d lock` : ''}`;
        case 'freeze':
            return `position #${e.positionIndex ?? '?'} · ${e.days ?? '?'} days`;
        case 'settle':
            return `position #${e.positionIndex ?? '?'}`;
        case 'unstake':
            return e.positionIndex !== undefined ? `position #${e.positionIndex}` : 'position closed';
        case 'claim':
            return 'rewards';
        case 'bond':
            return `${TIER_NAMES[e.tier ?? 0] ?? '?'} tier · ${e.units ?? '?'} units · sheet day ${
                e.sheetDay ?? '?'
            }${e.altDesk ? ' · alt desk' : ''}${e.payLeg === 'sol' ? ' · paid in SOL' : ''}`;
        case 'position':
            return `position #${e.positionIndex ?? '?'}${e.days ? ` · ${e.days}d vest` : ''}`;
        case 'protocol':
            return e.ixName ?? 'protocol';
        case 'sent':
            return e.counterparty ? `to ${shortAddr(e.counterparty)}` : 'burn';
        case 'received':
            return e.counterparty ? `from ${shortAddr(e.counterparty)}` : 'minted';
        case 'swap':
            return 'DEX fill';
    }
}

const KIND_LABEL: Record<ActivityEvent['kind'], string> = {
    stake: 'STAKE',
    unstake: 'UNSTAKE',
    claim: 'COLLECT',
    freeze: 'FREEZE',
    settle: 'SETTLE',
    bond: 'BOND',
    position: 'POSITION',
    protocol: 'OPS',
    sent: 'SENT',
    received: 'RECEIVED',
    swap: 'SWAP',
};

/* One quiet glyph per event family, set in the same slot the snowflake
   occupies. Freeze keeps its animated Snowflake; kinds without a glyph
   (position, protocol) ride bare. */
const KIND_GLYPH: Partial<Record<ActivityEvent['kind'], string>> = {
    stake: '▼',
    unstake: '▲',
    claim: '✦',
    settle: '✓',
    bond: '⧗',
    sent: '↗',
    received: '↙',
    swap: '⇄',
};

const ActivityRow = memo(function ActivityRow({
    event,
    cluster,
}: {
    event: ActivityEvent;
    cluster?: string;
}) {
    const when = fmtWhen(event.blockTime);
    const solLeg =
        event.kind === 'bond' && event.payLeg === 'sol' && event.solDelta !== null && event.solDelta < 0
            ? ` · ${fmtSol(-event.solDelta)}`
            : '';
    const detail = detailLine(event) + solLeg;
    return (
        <li
            className="act-row act-grid"
            data-kind={event.kind}
            data-manual={event.manual}
            title={when.full}
        >
            <div className="act-when act-c-when">
                <span className="act-when-date">{when.date}</span>
                <span className="act-when-time">{when.time}</span>
            </div>
            <div className="act-detail act-c-detail" title={detail}>
                {detail}
            </div>
            <div className="act-event act-c-event">
                {event.kind === 'freeze' ? (
                    <Snowflake />
                ) : (
                    KIND_GLYPH[event.kind] && (
                        <span className="act-glyph" aria-hidden="true">
                            {KIND_GLYPH[event.kind]}
                        </span>
                    )
                )}
                <span>{KIND_LABEL[event.kind]}</span>
            </div>
            <div className="act-afho act-c-afho">
                <span className="act-afho-num" data-sign={afhoSign(event.afhoDelta)}>
                    {fmtAfho(event.afhoDelta)}
                </span>
            </div>
            <div className="act-tx act-c-tx">
                <a
                    className="act-scan"
                    href={solscanUrl(event.signature, cluster)}
                    target="_blank"
                    rel="noreferrer"
                >
                    <span className="act-scan-mark">
                        <SolscanMark size={13} />
                    </span>
                    <span className="act-scan-sig">{shortSig(event.signature)}</span>
                </a>
            </div>
        </li>
    );
});

function shortSig(sig: string): string {
    return `${sig.slice(0, 6)}…${sig.slice(-4)}`;
}

export default function Activity() {
    const { connected, publicKey } = useWallet();
    const { deployment } = useDeployment();
    const { events, status, error, progress, hasMore, loadMore } = useWalletActivity(
        publicKey,
        deployment,
    );
    const [showTransfers, setShowTransfers] = useState(false);

    const visible = useMemo(
        () => (showTransfers ? events : events.filter((e) => !e.manual)),
        [events, showTransfers],
    );
    const protocolCount = events.length - events.filter((e) => e.manual).length;
    const manualCount = events.length - protocolCount;
    const cluster = deployment?.cluster;
    const firstLoad = status === 'loading' && events.length === 0;

    return (
        <div className="act-shell">
            <Helmet>
                <title>The Tape | AFHO</title>
                <meta
                    name="description"
                    content="Every confirmed transaction the connected wallet has made against the AFHO protocol: stakes, freezes, claims and bond desk fills."
                />
            </Helmet>

            <header className="act-header">
                <div className="act-toprow">
                    <nav className="act-nav">
                        <Link to="/">AFHO</Link>
                        <Link to="/offer-desk">Offer desk</Link>
                        <Link to="/records">Records</Link>
                    </nav>
                    <div className="act-wallet">
                        <AfhoWalletButton />
                    </div>
                </div>
                <h2 className="act-title">
                    <GlitchText text="The Tape" variant="ghost" split="group" step={0.2} />
                </h2>
                <p className="act-subtitle">
                    every confirmed print this wallet has made against the AFHO machinery, newest first
                </p>
            </header>

            {!connected ? (
                <div className="connect-prompt act-connect">
                    <span className="glitch-border" aria-hidden="true" />
                    <h2>
                        <GlitchText text="Connect Wallet" variant="light" />
                    </h2>
                    <p>
                        <GlitchText
                            text="Connect your wallet to read its tape against the protocol."
                            variant="light"
                            split="word"
                            step={0.22}
                        />
                    </p>
                    <div className="wallet-button-wrapper">
                        <WalletMultiButton />
                    </div>
                </div>
            ) : !deployment ? (
                <div className="act-note">Loading deployment…</div>
            ) : (
                <>
                    <div className="act-controls">
                        <span className="act-count">
                            {protocolCount} protocol print{protocolCount === 1 ? '' : 's'}
                            {showTransfers && manualCount > 0
                                ? ` · ${manualCount} transfer${manualCount === 1 ? '' : 's'} shown`
                                : ''}
                        </span>
                        {manualCount > 0 && (
                            <button
                                type="button"
                                className="act-toggle"
                                onClick={() => setShowTransfers((v) => !v)}
                            >
                                {showTransfers ? 'Hide manual transfers' : 'Show manual transfers'}
                            </button>
                        )}
                    </div>

                    <div className="act-sheet">
                        <div className="act-bar act-grid" aria-hidden="true">
                            <span className="act-c-when">When</span>
                            <span className="act-c-detail">Detail</span>
                            <span className="act-c-event">Event</span>
                            <span className="act-c-afho">AFHO</span>
                            <span className="act-c-tx">Tx</span>
                        </div>
                        <ol className="act-rows">
                            {visible.map((e) => (
                                <ActivityRow key={e.signature} event={e} cluster={cluster} />
                            ))}
                        </ol>
                    </div>

                    {firstLoad && (
                        <div className="act-note" role="status">
                            Reading the tape…
                            {progress && progress.of > 0
                                ? ` ${progress.done}/${progress.of}`
                                : ''}
                        </div>
                    )}
                    {status === 'error' && (
                        <div className="act-note" role="alert">
                            The RPC cut the read short: {error}
                            <button type="button" className="act-toggle act-retry" onClick={loadMore}>
                                Retry
                            </button>
                        </div>
                    )}
                    {status === 'ready' && visible.length === 0 && (
                        <div className="act-note">
                            No protocol activity for this wallet yet. Stake, freeze or buy a bond and
                            it prints here.
                            {manualCount > 0 && ' This wallet also has plain AFHO transfers behind the toggle.'}
                        </div>
                    )}

                    <div className="act-foot">
                        {hasMore && !firstLoad && status !== 'error' && (
                            <button
                                type="button"
                                className="act-toggle act-older"
                                onClick={loadMore}
                                disabled={status === 'loading'}
                            >
                                {status === 'loading' ? 'Reading…' : 'Load older prints'}
                            </button>
                        )}
                        {!hasMore && events.length > 0 && (
                            <span className="act-exhausted">That is the whole tape.</span>
                        )}
                        <p className="act-foot-note">
                            Confirmed transactions only; failed attempts never print. Protocol events
                            by default. Manual transfers and DEX fills ride behind the toggle.
                        </p>
                    </div>
                </>
            )}
        </div>
    );
}
