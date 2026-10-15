// Shared ANSI styling for keeper console output (mev-keeper.ts +
// mev-keeper-mainnet.ts). Color ONLY the bolded event label in front of the
// colon — the detail text stays default-colored, so the eye lands on the
// event type while reading a scroll. One color per event TYPE:
//   green        Cranked! / bounty recycled
//   brightGreen  bounty_top_up (refill, healthy)
//   magenta      Day ended (0→1 / 0→2 / 3→2)
//   brightMagenta Day started (1→0 / 2→0)
//   cyan         AMM sequence fired! (update_tradeday_stats / make_offers /
//                calc_completed_offers / distribute_staker_rewards /
//                records ledger)
//   blue         dex_buyback
//   yellow       buy_the_dip
//   brightBlue   bounty_top_up
//   brightYellow test-mode lines (TEST-STATE MODE / TEST crank / watch:)
//   red          errors (!! … failed / simulation failed)
//   gray         skipped / no-op / sleep / last-logs lines
export const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
  brightGreen: "\x1b[92m",
  brightYellow: "\x1b[93m",
  brightBlue: "\x1b[94m",
  brightMagenta: "\x1b[95m",
} as const;

/** Bold, colored event label with NO trailing colon (used as `${ev(...)} rest`). */
export const ev = (color: string, label: string): string =>
  `${ANSI.bold}${color}${label}${ANSI.reset}`;

/** Bold, colored event label followed by ": " (used as `${evc(...)}rest`). */
export const evc = (color: string, label: string): string =>
  `${ANSI.bold}${color}${label}:${ANSI.reset} `;

/** Dim gray label for skipped / no-op / sleeping lines. */
export const skip = (label: string): string =>
  `${ANSI.dim}${ANSI.gray}${label}:${ANSI.reset} `;

/** Dim a whole line (no event type, e.g. "No fresh quote, nothing to do."). */
export const dim = (text: string): string =>
  `${ANSI.dim}${ANSI.gray}${text}${ANSI.reset}`;
