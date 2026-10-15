import { useAmmData } from '../hooks/amm/useAmmData';

/**
 * Full-width spotlight bar shown on every page EXCEPT the offer desk (which
 * renders its own lit state) while the alt sheet window is live: the market
 * is suspended (state 3) and today's fixed-terms sheet has lots remaining.
 *
 * Easter-egg discipline: this component ships NO readable copy. The three
 * constants below are build-time obfuscated (byte-wise XOR with the key,
 * then base64) and are decoded only inside the render path that runs while
 * the window is actually open — grepping the bundle (or this file) finds
 * nothing; the decoded text never enters the DOM outside the window. The
 * visual identity is the banner itself: violet/magenta, intermittent
 * flicker (never a constant pulse — same sparse-keyframe house rules as
 * fx-border), and it links straight to the desk.
 *
 * Regenerate the constants with tools/obfuscate-copy.mjs when the copy
 * changes (temporary tool; run it, paste, delete).
 */
const SPOT_HEADLINE = 'fHoJNTc/LjIzND16KDsoP3owLykuejUqPzQ/Pno1NHouMj96ODU0Pno+Pykx';
const SPOT_DETAIL = 'aUlvf3ovND4/KHo3OygxPy56TnouMjMpei0zND41LXo1NDYj';
const SPOT_CTA = 'DjsxP3o7ejY1NTF6yA==';
const SPOT_KEY = 0x5a;

function decode(b64: string): string {
    const bin = atob(b64);
    let out = '';
    for (let i = 0; i < bin.length; i++) {
        out += String.fromCharCode(bin.charCodeAt(i) ^ SPOT_KEY);
    }
    return out;
}

export function SpotlightBanner() {
    const { altActive } = useAmmData();
    if (!altActive) return null;

    // Decoded only while the window is live (see component doc).
    const headline = decode(SPOT_HEADLINE);
    const detail = decode(SPOT_DETAIL);
    const cta = decode(SPOT_CTA);

    return (
        <a className="spotlight-banner" href="/offer-desk" role="status">
            <span className="spotlight-banner-copy">{headline}</span>
            <span className="spotlight-banner-copy"><em>{detail}</em></span>
            <span className="spotlight-banner-cta" aria-hidden="true">{cta}</span>
        </a>
    );
}

export default SpotlightBanner;
