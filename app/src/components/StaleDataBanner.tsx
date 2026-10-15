import { useEffect, useRef, useState } from 'react';
import { useChainData } from '../context/useChainData';

/**
 * Full-width emergency banner: the shared chain snapshot has not had a
 * successful fetch for 10 minutes while the tab is visible.
 *
 * Why it exists on mainnet (not just devnet): every visitor tab shares the
 * app's one baked-in public RPC key, so launch traffic can rate-limit it into
 * 429 stretches, and any provider can degrade. The money paths re-gate
 * on-chain (FloorHeldAtSpot, preflight sims), but a user staring at a frozen
 * price deserves to know it's frozen.
 *
 * The heartbeat is `livePriceUpdatedAt` — the shared snapshot's
 * dataUpdatedAt, which advances on EVERY successful fetch (30s poll or
 * WS-triggered), even when nothing on-chain changed. When data recovers the
 * banner vanishes on its own; there is no manual dismiss — a dismissed stall
 * banner is how users end up trading against yesterday's price.
 *
 * Suppressed while a fetch is in flight and for a grace window after the tab
 * becomes visible again: returning to a long-hidden tab fires the
 * enabled-flip recovery refetch, and the banner must not flash while that
 * fetch is trying (or flash-then-vanish when it succeeds).
 */
const STALLED_AFTER_MS = 10 * 60 * 1000;
const TICK_MS = 10_000;
const VISIBLE_GRACE_MS = 15_000;

export function StaleDataBanner() {
    const { livePriceUpdatedAt, snapshotFetching, refresh } = useChainData();
    const [now, setNow] = useState(() => Date.now());
    const visibleAt = useRef<number>(Date.now());

    useEffect(() => {
        const onVis = () => {
            if (!document.hidden) visibleAt.current = Date.now();
        };
        document.addEventListener('visibilitychange', onVis);
        const id = window.setInterval(() => {
            if (!document.hidden) setNow(Date.now());
        }, TICK_MS);
        return () => {
            document.removeEventListener('visibilitychange', onVis);
            window.clearInterval(id);
        };
    }, []);

    const stalled =
        livePriceUpdatedAt !== null &&
        !snapshotFetching &&
        !document.hidden &&
        Date.now() - visibleAt.current > VISIBLE_GRACE_MS &&
        now - livePriceUpdatedAt > STALLED_AFTER_MS;

    if (!stalled) return null;
    const mins = Math.max(1, Math.round((now - livePriceUpdatedAt) / 60_000));

    return (
        <div className="stall-banner" role="alert">
            <span>Live updates stalled ({mins} min) — prices may be out of date.</span>
            <button
                type="button"
                className="stall-banner-refresh"
                onClick={() => {
                    setNow(Date.now());
                    void refresh('livePrice');
                }}
            >
                Refresh
            </button>
        </div>
    );
}

export default StaleDataBanner;
