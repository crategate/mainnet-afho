import { useEffect, useState } from 'react';
import stateImagePools from 'virtual:state-images';
import { useMarketStatus } from '../hooks/useMarketStatus.ts';
import { useAmmData } from '../hooks/amm/useAmmData.ts';
import { PublicKey } from '@solana/web3.js';
import { GlitchText } from './GlitchText.tsx';
import './MarketStatus.css';

/* Per-state scene art (public/img/status-*.svg) — dark, low-contrast
 * backdrops layered UNDER the tint gradient below, so the palette still
 * belongs to the state theme. Keep any new art dim: text sits on top.
 * These are the FALLBACK: a photo pool (below) wins when it has images. */
const STATE_BG: Record<number, string> = {
    0: '/img/status-open.svg',
    1: '/img/status-after-hours.svg',
    2: '/img/status-closed.svg',
    3: '/img/status-halted.svg',
};

/* ── Desk substate ──
 * The desk granularity the photo pools and the subtitle copy share:
 * states 0/3 are single-pool 'default'; states 1/2 split by desk status —
 * desk-open (state 1's live desk = after-hours), nite-bonus (state 2's live
 * desk = the late-nite window, +0.5%), sold-out (today's sheet fully
 * claimed), desk-wait (gate/floor/warmup not met).
 * Mirrors useAmmData's deskOpen semantics exactly. */
type DeskSub = 'default' | 'desk-open' | 'nite-bonus' | 'desk-wait' | 'sold-out';

interface DeskSignals {
    deskOpen: boolean;
    sheetDay: number | null;
    tradingDay: number | null;
    offersLive: boolean;
    anyOffered: boolean;
}

function deskSubstate(state: number, desk: DeskSignals): DeskSub {
    if (state !== 1 && state !== 2) return 'default';
    if (desk.deskOpen) return state === 2 ? 'nite-bonus' : 'desk-open';
    const sheetToday =
        desk.sheetDay !== null && desk.tradingDay !== null && desk.sheetDay === desk.tradingDay;
    if (sheetToday && desk.anyOffered && !desk.offersLive) return 'sold-out';
    return 'desk-wait';
}

/* ── Photo pools (public/state-images/) ──
 * One random image per page load, keyed by the same state + desk substate
 * as the subtitle — refresh rerolls; a substate flip (desk opens, sells
 * out, state changes) swaps the pool AND the copy together. The manifest
 * comes from the vite plugin, so dropping files into the folders is the
 * entire update workflow. Empty substate pools fall up to the state's
 * default/ pool, then the SVG scenes, then the plain tint — never a
 * broken tile. */
const STATE_FOLDER: Record<number, string> = {
    0: '0-open',
    1: '1-extended',
    2: '2-closed',
    3: '3-halted',
};

function poolKeyFor(state: number, sub: DeskSub): string | null {
    const folder = STATE_FOLDER[state];
    return folder ? `${folder}/${sub}` : null;
}

function pickPhoto(state: number, key: string | null): { url: string; pos: string } | null {
    if (!key) return null;
    const folder = STATE_FOLDER[state];
    const pool =
        stateImagePools.pools[key] ??
        (folder ? stateImagePools.pools[`${folder}/default`] : undefined) ??
        [];
    if (!pool.length) return null;
    const url = pool[Math.floor(Math.random() * pool.length)];
    return { url, pos: stateImagePools.focal[url] ?? '50% 42%' };
}

/* ── Subtitle copy ──
 * Same matrix as the pools: the subtitle says what the picture shows.
 * Title + pill stay the market-state identity; this line carries the desk
 * status (live / waiting / sold out) plus the standing exit-penalty note.
 * State 3 gets an alt-sheet variant when the circuit-breaker window is
 * actually open (copy-only refinement — the halted pool stays single). */
const SUBTITLES: Record<number, Partial<Record<DeskSub, string>>> = {
    0: {
        default:
            'NYSE is open. Reward claims available, no penalties to exit. The bond desk waits for the close.',
    },
    1: {
        default:
            'Extended hours trading. The bond desk posts its sheet after the close. Small penalty to exit positions.',
        'desk-open':
            "market status: after hours. The bond desk is live — discounted vesting AFHO while the street is out. Small penalty to exit positions.",
        'desk-wait':
            "in after hours trading. The desk is dark — discounts aren't deep enough to open yet. Small penalty to exit positions.",
        'sold-out':
            "After hours market. Tonight's sheet is fully claimed — restock after the next open. Small penalty to exit positions.",
    },
    2: {
        default:
            'Markets are closed. The bond desk is dark — next sheet after the open. Medium penalties to principle for exiting positions.',
        'nite-bonus':
            'Markets closed. The late-nite desk is live — every remaining lot carries the +0.5% bonus. Medium penalties to principle for exiting.',
        'desk-wait':
            'Markets are closed. No live offers — the desk wants deeper discounts first. Medium penalties to principle for exiting positions.',
        'sold-out':
            "Markets are closed. The late-nite sheet sold out — next sheet after the open. Medium penalties to principle for exiting positions.",
    },
    3: {
        default: 'Trading halted due to volatility. Severe penalties active.',
    },
};

const HALT_SHEET_SUBTITLE =
    'Trading halted. The circuit-breaker sheet is live — fixed-term lots at a set cut. Severe penalties to exit.';

function subtitleFor(state: number, sub: DeskSub, altActive: boolean): string {
    if (state === 3 && altActive) return HALT_SHEET_SUBTITLE;
    return (
        SUBTITLES[state]?.[sub] ??
        SUBTITLES[state]?.default ??
        'Waiting for oracle…'
    );
}

/* ── Pill + heading copy ──
 * TWO SEPARATE strings: the colored pill is the short state chip, the main
 * heading under it is the full label. Each has its own map — assign them
 * independently; nothing forces them to match. */
const STATE_PILL: Record<number, string> = {
    0: 'Market Open',
    1: 'Extended Hours',
    2: 'Market Closed',
    3: 'Trading Halted',
};

const STATE_HEADING: Record<number, string> = {
    0: 'Market Open',
    1: 'Extended Hours',
    2: 'Market Closed',
    3: 'Trading Halted',
};

function statePill(state: number): string {
    return STATE_PILL[state] ?? 'Unknown';
}

/* Current hour in US Eastern time — state 1 is premarket before open (morning)
   and after-hours after close (afternoon/evening). */
function nyHour(d = new Date()): number {
    return Number(
        new Intl.DateTimeFormat('en-US', {
            timeZone: 'America/New_York',
            hour: 'numeric',
            hourCycle: 'h23',
        }).format(d),
    );
}

function stateHeading(state: number): string {
    if (state === 1) {
        return nyHour() < 12 ? 'Premarket Hours Trading' : 'Market in After Hours now';
    }
    return STATE_HEADING[state] ?? 'Unknown';
}

interface MarketStatusProps {
    marketStatusPda?: PublicKey;
    variant?: 'full' | 'hero' | 'compact';
}

export function MarketStatus({ marketStatusPda, variant = 'full' }: MarketStatusProps) {
    const { data, loading, error } = useMarketStatus(marketStatusPda);
    const { deskOpen, sheetDay, tradingDay, offersLive, tiers, altActive } = useAmmData();

    const state = data?.state ?? 99;
    const pill = statePill(state);
    const heading = stateHeading(state);
    const sub = deskSubstate(state, {
        deskOpen,
        sheetDay,
        tradingDay,
        offersLive,
        anyOffered: tiers.some((t) => t.totalOffered > 0),
    });
    const subtitle = subtitleFor(state, sub, altActive);

    // Random per mount; re-rolls ONLY when the pool itself changes (state
    // flip, desk opens, sell-out) — a plain re-render never shuffles it.
    const poolKey = poolKeyFor(state, sub);
    const [photo, setPhoto] = useState(() => pickPhoto(state, poolKey));
    useEffect(() => {
        setPhoto(pickPhoto(state, poolKey));
    }, [poolKey, state]);

    const bg = photo?.url ?? STATE_BG[state];

    return (
        <div
            className={`market-status-bg market-status-${variant}`}
            data-market-state={state}
            data-photo={photo ? '1' : undefined}
            style={bg ? ({
                '--status-bg': `url(${bg})`,
                '--status-pos': photo?.pos ?? '50% 42%',
            } as React.CSSProperties) : undefined}
            aria-live="polite"
        >
            <div className="market-status-grid" aria-hidden="true" />

            <header className="market-status-header">
                {loading ? (
                    <h1>Syncing with Oracle…</h1>
                ) : error ? (
                    <>
                        <h1 className="status-error">Oracle Offline</h1>
                        <p className="status-detail">{error}</p>
                        <p className="status-meta">Check the RPC connection and crank oracle deployment.</p>
                    </>
                ) : (
                    <>
                        <div className="status-pill">{pill}</div>
                        <h1 className="status-title">{heading}</h1>
                        <p className="status-detail">
                            {variant === 'hero' ? (
                                <GlitchText
                                    text={subtitle}
                                    variant="light"
                                    split="word"
                                    step={0.4}
                                />
                            ) : (
                                subtitle
                            )}
                        </p>
                        {data && (
                            <p className="status-meta">
                                Trading Day #{data.tradingDay} · Market state since{' '}
                                {new Date(data.timestamp * 1000).toLocaleTimeString()}
                            </p>
                        )}
                    </>
                )}
            </header>
        </div>
    );
};
