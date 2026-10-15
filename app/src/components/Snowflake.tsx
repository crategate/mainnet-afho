import { useEffect, useRef } from 'react';

// Rotate-in-place reveal: when the flake scrolls into view it spins (2s) while
// scaling down from 3x to final size (1.5s), both decelerating to a stop.
// Re-triggers on every re-entry. Reduced motion: static, fully visible glyph.
export function Snowflake() {
    const ref = useRef<HTMLSpanElement>(null);
    useEffect(() => {
        const el = ref.current;
        if (!el) return;
        if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
        const io = new IntersectionObserver(([entry]) => {
            if (!entry.isIntersecting) return;
            el.classList.remove('arrive');
            void el.offsetWidth; // restart the animation
            el.classList.add('arrive');
        }, { threshold: 0.35 });
        io.observe(el);
        return () => io.disconnect();
    }, []);
    return (
        <span ref={ref} className="snowflake" aria-hidden="true">
            <span className="snowflake-rotor">❄</span>
        </span>
    );
}
