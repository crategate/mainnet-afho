import { Fragment, type CSSProperties, type ReactNode } from 'react';

interface GlitchTextProps {
    text: string;
    /** color world of the shadow glitch */
    variant?: 'default' | 'bluepink' | 'streetlight' | 'ghost' | 'light';
    /** letter: per-character spans; word: per-word; group: random-ish
        chunks of 1-3 characters so neighboring letters glitch together */
    split?: 'letter' | 'word' | 'group';
    className?: string;
    /** seconds of stagger per span; neighbors run their own clocks */
    step?: number;
}

/* Deterministic group sizes so the chunking is stable across renders */
const GROUP_SIZES = [2, 1, 3, 2, 1, 2, 3, 1];

/* Deterministic scatter: neighboring spans get far-apart delays instead
   of a left-to-right cascade. 13 is prime so the order cycles through
   every phase before repeating. */
const scatter = (i: number) => (i * 7) % 13;

function splitGroup(text: string): string[] {
    const parts: string[] = [];
    let i = 0;
    let s = 0;
    while (i < text.length) {
        const n = GROUP_SIZES[s % GROUP_SIZES.length];
        parts.push(text.slice(i, i + n));
        i += n;
        s += 1;
    }
    return parts;
}

/**
 * Splits a text body into per-span glitch units so each unit runs its
 * own animation with a slight cascade. Disconnected: a loose,
 * out-of-sync cascade. Connected: the CSS tightens the stagger and
 * speeds the cycle so the whole word lands on one regular rhythm.
 */
export function GlitchText({
    text,
    variant = 'default',
    className = '',
    step = 0.06,
    split = 'letter',
}: GlitchTextProps) {
    const cssVars = (i: number) =>
        ({ '--i': scatter(i), '--letter-stagger': `${step}s` }) as CSSProperties;

    let children: ReactNode;
    if (split === 'word') {
        children = text.split(' ').map((word, i) => (
            <Fragment key={i}>
                <span aria-hidden="true" style={cssVars(i)}>
                    {word}
                </span>
                {i < text.split(' ').length - 1 && ' '}
            </Fragment>
        ));
    } else {
        const parts = split === 'group' ? splitGroup(text) : text.split('');
        children = parts.map((ch, i) => (
            <span key={i} aria-hidden="true" style={cssVars(i)}>
                {ch.replace(/ /g, '\u00A0')}
            </span>
        ));
    }

    return (
        <span
            className={`glitch-letters glitch-letters--${variant} glitch-letters--${split} ${className}`.trim()}
            aria-label={text}
        >
            {children}
        </span>
    );
}
