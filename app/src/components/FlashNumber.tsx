import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';

/**
 * One-shot glitch whenever a number's value changes.
 *
 * First paint renders plain (an initial load isn't an "update"); every
 * subsequent change remounts the span with a fresh random stagger delay
 * inside `windowMs`, restarting the `fx-num-flash` keyframes in
 * fx-text.css (text-shadow RGB split + blur + a brief color tint).
 * Numbers that update in the same render each roll their own delay, so a
 * batch of simultaneous changes pops individually / in random groups
 * instead of one synchronized block — all settled within `windowMs` +
 * the 450ms animation (defaults keep everything inside 1.5s).
 *
 * The animation lives behind `prefers-reduced-motion: no-preference`, so
 * with reduced motion the number simply updates.
 */

interface FlashNumberProps {
    /** Displayed value — usually the FORMATTED string so a change that
        formats identically (sub-precision price move) doesn't flash. */
    value: string | number | null | undefined;
    className?: string;
    /** Custom renderer; receives the value. Default renders the string. */
    render?: (value: string | number | null | undefined) => ReactNode;
    /** Stagger window in ms — every flash lands at a random delay in
        [0, windowMs). 1000ms + the 450ms animation ≈ all within 1.5s. */
    windowMs?: number;
    disabled?: boolean;
}

/* RGB-split color worlds, matched to the existing glitch palette in
   fx-text.css (pink / cyan / purple / amber). Each instance keeps ONE
   palette for its whole life so a given number's flash always has the
   same hue, while neighbors land on different ones. */
const PALETTES = [
    { a: 'rgba(255, 42, 109, 0.7)', b: 'rgba(0, 240, 255, 0.7)', c: 'rgba(211, 0, 249, 0.55)' },
    { a: 'rgba(0, 240, 255, 0.7)', b: 'rgba(211, 0, 249, 0.65)', c: 'rgba(255, 42, 109, 0.55)' },
    { a: 'rgba(255, 170, 0, 0.6)', b: 'rgba(211, 0, 249, 0.6)', c: 'rgba(0, 240, 255, 0.5)' },
];

export function FlashNumber({
    value,
    className = '',
    render,
    windowMs = 1000,
    disabled = false,
}: FlashNumberProps) {
    // `burst` doubles as the remount key: bumping it replaces the span,
    // which restarts the one-shot CSS animation. Null = first paint.
    const [burst, setBurst] = useState<{ key: number; delay: number } | null>(null);
    const prev = useRef<string | number | null | undefined>(value);
    const first = useRef(true);
    const [palette] = useState(() => PALETTES[Math.floor(Math.random() * PALETTES.length)]);

    useEffect(() => {
        if (first.current) {
            first.current = false;
            prev.current = value;
            return;
        }
        if (prev.current === value) return;
        prev.current = value;
        if (disabled) return;
        // Fresh random stagger per update — same-tick neighbors scatter.
        setBurst((b) => ({ key: (b?.key ?? 0) + 1, delay: Math.random() * windowMs }));
    }, [value, windowMs, disabled]);

    const vars = {
        '--fx-flash-delay': burst ? `${Math.round(burst.delay)}ms` : '0ms',
        '--fx-flash-a': palette.a,
        '--fx-flash-b': palette.b,
        '--fx-flash-c': palette.c,
    } as CSSProperties;

    return (
        <span
            key={burst ? burst.key : 'base'}
            className={`fx-flash${burst ? ' fx-flash--go' : ''}${className ? ` ${className}` : ''}`}
            style={vars}
        >
            {render ? render(value) : value == null ? '—' : String(value)}
        </span>
    );
}

export default FlashNumber;
