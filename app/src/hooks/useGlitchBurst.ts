import { useEffect, useRef, type RefObject } from 'react';

const BURST_DURATION_MS = 450;
const ACTIVITY_IDLE_MS = 900;

/**
 * Makes the shell react to the user without strobing:
 *
 * - `data-glitch-burst`   — a short ~450ms flare on click / focus / scroll
 *   that re-arms glitch animations at a slightly faster pace. Mouse movement
 *   deliberately does NOT trigger bursts (too frantic); it only feeds the
 *   cursor/activity channels below.
 * - `data-active`         — true while the user has interacted within the
 *   last ~900ms. Drives the global "tempo" and the cursor spotlight.
 * - `--mouse-x` / `--mouse-y` — cursor position in 0..1 viewport fractions.
 * - `--scroll-y`          — page scroll progress in 0..1, for parallax.
 */
export function useGlitchBurst(ref: RefObject<HTMLDivElement | null>) {
    const burstTimer = useRef<number | null>(null);
    const idleTimer = useRef<number | null>(null);

    useEffect(() => {
        const el = ref.current;
        if (!el) return;
        const last: Record<string, number> = {};

        el.style.setProperty('--mouse-x', '0.5');
        el.style.setProperty('--mouse-y', '0.5');
        el.style.setProperty('--scroll-y', '0');

        const markActive = () => {
            el.setAttribute('data-active', 'true');
            if (idleTimer.current !== null) window.clearTimeout(idleTimer.current);
            idleTimer.current = window.setTimeout(() => {
                el.removeAttribute('data-active');
            }, ACTIVITY_IDLE_MS);
        };

        const trigger = () => {
            el.setAttribute('data-glitch-burst', 'true');
            if (burstTimer.current !== null) window.clearTimeout(burstTimer.current);
            burstTimer.current = window.setTimeout(() => {
                el.removeAttribute('data-glitch-burst');
            }, BURST_DURATION_MS);
        };

        const throttled = (key: string, ms: number) => () => {
            const now = Date.now();
            if (now - (last[key] ?? 0) < ms) return;
            last[key] = now;
            markActive();
            trigger();
        };

        const onScroll = () => {
            const now = Date.now();
            if (now - (last['scroll'] ?? 0) >= 300) {
                last['scroll'] = now;
                markActive();
                trigger();
            }
            const doc = document.documentElement;
            const max = doc.scrollHeight - window.innerHeight;
            el.style.setProperty('--scroll-y', (max > 0 ? Math.min(1, Math.max(0, window.scrollY / max)) : 0).toFixed(3));
        };

        const onMouseMove = (e: MouseEvent) => {
            // Cursor vars update on every event for a smooth spotlight;
            // activity flips on, but no burst — motion alone stays calm.
            el.style.setProperty('--mouse-x', (e.clientX / window.innerWidth).toFixed(3));
            el.style.setProperty('--mouse-y', (e.clientY / window.innerHeight).toFixed(3));
            const now = Date.now();
            if (now - (last['mousemove'] ?? 0) >= 120) {
                last['mousemove'] = now;
                markActive();
            }
        };

        const onClick = throttled('click', 0);
        const onFocus = throttled('focusin', 0);

        window.addEventListener('scroll', onScroll, { passive: true });
        window.addEventListener('mousemove', onMouseMove, { passive: true });
        window.addEventListener('click', onClick, true);
        window.addEventListener('focusin', onFocus, true);

        return () => {
            window.removeEventListener('scroll', onScroll);
            window.removeEventListener('mousemove', onMouseMove);
            window.removeEventListener('click', onClick, true);
            window.removeEventListener('focusin', onFocus, true);
            if (burstTimer.current !== null) window.clearTimeout(burstTimer.current);
            if (idleTimer.current !== null) window.clearTimeout(idleTimer.current);
        };
    }, [ref]);
}
