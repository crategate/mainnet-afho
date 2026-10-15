/* Explorer brand marks for the transaction-result modal buttons. Drawn as
   inline SVG (no runtime fetch, no license-noise asset files) at the sizes
   the buttons actually render. Colors sampled from each brand's favicon. */

interface BrandMarkProps {
    size?: number;
}

/* Solscan: teal ring broken at 4-5 o'clock with a diagonal tail, purple
   dot at center. Ring runs mid-radius 19 (stroke 9) on a 48 grid; the tail
   rides the 45° diagonal past the ring's outer edge. */
export function SolscanMark({ size = 18 }: BrandMarkProps) {
    return (
        <svg viewBox="0 0 48 48" width={size} height={size} aria-hidden="true" focusable="false">
            <path
                d="M32.92 40.79 A19 19 0 1 1 40.79 32.92"
                fill="none"
                stroke="#00E8B5"
                strokeWidth="9"
            />
            <line
                x1="37.44"
                y1="37.44"
                x2="42.4"
                y2="42.4"
                stroke="#00E8B5"
                strokeWidth="9"
            />
            <circle cx="24" cy="24" r="9" fill="#C74AE3" />
        </svg>
    );
}

/* Solana (explorer.solana.com): the three-bar mark, brand gradient fill. */
export function SolanaMark({ size = 18 }: BrandMarkProps) {
    return (
        <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" focusable="false">
            <defs>
                <linearGradient id="solana-mark-gradient" x1="0" y1="0" x2="1" y2="1">
                    <stop offset="0%" stopColor="#00FFA3" />
                    <stop offset="100%" stopColor="#DC1FFF" />
                </linearGradient>
            </defs>
            <path
                fill="url(#solana-mark-gradient)"
                d="m23.8764 18.0313-3.962 4.1393a.9201.9201 0 0 1-.306.2106.9407.9407 0 0 1-.367.0742H.4599a.4689.4689 0 0 1-.2522-.0733.4513.4513 0 0 1-.1696-.1962.4375.4375 0 0 1-.0314-.2545.4438.4438 0 0 1 .117-.2298l3.9649-4.1393a.92.92 0 0 1 .3052-.2102.9407.9407 0 0 1 .3658-.0746H23.54a.4692.4692 0 0 1 .2523.0734.4531.4531 0 0 1 .1697.196.438.438 0 0 1 .0313.2547.4442.4442 0 0 1-.1169.2297zm-3.962-8.3355a.9202.9202 0 0 0-.306-.2106.941.941 0 0 0-.367-.0742H.4599a.4687.4687 0 0 0-.2522.0734.4513.4513 0 0 0-.1696.1961.4376.4376 0 0 0-.0314.2546.444.444 0 0 0 .117.2297l3.9649 4.1394a.9204.9204 0 0 0 .3052.2102c.1154.049.24.0744.3658.0746H23.54a.469.469 0 0 0 .2523-.0734.453.453 0 0 0 .1697-.1961.4382.4382 0 0 0 .0313-.2546.4444.4444 0 0 0-.1169-.2297zM.46 6.7225h18.7815a.9411.9411 0 0 0 .367-.0742.9202.9202 0 0 0 .306-.2106l3.962-4.1394a.4442.4442 0 0 0 .117-.2297.4378.4378 0 0 0-.0314-.2546.453.453 0 0 0-.1697-.196.469.469 0 0 0-.2523-.0734H4.7596a.941.941 0 0 0-.3658.0745.9203.9203 0 0 0-.3052.2102L.1246 5.9687a.4438.4438 0 0 0-.1169.2295.4375.4375 0 0 0 .0312.2544.4512.4512 0 0 0 .1692.196.4689.4689 0 0 0 .2518.0739z"
            />
        </svg>
    );
}
