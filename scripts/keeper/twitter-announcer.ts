// AFHO announcement bot — posts protocol events to X (Twitter) and/or Telegram.
//
// Read-only watcher: polls the AMM / crank-oracle / staking accounts and posts
// an announcement for each notable protocol event:
//
//   1. Daily bond offer sheet goes up for sale (bond sizes / discounts / vesting days)
//   2. Daily buyback completes (AFHO purchased, average price, USDC spent)
//   3. Buy-the-dip digest — ONE post per ET calendar day at a random
//       minute inside the 10–11am or 1–3pm ET band (re-rolled daily, so
//       the slot changes), only when at least one dip slice fired since
//       the previous digest (slices, AFHO bought, avg price, USDC
//       deployed, dip vault left)
//   4. Market-state changes (with the associated unstake fee). Bell posts —
//      day-start open AND day-end close — are TELEGRAM-SILENT (no push buzz;
//      the bond events are the real notifications). X POLICY (2026-10-01):
//      only the MORNING OPEN posts to X; closing bells, halts, buybacks,
//      dip digests and floor decays are Telegram-only. X = bond sheets +
//      morning open, nothing else.
//   4b. Closed-session flash sale: AFTER-HOURS → CLOSED with bonds still on
//       the sheet — every remaining tier is 0.5% deeper for the closed window
//   5. Monday market open (open + fee + % supply staked + bond vault remaining)
//   6. Ratchet-floor decay digest — the bond offer floor decayed (old → new
//       floor + % change). NOT posted when the cut lands: decays fire at the
//       day-start transition, and the digest holds for a RANDOM minute inside
//       the 12:00–13:00 ET window (re-rolled daily), once per ET calendar
//       day. Ratchets (floor moving up on buyback fills) shift the baseline
//       silently.
//   7. Alt-sheet window — the second, fixed-terms sheet the keeper posts in
//       the suspended market state. Announced ONCE per trading day, 5 minutes
//       AFTER the window opens (and only if it is still open at post time —
//       an early close posts nothing, by design). Copy is deliberately
//       oblique: no state names, no sale jargon.
//
// All post copy lives in the POST_COPY block at the top of this file.
// Copy supports SEO-style "text spinning": {a|b|c} groups pick one
// option at random (nesting works) and each event has several full-template
// variants, so repeated announcements read differently. Each channel spins
// the template INDEPENDENTLY, so the same event posts with different wording
// on X vs Telegram (subscribers on both platforms never see an identical
// duplicate), and Telegram posts carry a link footer.
//
// X (Twitter) credentials — X developer portal → "Keys and tokens":
//   X_CONSUMER_KEY         API key / consumer key
//   X_CONSUMER_SECRET      API secret / consumer secret (legacy: SECRET_KEY)
//   X_ACCESS_TOKEN         Access token (user context)
//   X_ACCESS_TOKEN_SECRET  Access token secret
//
//   NOTE: posting as your own account requires the OAuth 1.0a *user context*
//   token pair (X_ACCESS_TOKEN + X_ACCESS_TOKEN_SECRET) in addition to the app
//   consumer key/secret. Generate them from the same portal page.
//
// Telegram credentials — Bot API (no SDK, no login flow):
//   TELEGRAM_BOT_TOKEN     token from @BotFather (/newbot → copy the token)
//   TELEGRAM_CHANNEL_ID    channel to post into: @username or -100… numeric id
//
//   The bot must be an ADMIN of that channel with "Post messages" enabled.
//   Setup takes ~2 minutes: @BotFather → /newbot → name it → copy the token,
//   create the channel, add the bot as an admin, set the two env vars.
//
// Flags:
//   X_ENABLED / TG_ENABLED  channel switches (X on by default, TG off by default)
//   DRY_RUN      "true" logs the post text instead of hitting X / Telegram
//   POLL_INTERVAL_MS  poll cadence (default 60000)
//
// Run: npx ts-node scripts/keeper/twitter-announcer.ts
//
// This is a read-only observer. It does NOT hold a signer and does NOT move
// any funds — it only watches account state and posts announcements.

import * as anchor from "@coral-xyz/anchor";
import { Connection, PublicKey } from "@solana/web3.js";
import * as crypto from "crypto";
import * as https from "https";
import * as dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";

dotenv.config();


// (every posted string lives in POST_COPY below)

// Alt-sheet announcement delay: the window is announced 5 minutes AFTER it
// opens (and only if it is still open at post time).
const ALT_ANNOUNCE_DELAY_MS = 5 * 60 * 1000;

// Night-desk announcement gate: only post once the BEST remaining tier's
// exact claim discount reaches this bar (hundredths of a percent; 200 = 2%).
// Matches the combinator's MIN_LIST_STORED listing floor — a shallower
// effective discount is the ratchet floor eating the listed deal, not a real
// bond sale.
const DESK_ANNOUNCE_MIN_DISCOUNT_BP100 = 200;

// ══════════════════════════════════════════════════════════════════════════
// POST COPY — every string the announcer can post, in ONE place.
//
//   • Each event posts ONE variant, picked at random from its array.
//   • `{a|b|c}` groups are SPIN: one option picked at random when the post
//     renders, independently per channel (X and Telegram never read the
//     same wording). Nesting works.
//   • `%token%` tokens fill with live values (sizes, prices, counts, state
//     names) before spinning — a token inside a spin group still fills.
//   • Only %tokens% known to the builder are replaced, so literal '%'
//     signs in copy (discounts, "50% off") never collide.
//   • X posts are trimmed to 280 chars from the bottom (tier lines drop
//     first); Telegram posts append `tgFooter` below.
// ══════════════════════════════════════════════════════════════════════════
const POST_COPY = {
    // Appended to every Telegram post (X stays link-free by design).
    tgFooter: "\n\n🔗 https://afho.io",

    // Market-state names by on-chain state byte
    // (0=open, 1=extended hours, 2=closed, 3=halted).
    stateNames: {
        0: "{Open. |is now Open! |just opened. |now Opened. }",
        1: "{now in after hours trading. |in extended hours. |entered after hours. }",
        2: "{Closed. |just closed. |has closed. |now closed. }",
        3: "{HALTED! }",
    } as Record<number, string>,

    // Unstake-fee phrasing, embedded as %fee% in marketState / mondayOpen.
    // state 0 (open) uses feeNone; the other states use feePenalty with
    // %pct% = the state's configured penalty (staking pool bps / 100).
    feeNone: ["no unlock fees", "zero unlock fees", "unlock fee-free"],
    feePenalty: [
        "%pct%% {penalty|fee} to {principle|principal} for unlock",
        "%pct%% {exit penalty|withdrawal penalty} {applies|hits} on unlock",
        "{unlock costs|unlock takes} %pct%% of principle",
    ],

    // ── 4. Market state changed (state 0/1/2/3 bells + halt) ──────────────
    marketState: [
        "Market %name% %fee%",
        "{Status|State} update: market %name% %fee%",
        "Market {is now|switched to} %name% %fee%",
    ],

    // ── 5. Monday market open (richer variant of the market-open message) ─
    mondayOpen: [
        "Monday open %fee% %stakePct%% of supply staked %bondVault% AFHO in bond vault",
        "The week {starts|opens} %fee% %stakePct%% of supply staked %bondVault% AFHO {in the|sitting in the} bond vault",
        "Monday {bell|open}: %fee% %stakePct%% staked %bondVault% AFHO in the bond vault",
    ],

    // ── 1. Night-desk bond offer sheet ────────────────────────────────────
    bonds: [
        "{discounted|Vesting|AFHO|Bulk token} bond{s| offers} {are now available|have posted|now trading}",
        "The {OTC|after hours desk} {just|has|} {posted|dropped|published} {tonight's|the daily} {bond|offer} {sheet|deals}",
        "{Fresh|New} AFHO bonds just {hit the desk|went on sale}",
        "{Bond desk|Offer desk|OTC office} {is open|opened|now open|trading now}..  AFHO {bonds|vesting bulk bonds} {now available|on sale now}",
    ],
    // Tier lines appended under the headline (Big/Med/Sml, in that order,
    // only tiers with size > 0). %disc% is the tier discount in tenths.
    bondsTier: [
        "%name%: %size% AFHO @ %disc%% {discount|off} %vest%d {vest|vesting}",
    ],

    // ── 4b. Closed-session flash sale (extended → closed, bonds left) ─────
    closedSale: [
        "Market CLOSED — {bonus discount|night owl special}: every {bond|offer} drops another {0.5%|50 pts|50bps|half percent}",
        "{extended hours|after hours} {finished|ended|done}. Market {now CLOSED|just closed} — the {closed-session|50pts|late-night} discount just kicked in: −0.5% more on every bond left",
        "CLOSED-session prices are live — {all|any|the} remaining bonds {drop|discount|move down|priced better by} {an extra|another|an additional|a bonus} {0.5%|50 points|50bps|half percent}.",
    ],
    // %disc% here is base + the 0.5 closed-session boost, already computed.
    closedSaleTier: [
        "%name%: %left% of %total% × %size% AFHO @ %disc%% {discount|off} %vest%d {vest|vesting}",
    ],

    // ── 7. Alt-sheet window (halted state; deliberately oblique copy) ─────
    altSheet: [
        "Something {rare|unusual} just {hit|landed on} the bond desk 👀 — a {limited|one-off} sheet is live, {3–5%|3 to 5 percent} {under market|off live price}, {short|quick} {unlock|vesting}. When it's gone, it's gone.",
        "{Rare drop|Special window}: the desk just listed a {one-time|limited} bond sheet at {3–5%|3 to 5 percent} {under market|off the live price} — {no schedule|no warning}, {no reruns today|gone when the window closes}.",
        "The desk just opened a {side window|second shelf}: bonds at {3–5%|3 to 5 percent} {under market|off live}, {3–7|3 to 7} day {unlock|vesting}. {First come|Fastest hands} win.",
    ],
    altSheetTier: [
        "%name%: %left% of %total% × %size% AFHO @ %disc%% {under market|off live price} %vest%d {unlock|vest}",
    ],

    // ── 2. Daily buyback drained the buyback vault ────────────────────────
    buybackComplete: [
        "{Daily buyback|Buyback vault drain|Bond buyback spend} {complete|finished|ended}: %afho% AFHO token at %price% avg for %usdc% USDC",
        "Buyback {done|finished|concluded|terminated}: %afho% AFHO at %price% {average|avg}.. %usdc% USDC {spent|used}",
        "{Today's|The day's} buyback {closed|ended} after spending %usdc% USDC on %afho% AFHO @ %price% average ",
    ],

    // ── 3. Buy-the-dip daily digest (three branches by shape) ─────────────
    // noAfho: slices fired but no measurable AFHO bought (claims/buyback
    // shared every poll window) — spend and vault only.
    dipDigestNoAfho: [
        "Dip {digest|recap}: %slices% dip %buyWord% %usdc% USDC deployed %dipLeft% {still in|left in} the dip vault",
        "Buy-the-dip {update|report}: %slices% slice%plural% fired for %usdc% USDC %dipLeft% USDC left in the vault",
    ],
    dipDigestSingle: [
        "Dip {buy|scoop} today: %afho% AFHO @ %price% %usdc% USDC deployed %dipLeft% {still in|left in} the dip vault",
        "One dip {executed|fired} since the last update: %afho% AFHO @ %price% %dipLeft% USDC {remains|left} in the dip vault",
        "{Bought|Picked up} %afho% AFHO @ %price% on the dip %usdc% USDC in %dipLeft% USDC left in the vault",
    ],
    dipDigestMulti: [
        "Dip {digest|recap|report}: %slices% dip buys — %afho% AFHO @ %price% avg %usdc% USDC deployed %dipLeft% {still in|left in} the dip vault",
        "Buy-the-dip {update|report}: %slices% slices fired %afho% AFHO {scooped|picked up} @ %price% avg %usdc% USDC spent %dipLeft% USDC left",
        "%slices% dip buys since the last update — %afho% AFHO @ %price% avg, %usdc% USDC in dip vault at %dipLeft%",
    ],

    // ── 6. Ratchet-floor decay digest (floor only ever moves DOWN) ────────
    floorDecay: [
        "Bond floor {update|adjustment}: ratcheted bond offer floor %old% → %new% (%pct%) — {the desk re-prices toward market|bond pricing eases toward the tape|the floor steps down to meet demand}",
        "{Floor digest|Floor check}: ratcheted bond offer floor now %new%, down from %old% (%pct%) — {unsold|unfilled} bond pricing {eases|moves closer to the live market}",
        "The ratcheted bond offer floor {stepped down|eased|slid} %old% → %new% (%pct%) — {no takers at the old floor|the desk meets the market where it is|pricing re-anchors to live trade}",
    ],
};

// Lot-sizer tiers → whole AFHO tokens per lot (programs/amm state lot_sizer).
const LOT_SIZER: number[] = [
    0, 10, 25, 50, 100, 250, 500, 750, 1000, 2500, 5000, 7500, 10000, 15000,
    20000, 50000, 100000, 250000, 500000, 1000000, 2500000, 5000000,
    10000000,
];

// ── number formatting (copy-facing) ──────────────────────────────────────────

export function formatWhole(n: number): string {
    return Math.round(n).toLocaleString("en-US");
}

export function formatUsdc(n: number): string {
    return n.toLocaleString("en-US", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
    });
}

export function formatAfho(n: number): string {
    if (n >= 1000) return formatWhole(n);
    if (n >= 1) return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
    return n.toLocaleString("en-US", { maximumFractionDigits: 4 });
}

export function formatPrice(p: number): string {
    const decimals = p < 0.01 ? 6 : p < 1 ? 4 : 2;
    return `$${p.toFixed(decimals)}`;
}

export function unstakeFeeLabel(pool: any, state: number): string {
    if (state === 0) return pick(POST_COPY.feeNone); // state 0 = open
    const bpsByState: Record<number, number> = {
        1: pool.afterHoursPenaltyBps as number,
        2: pool.closedPenaltyBps as number,
        3: pool.haltedPenaltyBps as number,
    };
    const bps = bpsByState[state] ?? 0;
    const pct = bps / 100;
    const label = Number.isInteger(pct) ? String(pct) : pct.toFixed(1);
    return render(POST_COPY.feePenalty, { pct: label });
}

// ── text spinning ────────────────────────────────────────────────────────────
// every `{a|b|c}` group picks one option at random
// (nesting works), and each event also has several full-template variants,
// so repeated announcements read differently. 
export function spin(template: string): string {
    const out: string[] = [];
    let i = 0;
    while (i < template.length) {
        if (template[i] !== "{") {
            out.push(template[i]);
            i++;
            continue;
        }
        const close = matchingBrace(template, i);
        if (close === -1) {
            // Unbalanced '{' — pass through literally.
            out.push(template[i]);
            i++;
            continue;
        }
        const options = splitTopLevel(template.slice(i + 1, close));
        const chosen = options[Math.floor(Math.random() * options.length)] ?? "";
        out.push(spin(chosen));
        i = close + 1;
    }
    return out.join("");
}

// Index of the '}' closing the group opened at openIdx, or -1 if unbalanced.
function matchingBrace(s: string, openIdx: number): number {
    let depth = 0;
    for (let j = openIdx; j < s.length; j++) {
        if (s[j] === "{") depth++;
        else if (s[j] === "}") {
            depth--;
            if (depth === 0) return j;
        }
    }
    return -1;
}

// Split a group body on '|' at nesting depth 0.
function splitTopLevel(group: string): string[] {
    const parts: string[] = [];
    let depth = 0;
    let cur = "";
    for (const ch of group) {
        if (ch === "{") {
            depth++;
            cur += ch;
        } else if (ch === "}") {
            depth--;
            cur += ch;
        } else if (ch === "|" && depth === 0) {
            parts.push(cur);
            cur = "";
        } else {
            cur += ch;
        }
    }
    parts.push(cur);
    return parts;
}

// Random element of a template-variant list.
export function pick<T>(options: T[]): T {
    return options[Math.floor(Math.random() * options.length)];
}

// Pick one POST_COPY variant and fill its %tokens% with live values.
// Spin groups pass through intact — they resolve per channel at announce()
// time, so a %token% inside a spin group still fills first here. Only the
// listed keys are substituted (string split/join, no regex), so literal '%'
// elsewhere in the copy never collides.
export function render(
    variants: string[],
    values: Record<string, string | number>
): string {
    let out = pick(variants);
    for (const [k, v] of Object.entries(values)) {
        out = out.split(`%${k}%`).join(String(v));
    }
    return out;
}

// ── event messages ───────────────────────────────────────────────────────────
// Builders pick a POST_COPY variant and interpolate the live values; all
// wording lives in POST_COPY above. announce() spins the result per channel.

type TierLine = { size: number; discountPct: number; vestingDays: number };

// One bond-sheet tier line — renders a POST_COPY tier template (bonds /
// closed sale / alt sheet) with that tier's terms. %disc% arrives
// pre-boosted (+0.5) for the closed sale via the caller.
function tierLine(
    templates: string[],
    name: string,
    t: TierLine & { left?: number; total?: number }
): string {
    return render(templates, {
        name,
        size: formatWhole(t.size),
        disc: t.discountPct.toFixed(1),
        vest: t.vestingDays,
        left: t.left ?? 0,
        total: t.total ?? 0,
    });
}

// 1. Bond offer sheet posted for the night desk.
export function bondsMessage(sheet: {
    big: TierLine;
    med: TierLine;
    sml: TierLine;
}): string {
    const lines: string[] = [pick(POST_COPY.bonds)];
    if (sheet.big.size > 0) lines.push(tierLine(POST_COPY.bondsTier, "Big", sheet.big));
    if (sheet.med.size > 0) lines.push(tierLine(POST_COPY.bondsTier, "Med", sheet.med));
    if (sheet.sml.size > 0) lines.push(tierLine(POST_COPY.bondsTier, "Sml", sheet.sml));
    return lines.join("\n");
}

// 2. Daily buyback drained the buyback vault.
export function buybackCompleteMessage(
    afho: number,
    avgPrice: number,
    usdc: number
): string {
    return render(POST_COPY.buybackComplete, {
        afho: formatAfho(afho),
        price: formatPrice(avgPrice),
        usdc: formatUsdc(usdc),
    });
}

// Daily dip-digest window: the digest lands at a random minute inside one
// of these ET bands (50/50 band pick, re-rolled every ET calendar day so
// the slot changes). Minutes are ET minutes-of-day (10:00 = 600).
export const DIP_SLOT_BANDS: Array<[number, number]> = [
    [10 * 60, 11 * 60], // mid-morning 10:00–10:59 ET
    [13 * 60, 15 * 60], // mid-afternoon 13:00–14:59 ET
];

// Random digest slot: uniform minute inside a random band.
export function rollDipSlotMinute(): number {
    const [lo, hi] =
        DIP_SLOT_BANDS[Math.floor(Math.random() * DIP_SLOT_BANDS.length)];
    return lo + Math.floor(Math.random() * (hi - lo));
}

// Re-roll inside the band that contains `nowMin` — used when a dip fires
// after today's slot already passed: uniform minute in [nowMin, hi).
export function rollDipSlotMinuteFrom(nowMin: number, hi: number): number {
    return nowMin + Math.floor(Math.random() * (hi - nowMin));
}

// 3. Daily buy-the-dip digest. Per-slice posts are gone: slices accumulate
// in the poll loop and ONE digest posts per ET calendar day, at a random
// minute inside the 10–11am or 1–3pm ET band, only when at least one slice
// fired since the last digest. Three branches: nothing measurable bought,
// a single slice, multiple slices.
export function dipDigestMessage(
    slices: number,
    afho: number,
    usdc: number,
    price: number,
    dipUsdcRemaining: number
): string {
    const values = {
        slices: formatWhole(slices),
        buyWord: slices === 1 ? "buy" : "buys",
        plural: slices === 1 ? "" : "s",
        afho: formatAfho(afho),
        price: formatPrice(price),
        usdc: formatUsdc(usdc),
        dipLeft: formatUsdc(dipUsdcRemaining),
    };
    if (afho <= 0) return render(POST_COPY.dipDigestNoAfho, values);
    if (slices === 1) return render(POST_COPY.dipDigestSingle, values);
    return render(POST_COPY.dipDigestMulti, values);
}

// 4. Market state changed.
export function marketStateMessage(state: number, feeLabel: string): string {
    return render(POST_COPY.marketState, {
        name: POST_COPY.stateNames[state] ?? state,
        fee: feeLabel,
    });
}

// 4b. Closed-session flash sale: the market went EXTENDED → CLOSED and the
// sheet still has bonds left. Every remaining tier prices +0.5% deeper for
// the closed window (programs/amm offer_claim::quote_claim). Copy shows the
// BOOSTED discount (base + 0.5) and what remains per tier.
export function closedSaleMessage(tiers: {
    big: TierLine & { left: number; total: number };
    med: TierLine & { left: number; total: number };
    sml: TierLine & { left: number; total: number };
}): string {
    // %disc% is rendered pre-boosted (base + 0.5) in the tier lines.
    const boost = (t: TierLine & { left: number; total: number }) => ({
        ...t,
        discountPct: t.discountPct + 0.5,
    });
    const lines: string[] = [pick(POST_COPY.closedSale)];
    if (tiers.big.left > 0) lines.push(tierLine(POST_COPY.closedSaleTier, "Big", boost(tiers.big)));
    if (tiers.med.left > 0) lines.push(tierLine(POST_COPY.closedSaleTier, "Med", boost(tiers.med)));
    if (tiers.sml.left > 0) lines.push(tierLine(POST_COPY.closedSaleTier, "Sml", boost(tiers.sml)));
    return lines.join("\n");
}

// 5. Monday market open (richer variant of the market-open message).
export function mondayOpenMessage(
    feeLabel: string,
    stakePct: number,
    bondVaultWhole: number
): string {
    return render(POST_COPY.mondayOpen, {
        fee: feeLabel,
        stakePct: stakePct.toFixed(1),
        bondVault: formatWhole(bondVaultWhole),
    });
}

// 6. Ratchet-floor decay digest. Floor units are nano-USD (price per whole
// token × 1e9), the same convention the /dash "Ratchet floor (USDC)" row
// shows, so 4792 → "$0.000004792". The floor only ever moves DOWN via
// calc_completed_offers decay (fills ratchet it up), so the message is the
// desk easing its no-discount boundary toward the live market after days
// with no bond sales. Posted at the noon ET slot, not when the cut lands.
export function floorDecayMessage(oldFloorUsd: number, newFloorUsd: number): string {
    const fmt = (v: number) => `$${v.toFixed(9)}`;
    const pct = oldFloorUsd > 0 ? ((newFloorUsd - oldFloorUsd) / oldFloorUsd) * 100 : 0;
    const pctLabel = `${pct > 0 ? "+" : "-"}${Math.abs(pct).toFixed(1)}%`;
    return render(POST_COPY.floorDecay, {
        old: fmt(oldFloorUsd),
        new: fmt(newFloorUsd),
        pct: pctLabel,
    });
}

// ════════════════════════════════════════════════════════════════════════════
// 7. Alt-sheet window (suspended state only). Announced once per trading
// day, 5 minutes after the window opens, and only while the window is
// still open at post time. Copy is deliberately oblique — no state names,
// no sale jargon; the tier lines carry the concrete terms.
export function altSheetMessage(tiers: {
    big: TierLine & { left: number; total: number };
    med: TierLine & { left: number; total: number };
    sml: TierLine & { left: number; total: number };
}): string {
    const lines: string[] = [pick(POST_COPY.altSheet)];
    if (tiers.big.total > 0) lines.push(tierLine(POST_COPY.altSheetTier, "Big", tiers.big));
    if (tiers.med.total > 0) lines.push(tierLine(POST_COPY.altSheetTier, "Med", tiers.med));
    if (tiers.sml.total > 0) lines.push(tierLine(POST_COPY.altSheetTier, "Sml", tiers.sml));
    return lines.join("\n");
}

// Decay digest window: the digest lands at a random minute inside
// 12:00–13:00 ET ("around noon", re-rolled daily so the exact time moves).
const DECAY_SLOT_BAND: [number, number] = [12 * 60, 13 * 60];

export function rollDecaySlotMinute(): number {
    const [lo, hi] = DECAY_SLOT_BAND;
    return lo + Math.floor(Math.random() * (hi - lo));
}

// CONFIG & CREDENTIALS
// ════════════════════════════════════════════════════════════════════════════

// Channel switches: X defaults on; Telegram defaults off until TG_ENABLED=true.
const X_ENABLED = !["false", "0", "no"].includes(
    (process.env.X_ENABLED ?? "").toLowerCase()
);
const TG_ENABLED = ["true", "1", "yes"].includes(
    (process.env.TG_ENABLED ?? "").toLowerCase()
);

const X_CONSUMER_KEY = process.env.X_CONSUMER_KEY ?? "";
const X_CONSUMER_SECRET =
    process.env.X_CONSUMER_SECRET ?? process.env.SECRET_KEY ?? "";
const X_ACCESS_TOKEN = process.env.X_ACCESS_TOKEN ?? "";
const X_ACCESS_TOKEN_SECRET = process.env.X_ACCESS_TOKEN_SECRET ?? "";
const X_API_BASE = process.env.X_API_BASE ?? "https://api.twitter.com";

// Telegram Bot API config.
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? "";
const TELEGRAM_CHANNEL_ID = process.env.TELEGRAM_CHANNEL_ID ?? "";

const DRY_RUN = ["true", "1", "yes"].includes(
    (process.env.DRY_RUN ?? "").toLowerCase()
);
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS ?? 60_000);
const RPC_URL =
    process.env.RPC_URL ??
    process.env.ANCHOR_PROVIDER_URL ??
    "https://api.mainnet-beta.solana.com";

export function isMondayEt(now: Date = new Date()): boolean {
    const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: "America/New_York",
        weekday: "short",
    }).format(now);
    return parts === "Mon";
}

// (retired: the decay digest now uses a randomized daily slot — see
// rollDecaySlotMinute / etMinutesOfDay)

// ET minutes-of-day (10:30 ET = 630). Host-TZ-independent like the helpers
// above — the dip digest compares this against its daily random slot.
export function etMinutesOfDay(now: Date = new Date()): number {
    const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: "America/New_York",
        hour: "numeric",
        minute: "2-digit",
        hourCycle: "h23",
    }).format(now); // "9:05" / "13:45"
    const [h, m] = parts.split(":").map(Number);
    return h * 60 + m;
}

// ════════════════════════════════════════════════════════════════════════════
// X API (OAuth 1.0a user context) — self-contained, no extra dependency.
// ════════════════════════════════════════════════════════════════════════════

export function percentEncode(s: string): string {
    return encodeURIComponent(s).replace(
        /[!'()*]/g,
        (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
    );
}

export function oauthAuthorizationHeader(
    method: string,
    url: string,
    extraOAuthParams: Record<string, string> = {}
): string {
    const oauth: Record<string, string> = {
        oauth_consumer_key: X_CONSUMER_KEY,
        oauth_nonce: crypto.randomBytes(16).toString("hex"),
        oauth_signature_method: "HMAC-SHA1",
        oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
        oauth_token: X_ACCESS_TOKEN,
        oauth_version: "1.0",
        ...extraOAuthParams,
    };

    const paramString = Object.keys(oauth)
        .sort()
        .map((k) => `${percentEncode(k)}=${percentEncode(oauth[k])}`)
        .join("&");

    const baseString = `${method}&${percentEncode(url)}&${percentEncode(
        paramString
    )}`;
    const signingKey = `${percentEncode(X_CONSUMER_SECRET)}&${percentEncode(
        X_ACCESS_TOKEN_SECRET
    )}`;
    const signature = crypto
        .createHmac("sha1", signingKey)
        .update(baseString)
        .digest("base64");

    const headerParams = { ...oauth, oauth_signature: signature };
    return (
        "OAuth " +
        Object.keys(headerParams)
            .sort()
            .map((k) => `${percentEncode(k)}="${percentEncode(headerParams[k])}"`)
            .join(", ")
    );
}

function postTweet(text: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const url = new URL(`${X_API_BASE}/2/tweets`);
        const body = JSON.stringify({ text });
        const authorization = oauthAuthorizationHeader("POST", url.toString());

        const req = https.request(
            {
                method: "POST",
                host: url.hostname,
                port: 443,
                path: url.pathname,
                headers: {
                    Authorization: authorization,
                    "Content-Type": "application/json",
                    "Content-Length": Buffer.byteLength(body),
                    "User-Agent": "afho-twitter-announcer",
                },
            },
            (res) => {
                let data = "";
                res.on("data", (chunk) => (data += chunk));
                res.on("end", () => {
                    if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
                        resolve();
                    } else {
                        reject(new Error(`X API ${res.statusCode}: ${data}`));
                    }
                });
            }
        );

        req.on("error", reject);
        req.write(body);
        req.end();
    });
}

// Telegram-only footer: a link line on every TG post (no algorithm penalty
// there, and channel posts without a link convert worse). X posts stay
// link-free — links in the body depress reach; the site link lives in the
// account bio and pinned post. (The string lives in POST_COPY.tgFooter.)

// X hard-rejects >280 chars — a rejected post is a LOST event (the latch
// still advances). Trim from the bottom (tier lines go first, the headline
// stays) so the post always lands.
function fitTweet(body: string): string {
    if (body.length <= 280) return body;
    const lines = body.split("\n");
    while (lines.length > 1 && lines.join("\n").length > 280) {
        lines.pop();
    }
    const joined = lines.join("\n");
    return joined.length <= 280 ? joined : joined.slice(0, 277) + "...";
}

// Post to every enabled channel. The template spins INDEPENDENTLY per
// channel — same facts, different wording — so cross-platform subscribers
// never see an identical duplicate. `silent` opts the post out of Telegram
// push notifications (X has no equivalent): routine state changes post
// silently so the notable events actually ping phones. `pin` (TG only) pins
// the sent message as the channel's ONE pinned post — used exclusively by
// the live bond-sheet announcements; every other event never pins.
// `x: false` skips X entirely (2026-10-01, kev): X carries ONLY the bond
// sheets (incl. the halted-state alt sheet and the closed flash sale) and
// the morning-open bell — everything else (closing bells, halts, buybacks,
// dip digests, floor decays) is Telegram-only so the X timeline stays a
// clean discovery surface.
async function announce(text: string, opts?: { silent?: boolean; pin?: boolean; x?: boolean }): Promise<void> {
    const silent = opts?.silent ?? false;
    const raw = text;

    // Channels are independent: a failure on one (rate limit, revoked
    // token, API outage) logs and moves on — it must never block the
    // others, and never marks the whole poll as failed. Failed posts retry
    // (RETRY_MAX attempts, RETRY_DELAY_MS apart) — a transient 429 used to
    // lose the event forever because the latch had already advanced.
    if (X_ENABLED && (opts?.x ?? true)) {
        const body = fitTweet(spin(raw));
        if (DRY_RUN) {
            console.log(`[dry-run][x] would tweet:\n${body}\n`);
        } else {
            const ok = await withRetry("x", () => postTweet(body));
            if (ok !== null) console.log(`[x] ${body.replace(/\n/g, " ")}`);
        }
    }

    if (TG_ENABLED) {
        const body = spin(raw) + POST_COPY.tgFooter;
        if (DRY_RUN) {
            console.log(`[dry-run][tg] would post:${opts?.pin ? " [PIN]" : ""}\n${body}\n`);
        } else {
            const msgId = await withRetry("tg", () => sendTelegram(body, silent));
            if (msgId !== null) {
                console.log(`[tg]${silent ? " (silent)" : ""}${opts?.pin ? " [PIN]" : ""} ${body.replace(/\n\n/g, " | ").replace(/\n/g, " ")}`);
                if (opts?.pin) await pinSheetMessage(msgId);
            }
        }
    }
}

// ── Sheet pinning (2026-09-17) ──────────────────────────────────────────────
// ONLY the live bond sheet is ever pinned (night-desk sheet / closed flash
// sale / alt sheet). Market-state bells, halts, buybacks, digests never pin.
// The pin is released the moment the offer period actually ends: market
// open (claims are state 2|0 only), a halt (retires the sheet), a new
// trading day (sheet goes stale), or sell-out (all tiers remaining = 0).
// pinnedKind separates the regular desk pin from the alt-sheet pin so a
// halt-lift unpins the ALT pin even while the regular sheet stays live in
// the night states. Both fields persist in the announcer state file so a
// restart keeps managing the pin instead of orphaning it.
let pinnedMessageId: number | null = null;
let pinnedKind: "desk" | "alt" | null = null;

async function pinSheetMessage(messageId: number): Promise<void> {
    if (!TG_ENABLED || DRY_RUN) return;
    try {
        await telegramApi("pinChatMessage", {
            chat_id: TELEGRAM_CHANNEL_ID,
            message_id: messageId,
            disable_notification: true, // pinning must never buzz phones
        });
        pinnedMessageId = messageId;
        console.log(`[tg] pinned sheet message ${messageId}`);
    } catch (e) {
        // The bot needs the "Pin messages" admin right on the channel —
        // grant it in channel admin settings if this fires.
        console.error(`!! [tg] pin failed (is the bot admin with 'Pin messages'?): ${(e as Error).message}`);
    }
}

async function unpinSheetMessage(reason: string): Promise<void> {
    if (!TG_ENABLED || DRY_RUN) return;
    if (pinnedMessageId === null) return;
    const id = pinnedMessageId;
    pinnedMessageId = null; // clear FIRST: a stale id must never block the next pin/unpin
    try {
        await telegramApi("unpinChatMessage", {
            chat_id: TELEGRAM_CHANNEL_ID,
            message_id: id,
        });
        console.log(`[tg] unpinned sheet (${reason})`);
    } catch (e) {
        // Already unpinned manually / id expired — nothing to do.
        console.error(`[tg] unpin no-op (${reason}): ${(e as Error).message}`);
    }
}

// Retry wrapper for channel posts (see announce): RETRY_MAX attempts spaced
// RETRY_DELAY_MS apart — long enough to clear a rate-limit window, short
// enough that a hard outage gives up loudly instead of stalling the loop.
// Returns the fn's value on success (the TG message id, null-equivalent for
// void fns) or null after the final failed attempt.
const RETRY_DELAY_MS = 20_000;
const RETRY_MAX = 5;

async function withRetry<T>(label: string, fn: () => Promise<T>): Promise<T | null> {
    for (let attempt = 1; attempt <= RETRY_MAX; attempt++) {
        try {
            return await fn();
        } catch (e) {
            const last = attempt === RETRY_MAX;
            console.error(
                `!! [${label}] post failed (attempt ${attempt}/${RETRY_MAX}): ${(e as Error).message}` +
                (last ? " — GIVING UP, event lost" : ` — retrying in ${RETRY_DELAY_MS / 1000}s`)
            );
            if (!last) await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
        }
    }
    return null;
}

// ════════════════════════════════════════════════════════════════════════════
// TELEGRAM SENDER (Bot API) — no SDK, no login flow, one HTTPS call per post.
//
// One-time setup (do this once, then it just works):
//   1. In Telegram, message @BotFather: /newbot → pick a name → copy the
//      token (looks like 123456789:AA…).
//   2. Create the announcement channel, add the bot as an ADMIN with
//      "Post messages" enabled.
//   3. Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHANNEL_ID (@username or -100…)
//      in .env, then TG_ENABLED=true.
//
// Posts go out as HTML — the copy carries no markup, so & < > are escaped
// and newlines survive. Bots may only post to channels/groups where they
// are admins; they can never message a user who hasn't opened the bot.
// ════════════════════════════════════════════════════════════════════════════

function escapeHtml(s: string): string {
    return s
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

function telegramApi(
    method: string,
    params: Record<string, unknown>
): Promise<any> {
    return new Promise((resolve, reject) => {
        const payload = JSON.stringify(params);
        const req = https.request(
            {
                method: "POST",
                host: "api.telegram.org",
                port: 443,
                path: `/bot${TELEGRAM_BOT_TOKEN}/${method}`,
                headers: {
                    "Content-Type": "application/json",
                    "Content-Length": Buffer.byteLength(payload),
                    "User-Agent": "afho-announcer",
                },
            },
            (res) => {
                let data = "";
                res.on("data", (chunk) => (data += chunk));
                res.on("end", () => {
                    if (
                        res.statusCode &&
                        res.statusCode >= 200 &&
                        res.statusCode < 300
                    ) {
                        try {
                            resolve(JSON.parse(data));
                        } catch {
                            resolve(null); // non-JSON 2xx — nothing to return
                        }
                    } else {
                        reject(
                            new Error(
                                `Telegram API ${res.statusCode}: ${data.slice(0, 300)}`
                            )
                        );
                    }
                });
            }
        );
        req.on("error", reject);
        req.write(payload);
        req.end();
    });
}

// Validate the token once at startup — getMe fails fast with a readable
// error ("Unauthorized" = bad token) before the poll loop starts.
async function initTelegram(): Promise<void> {
    if (!TG_ENABLED || DRY_RUN) return; // dry run never touches Telegram
    if (TELEGRAM_BOT_TOKEN === "" || TELEGRAM_CHANNEL_ID === "") {
        throw new Error(
            "TG_ENABLED=true but TELEGRAM_BOT_TOKEN / TELEGRAM_CHANNEL_ID " +
            "are missing. Create a bot with @BotFather and add it as an " +
            "admin of your channel, then set both in .env."
        );
    }
    try {
        await telegramApi("getMe", {});
    } catch (e) {
        throw new Error(
            `Telegram startup check failed: ${(e as Error).message}`
        );
    }
}

async function sendTelegram(text: string, silent = false): Promise<number | null> {
    const res = await telegramApi("sendMessage", {
        chat_id: TELEGRAM_CHANNEL_ID,
        text: escapeHtml(text),
        parse_mode: "HTML",
        disable_web_page_preview: true,
        disable_notification: silent,
    });
    // message id feeds the sheet pinning (announce → pinSheetMessage).
    return res?.result?.message_id ?? null;
}

// ════════════════════════════════════════════════════════════════════════════
// CHAIN READS
// ════════════════════════════════════════════════════════════════════════════

function loadDeployment(): any {
    const p = path.join(process.cwd(), "app", "public", "deployment.json");
    if (!fs.existsSync(p)) throw new Error(`deployment.json not found at ${p}`);
    return JSON.parse(fs.readFileSync(p, "utf-8"));
}

function loadIdl(name: string): anchor.Idl {
    const p = path.join(process.cwd(), "target", "idl", `${name}.json`);
    if (!fs.existsSync(p)) {
        throw new Error(`IDL not found at ${p}. Run 'anchor build' first.`);
    }
    return JSON.parse(fs.readFileSync(p, "utf-8"));
}

function programFor(
    name: string,
    programId: PublicKey,
    provider: anchor.Provider
): anchor.Program {
    const idl = loadIdl(name);
    // Pin the program id from deployment.json — deployed programs can be
    // rotated to new ids without an IDL regen. anchor 0.31 reads `idl.address`
    (idl as any).address = programId.toBase58();
    return new anchor.Program(idl, provider);
}
function num(x: any): number {
    return anchor.BN.isBN(x) ? Number(x.toString()) : Number(x);
}

function lotSize(tier: number): number {
    return LOT_SIZER[tier] ?? 0;
}

function tierSize(offer: any): number {
    return lotSize(offer.lotSize) * num(offer.totalOffered);
}

function offerListEmpty(offerList: any): boolean {
    return (
        tierSize(offerList.bigOffer) === 0 &&
        tierSize(offerList.medOffer) === 0 &&
        tierSize(offerList.smlOffer) === 0
    );
}

function buildSheet(offerList: any): {
    big: TierLine;
    med: TierLine;
    sml: TierLine;
} {
    const toTier = (offer: any): TierLine => ({
        size: tierSize(offer),
        discountPct: num(offer.discountBps) / 10, // stored tenths of a percent
        vestingDays: num(offer.vestingDays),
    });
    return {
        big: toTier(offerList.bigOffer),
        med: toTier(offerList.medOffer),
        sml: toTier(offerList.smlOffer),
    };
}

function toWhole(raw: number, decimals: number): number {
    return raw / Math.pow(10, decimals);
}

async function tokenBalanceRaw(
    connection: Connection,
    account: PublicKey
): Promise<number> {
    const info = await connection.getTokenAccountBalance(account);
    return Number(info.value.amount);
}

// Best real discount currently available on the night desk, in hundredths of
// a percent (100 = 1.00%) — 0 when nothing is effectively discounted. Mirrors
// quote_claim's TIER-SCALED pricing exactly (offer_claim.rs): the ratchet
// floor lifts clamped tiers in strict big>med>sml order, so this gate never
// over-reports a deal the on-chain claim would refuse with FloorHeldAtSpot.
// `connection` is unused here but kept to match the call-site shape.
async function bestDeskDiscountBp100(
    connection: Connection,
    ammState: any,
    offerList: any,
    state: number,
    liveFloor: bigint
): Promise<number> {
    if (liveFloor <= 0n) return 0;
    const floor = BigInt(ammState.highestBuybackBasis.toString());
    const satSub = (a: bigint, b: bigint): bigint => (a > b ? a - b : 0n);

    const discount = (key: string): number => {
        const o = (offerList as any)[key];
        return o ? num(o.discountBps) : 0;
    };
    // Stored discounts are tenths of a percent (115 = 11.5%); the state-2
    // closed-session boost adds 5 tenths to every tier.
    const tierQuote = (d: number): bigint => {
        const boosted = state === 2 ? Math.min(255, d + 5) : d;
        return liveFloor - (liveFloor * BigInt(boosted) * 10n) / 10_000n;
    };
    const tierBound = (d: number): bigint => {
        const boosted = state === 2 ? Math.min(255, d + 5) : d;
        const allowance = (liveFloor * BigInt(boosted - d) * 10n) / 10_000n;
        return floor > allowance ? floor - allowance : 0n;
    };

    const dSml = discount("smlOffer");
    const dMed = discount("medOffer");
    const dBig = discount("bigOffer");
    const qSml = tierQuote(dSml);
    const qMed = tierQuote(dMed);
    const qBig = tierQuote(dBig);
    const bSml = tierBound(dSml);
    const bMed = tierBound(dMed);
    const bBig = tierBound(dBig);

    // Exact quote_claim tier-scaling (unrolled eff_sml/eff_med/eff_big block).
    const effSml = qSml >= bSml ? qSml : bSml + satSub(qSml, qBig);
    const liftedMed = bMed + satSub(qMed, qBig);
    const cappedMed = liftedMed < satSub(effSml, 1n) ? liftedMed : satSub(effSml, 1n);
    const effMed = qMed >= bMed ? qMed : (cappedMed > bMed ? cappedMed : bMed);
    const effBig = qBig > bBig ? qBig : bBig;

    let best = 0;
    const tiers = [
        ["smlOffer", effSml],
        ["medOffer", effMed],
        ["bigOffer", effBig],
    ] as const;
    for (const [key, eff] of tiers) {
        const o = (offerList as any)[key];
        if (!o || num(o.remaining) <= 0 || num(o.lotSize) <= 0) continue;
        if (eff >= liveFloor) continue; // at/above spot — no real discount
        const bp100 = Number(((liveFloor - eff) * 10_000n) / liveFloor);
        if (bp100 > best) best = bp100;
    }
    return best;
}

// ════════════════════════════════════════════════════════════════════════════
// MAIN
// ════════════════════════════════════════════════════════════════════════════

async function main(): Promise<void> {
    if (!X_ENABLED && !TG_ENABLED) {
        throw new Error(
            "No channel enabled: set X_ENABLED=true or TG_ENABLED=true in .env."
        );
    }

    if (!DRY_RUN) {
        const missing = X_ENABLED
            ? [
                ["X_CONSUMER_KEY", X_CONSUMER_KEY],
                ["X_CONSUMER_SECRET", X_CONSUMER_SECRET],
                ["X_ACCESS_TOKEN", X_ACCESS_TOKEN],
                ["X_ACCESS_TOKEN_SECRET", X_ACCESS_TOKEN_SECRET],
            ]
                .filter(([, v]) => v === "")
                .map(([k]) => k)
            : [];
        if (missing.length > 0) {
            throw new Error(
                `Missing X credentials: ${missing.join(", ")}. Set them in .env, ` +
                `set X_ENABLED=false for Telegram-only, or run with DRY_RUN=true to preview messages.`
            );
        }
    }

    await initTelegram();

    const connection = new Connection(RPC_URL, "confirmed");
    const provider = new anchor.AnchorProvider(
        connection,
        new anchor.Wallet(anchor.web3.Keypair.generate()), // read-only: never signs
        { commitment: "confirmed" }
    );

    const deployment = loadDeployment();
    const afhoMint = new PublicKey(deployment.mint);
    const ammProgramId = new PublicKey(deployment.ammProgram);
    const crankProgramId = new PublicKey(deployment.crankProgram);
    const stakingProgramId = new PublicKey(deployment.stakingProgram);

    const ammProgram = programFor("amm", ammProgramId, provider);
    const crankProgram = programFor("crank_oracle", crankProgramId, provider);
    const stakingProgram = programFor("staking", stakingProgramId, provider);

    const [ammStatePda] = PublicKey.findProgramAddressSync(
        [Buffer.from("amm_state"), afhoMint.toBuffer()],
        ammProgramId
    );
    const [marketStatusPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("market_status")],
        crankProgramId
    );
    // Alt desk sheet (same OfferList layout, separate PDA) — read lazily at
    // post time; the fetch throws while the account doesn't exist yet.
    const [altListPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("alt_offer_list"), afhoMint.toBuffer()],
        ammProgramId
    );

    // Token decimals are immutable; resolve once.
    const ammState0 = await (ammProgram.account as any).ammState.fetch(
        ammStatePda
    );
    const afhoMintInfo = await connection.getTokenSupply(afhoMint);
    const afhoDecimals = afhoMintInfo.value.decimals;
    const usdcMintInfo = await connection.getTokenSupply(
        new PublicKey(ammState0.usdcMint)
    );
    const usdcDecimals = usdcMintInfo.value.decimals;

    console.log("AFHO announcer started");
    console.log("  cluster:", RPC_URL);
    console.log("  ammState:", ammStatePda.toBase58());
    console.log("  marketStatus:", marketStatusPda.toBase58());
    console.log(
        "  channels:",
        [X_ENABLED ? "X" : null, TG_ENABLED ? "Telegram" : null]
            .filter(Boolean)
            .join(" + ")
    );
    if (TG_ENABLED && !DRY_RUN) console.log("  telegram target:", TELEGRAM_CHANNEL_ID);
    console.log("  dry run:", DRY_RUN);
    console.log("  poll interval (ms):", POLL_INTERVAL_MS);

    // ── cross-poll event memory ────────────────────────────────────────────
    // PERSISTED (2026-09-17): every latch/accumulator below round-trips
    // through .announcer-state.json each poll. A restart used to lose the
    // dip accumulators (a morning of dip slices → no digest that day) and
    // re-baseline the buyback snapshot (corrupting that day's "bought X"
    // figure); with the state file a restart resumes exactly where it left
    // off, and the first-poll re-seed block only runs on a truly cold start.
    const STATE_FILE = path.join(process.cwd(), ".announcer-state.json");
    let initialized = false;
    let prevState = -1;
    let prevOfferDayIndex = -1;
    let prevAfhoVaultRaw = 0;
    let prevDipSpentUsdc = 0;
    let prevDipSliceCount = 0;
    // Snapshot of the AFHO bond vault at the start of today's buyback window.
    let buybackSnapshot: { day: number; afhoRaw: number } | null = null;
    let lastReportedBuybackDay = -1;
    // Desk latch: ONE announcement per SHEET, keyed on the offer list's
    // trading day (offerDay) — not the ET calendar date. The closed session
    // (20:00 → next 9:30) spans midnight ET, so a date-keyed latch reset at
    // 00:00 and re-announced the still-live sheet (bit 2026-10-05: flash
    // sale posted 20:11 ET, duplicate 00:00:26 ET). Per-sheet keying also
    // covers price-flap reopenings (same sheet → silent) and makes a
    // genuinely new sheet (new trading day) the only re-announce event.
    let deskAnnouncedDay: number | null = null;
    // Pre-offerDay state files carry the old date-keyed latch; kept for the
    // one-shot migration at the first poll (see below).
    let legacyDeskAnnouncedDate: string | null = null;
    let deskLatchMigrated = false;
    // Ratchet-floor decay digest (section 6): the floor only ever moves DOWN
    // via decay — buyback/dip fills ratchet it UP — so current floor < last
    // announced floor = a decay happened. Held for the noon ET slot (decays
    // land at the day-start transition, ~9:30 ET on mainnet; the digest
    // batches them to lunch), once per ET calendar day. Ratchets upward move
    // the baseline silently. Seeded from live state on restart so a mid-day
    // restart never re-announces an old decay; the NEXT decay re-arms it.
    let floorAnnouncedRaw: number | null = null;
    let decayAnnouncedDate: string | null = null;
    // Buy-the-dip digest (loop section 4): slices accumulate into a pending
    // window; ONE digest per ET calendar day at a random minute inside the
    // 10–11am / 1–3pm ET bands (re-rolled daily so the slot changes), only
    // when ≥1 slice fired since the previous digest. A dip landing after
    // today's slot but still inside a band re-rolls a fresh slot later
    // today (the once-per-day cap stands). In-memory like the decay
    // baseline: a mid-day restart forgets the pending window and re-rolls
    // today's slot.
    let dipPendingSlices = 0;
    let dipPendingAfhoWhole = 0;
    let dipPendingUsdcWhole = 0;
    let dipAnnouncedDate: string | null = null;
    let dipSlotDate = "";
    let dipSlotMinute = -1;
    // Decay digest slot: randomized daily inside 12:00–13:00 ET (replaces
    // the old "first poll at-or-after noon" — same batching, moving time).
    let decaySlotDate = "";
    let decaySlotMinute = -1;
    // Alt-sheet window: one announcement per trading day, scheduled 5
    // minutes after the window opens (see section 7 in the poll loop).
    let haltAnnouncedDay = -1;
    const etDate = (): string =>
        new Intl.DateTimeFormat("en-CA", {
            timeZone: "America/New_York",
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
        }).format(new Date());

    // ── state-file round-trip (see the PERSISTED note above) ─────────────
    function saveState(): void {
        try {
            fs.writeFileSync(
                STATE_FILE,
                JSON.stringify(
                    {
                        v: 1,
                        savedAt: new Date().toISOString(),
                        prevState,
                        prevAfhoVaultRaw,
                        prevDipSpentUsdc,
                        prevDipSliceCount,
                        buybackSnapshot,
                        lastReportedBuybackDay,
                        deskAnnouncedDay,
                        floorAnnouncedRaw,
                        decayAnnouncedDate,
                        dipPendingSlices,
                        dipPendingAfhoWhole,
                        dipPendingUsdcWhole,
                        dipAnnouncedDate,
                        dipSlotDate,
                        dipSlotMinute,
                        decaySlotDate,
                        decaySlotMinute,
                        haltAnnouncedDay,
                        pinnedMessageId,
                        pinnedKind,
                    },
                    null,
                    2
                )
            );
        } catch (e) {
            console.error(`!! state save failed (continuing in-memory): ${(e as Error).message}`);
        }
    }
    let stateResumed = false;
    try {
        const saved = JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
        prevState = saved.prevState ?? -1;
        prevAfhoVaultRaw = saved.prevAfhoVaultRaw ?? 0;
        prevDipSpentUsdc = saved.prevDipSpentUsdc ?? 0;
        prevDipSliceCount = saved.prevDipSliceCount ?? 0;
        buybackSnapshot = saved.buybackSnapshot ?? null;
        lastReportedBuybackDay = saved.lastReportedBuybackDay ?? -1;
        deskAnnouncedDay = saved.deskAnnouncedDay ?? null;
        legacyDeskAnnouncedDate = saved.deskAnnouncedDate ?? null;
        floorAnnouncedRaw = saved.floorAnnouncedRaw ?? null;
        decayAnnouncedDate = saved.decayAnnouncedDate ?? null;
        dipPendingSlices = saved.dipPendingSlices ?? 0;
        dipPendingAfhoWhole = saved.dipPendingAfhoWhole ?? 0;
        dipPendingUsdcWhole = saved.dipPendingUsdcWhole ?? 0;
        dipAnnouncedDate = saved.dipAnnouncedDate ?? null;
        dipSlotDate = saved.dipSlotDate ?? "";
        dipSlotMinute = saved.dipSlotMinute ?? -1;
        decaySlotDate = saved.decaySlotDate ?? "";
        decaySlotMinute = saved.decaySlotMinute ?? -1;
        haltAnnouncedDay = saved.haltAnnouncedDay ?? -1;
        pinnedMessageId = typeof saved.pinnedMessageId === "number" ? saved.pinnedMessageId : null;
        pinnedKind = saved.pinnedKind === "desk" || saved.pinnedKind === "alt" ? saved.pinnedKind : null;
        stateResumed = true;
        console.log(`  state resumed from ${STATE_FILE} (saved ${saved.savedAt ?? "?"})`);
    } catch {
        console.log("  cold start — no state file, first poll seeds latches");
    }
    // A resumed process keeps its latches: the first-poll re-seed block must
    // not run (it would zero the dip accumulators and re-baseline the floor).
    if (stateResumed) initialized = true;

    while (true) {
        try {
            const ammState = await (ammProgram.account as any).ammState.fetch(
                ammStatePda
            );
            const marketStatus = await (
                crankProgram.account as any
            ).marketStatus.fetch(marketStatusPda);
            const offerList = await (ammProgram.account as any).offerList.fetch(
                ammState.offerList
            );
            const stakingPool = await (stakingProgram.account as any).stakePool.fetch(
                ammState.stakingPool
            );

            const state = marketStatus.currentState as number;
            const marketDay = num(marketStatus.tradingDayIndex);

            const afhoVaultRaw = await tokenBalanceRaw(
                connection,
                new PublicKey(ammState.afhoVault)
            );
            const usdcVaultRaw = await tokenBalanceRaw(
                connection,
                new PublicKey(ammState.usdcVault)
            );
            const usdcDipRaw = await tokenBalanceRaw(
                connection,
                new PublicKey(ammState.usdcDip)
            );

            // Live AFHO price (floor units, vault-ratio spot over the pinned
            // CPMM pool) — feeds the desk-open discount gate below.
            let liveFloor = 0n;
            try {
                const cpmmPool = new PublicKey(ammState.cpmmPoolState);
                const vaultOf = (m: PublicKey) => PublicKey.findProgramAddressSync(
                    [Buffer.from("pool_vault"), cpmmPool.toBuffer(), m.toBuffer()],
                    new PublicKey(ammState.cpmmProgram)
                )[0];
                const [afhoPoolRaw, usdcPoolRaw] = await Promise.all([
                    tokenBalanceRaw(connection, vaultOf(afhoMint)),
                    tokenBalanceRaw(connection, vaultOf(new PublicKey(ammState.usdcMint))),
                ]);
                if (afhoPoolRaw > 0) liveFloor = BigInt(Math.floor(usdcPoolRaw * 1e12 / afhoPoolRaw));
            } catch {
                liveFloor = 0n; // unreadable pool → discount gate stays shut
            }
            const deskDiscount = await bestDeskDiscountBp100(
                connection, ammState, offerList, state, liveFloor
            );

            const bbDay = num(ammState.bbDayIndex);
            const bbSpentUsdc = num(ammState.bbSpentUsdc);
            const dipSpentUsdc = num(ammState.dipSpentUsdc);
            const dipSliceCount = ammState.dipSliceCount as number;
            const offerDay = num(offerList.dayIndex);
            const floorRaw = num(ammState.highestBuybackBasis);

            // Buyback baseline: prefer the freshest pre-open afho_vault read when we
            // first see a day-start open (1→0 or 2→0); a 3→0 halt lift is not a
            // new day. Fall back to a mid-buyback startup snapshot.
            const dayStartedOpen =
                initialized && (prevState === 1 || prevState === 2) && state === 0;
            if (dayStartedOpen) {
                buybackSnapshot = { day: marketDay, afhoRaw: prevAfhoVaultRaw };
            }
            if (
                (!buybackSnapshot || buybackSnapshot.day !== marketDay) &&
                bbDay === marketDay &&
                usdcVaultRaw > 0
            ) {
                buybackSnapshot = { day: marketDay, afhoRaw: afhoVaultRaw };
            }

            // One-shot latch migration: a state file from the date-keyed
            // era (deskAnnouncedDate set, deskAnnouncedDay absent) that was
            // announced TODAY (ET) treats the currently-live sheet as
            // already announced — deploying this fix must not post another
            // duplicate of tonight's sheet.
            if (!deskLatchMigrated) {
                deskLatchMigrated = true;
                if (
                    deskAnnouncedDay === null &&
                    legacyDeskAnnouncedDate === etDate()
                ) {
                    deskAnnouncedDay = offerDay;
                    console.log(
                        `  desk latch migrated: legacy ${legacyDeskAnnouncedDate} → sheet day ${offerDay} (no re-announce)`
                    );
                }
            }

            // True when the night desk will announce the sheet THIS poll:
            // night state, fresh sheet, lots left, this SHEET not yet
            // announced (per-trading-day latch), and the best tier-scaled
            // discount reaches the listing bar. Computed once per poll and
            // shared by the closing-bell dedupe and the desk announce
            // itself so the two can never disagree. A dark desk (gate
            // shut / sold out / stale sheet / unreadable pool →
            // deskDiscount 0) leaves this false.
            const sheetWillPost =
                (state === 1 || state === 2) &&
                offerDay === marketDay &&
                !offerListEmpty(offerList) &&
                deskAnnouncedDay !== offerDay &&
                deskDiscount >= DESK_ANNOUNCE_MIN_DISCOUNT_BP100;

            if (initialized) {
                // Bell posts (2026-09-17): BOTH bells post — the morning
                // open (1→0 / 2→0, richer on Mondays) and the closing bell
                // (0→1 / 0→2). Both are TG-SILENT: bells are daily content,
                // not phone notifications; the night desk's own discount-
                // gated announcements below are the events that ping.
                // Dedupe (2026-10-01): a closing bell that lands together
                // with a sheet post (sheetWillPost) posts ONLY the sheet —
                // the sheet copy already carries the session (flash-sale
                // copy names CLOSED; the bonds sheet IS the after-hours
                // desk), so the bare status bell would be a double post.
                if (state !== prevState) {
                    const feeLabel = unstakeFeeLabel(stakingPool, state);
                    // Morning-open announcements fire ONLY on the canonical
                    // day-start pair (1→0 or 2→0) — the normal path is
                    // 0→1→2→0 (extended hours between close and next open),
                    // so a 3→0 halt lift (or any other →0) stays silent here;
                    // the halt itself was announced when it landed.
                    if (dayStartedOpen && isMondayEt()) {
                        const totalSupplyRaw = Number(
                            (await connection.getTokenSupply(afhoMint)).value.amount
                        );
                        const stakePct =
                            totalSupplyRaw > 0
                                ? (num(stakingPool.totalStaked) / totalSupplyRaw) * 100
                                : 0;
                        await announce(
                            mondayOpenMessage(
                                feeLabel,
                                stakePct,
                                toWhole(afhoVaultRaw, afhoDecimals)
                            ),
                            { silent: true }
                        );
                    } else if (dayStartedOpen) {
                        // Morning open is a real daily event — announce it.
                        await announce(marketStateMessage(state, feeLabel), {
                            silent: true,
                        });
                    } else if (prevState === 0 && (state === 1 || state === 2)) {
                        // Closing bell (open → after-hours/closed): the
                        // end-of-trade-day post. Skipped when the desk sheet
                        // posts this same poll (sheetWillPost) — one post per
                        // close, not two. A dark desk still gets the bell so
                        // the state change never goes completely unannounced.
                        // TG-silent like the morning open — bells are
                        // content, not notifications.
                        if (!sheetWillPost) {
                            await announce(marketStateMessage(state, feeLabel), {
                                silent: true,
                                x: false, // X: sheets + morning open only
                            });
                        }
                    } else if (state === 3) {
                        // Halts are safety-relevant — announce the change.
                        await announce(marketStateMessage(state, feeLabel), {
                            silent: true,
                            x: false, // X: sheets + morning open only
                        });
                        // ── 7: alt-sheet window — 5-minute delayed post ──
                        // Scheduled the moment the window opens; the post
                        // itself re-reads the market state and only fires if
                        // the window is STILL open (an early close posts
                        // nothing — no end-of-window announcement, by
                        // design). Latched once per trading day at schedule
                        // time, so window flaps never double-post. A
                        // mid-window restart seeds silently (never
                        // re-announces), same rule as every other latch.
                        if (haltAnnouncedDay !== marketDay) {
                            haltAnnouncedDay = marketDay;
                            setTimeout(async () => {
                                try {
                                    const status = await (
                                        crankProgram.account as any
                                    ).marketStatus.fetch(marketStatusPda);
                                    if ((status.currentState as number) !== 3)
                                        return;
                                    const day = num(status.tradingDayIndex);
                                    const alt = await (
                                        ammProgram.account as any
                                    ).offerList.fetch(altListPda);
                                    if (num(alt.dayIndex) !== day) return;
                                    const empty =
                                        num(alt.bigOffer.totalOffered) === 0 &&
                                        num(alt.medOffer.totalOffered) === 0 &&
                                        num(alt.smlOffer.totalOffered) === 0;
                                    if (empty) return;
                                    const sheet = buildSheet(alt);
                                    await announce(
                                        altSheetMessage({
                                            big: { ...sheet.big, left: num(alt.bigOffer.remaining), total: num(alt.bigOffer.totalOffered) },
                                            med: { ...sheet.med, left: num(alt.medOffer.remaining), total: num(alt.medOffer.totalOffered) },
                                            sml: { ...sheet.sml, left: num(alt.smlOffer.remaining), total: num(alt.smlOffer.totalOffered) },
                                        }),
                                        { pin: true }
                                    );
                                    pinnedKind = "alt";
                                } catch (e) {
                                    // No sheet account yet / transient RPC —
                                    // the window stays unannounced rather
                                    // than late.
                                    console.error(`!! alt-sheet post failed: ${(e as Error).message}`);
                                }
                            }, ALT_ANNOUNCE_DELAY_MS);
                        }
                    }
                    // Night states post the closing bell above; the night
                    // desk's own announcements (sheet post / flash sale
                    // below) carry the deal terms when a real discount
                    // exists — a dark desk never posts a bare "bonds live"
                    // with nothing buyable.
                }

                // ── 1b: sheet-pin lifecycle ────────────────────────────────────────
                // The ONE pinned post is the live bond sheet. Release it the
                // moment the offer period actually ends: market open (claims
                // are night-states-only), a halt (retires the sheet), a new
                // trading day (sheet stale), or sell-out (all tiers cleared).
                // The alt pin is released as soon as the halt lifts (any
                // state ≠ 3 retires the alt sheet) even while the regular
                // sheet logic continues.
                if (pinnedMessageId !== null) {
                    if (pinnedKind === "alt") {
                        if (state !== 3) await unpinSheetMessage("halt lifted");
                    } else {
                        const deskLive =
                            (state === 1 || state === 2) &&
                            offerDay === marketDay &&
                            !offerListEmpty(offerList);
                        if (!deskLive) {
                            const why =
                                state === 0 ? "market open" :
                                    state === 3 ? "halted" :
                                        offerDay !== marketDay ? "new trading day" :
                                            "sold out";
                            await unpinSheetMessage(why);
                        }
                    }
                }

                // ── 2: night desk opens (discount-gated, latched) ───────────────────
                // The desk announces only when a REAL discount is actually
                // buyable: fresh sheet, lots left, market in a night state,
                // and the best tier's exact tier-scaled claim discount (post-
                // ratchet, with the state-2 bonus allowance) reaches the
                // 2% listing bar. If the ratchet holds the desk at/above
                // spot when after-hours starts, the announcement waits until
                // the decay (or a price move) makes the bonds worth the
                // click. One announcement per calendar day (ET): re-opens/
                // flaps the same day stay silent; a new calendar day
                // announces again. Message matches the session: sheet post
                // in after-hours, flash sale in closed. The gate itself is
                // the shared sheetWillPost predicate above.
                if (sheetWillPost) {
                    const sheet = buildSheet(offerList);
                    if (state === 2) {
                        await announce(
                            closedSaleMessage({
                                big: { ...sheet.big, left: num(offerList.bigOffer.remaining), total: num(offerList.bigOffer.totalOffered) },
                                med: { ...sheet.med, left: num(offerList.medOffer.remaining), total: num(offerList.medOffer.totalOffered) },
                                sml: { ...sheet.sml, left: num(offerList.smlOffer.remaining), total: num(offerList.smlOffer.totalOffered) },
                            }),
                            { pin: true }
                        );
                    } else {
                        await announce(bondsMessage(sheet), { pin: true });
                    }
                    // pinnedKind tags the pin as the regular desk sheet so
                    // the unpin lifecycle releases it on open/halt/new-day/
                    // sell-out (see the sheet-pin lifecycle block).
                    pinnedKind = "desk";
                    deskAnnouncedDay = offerDay;
                }

                // ── 3: daily buyback drained the buyback vault ──────────────────────
                if (
                    buybackSnapshot &&
                    buybackSnapshot.day === marketDay &&
                    usdcVaultRaw === 0 &&
                    bbSpentUsdc > 0 &&
                    lastReportedBuybackDay !== marketDay
                ) {
                    const afhoBought = toWhole(
                        afhoVaultRaw - buybackSnapshot.afhoRaw,
                        afhoDecimals
                    );
                    const usdcSpent = toWhole(bbSpentUsdc, usdcDecimals);
                    if (afhoBought > 0 && usdcSpent > 0) {
                        await announce(
                            buybackCompleteMessage(
                                afhoBought,
                                usdcSpent / afhoBought,
                                usdcSpent
                            ),
                            { x: false } // X: sheets + morning open only
                        );
                        lastReportedBuybackDay = marketDay;
                    }
                    buybackSnapshot = null;
                }

                // ── 4: buy-the-dip — randomized-slot daily digest ────────────────────
                // Per-slice posts are gone: slices accumulate into a pending
                // window and ONE digest fires per ET day, at a random minute
                // inside the 10–11am / 1–3pm band, ONLY when at least one
                // slice fired since the previous digest. AFHO bought is
                // measured per-slice from the afho_vault delta (a claim or
                // buyback slice in the same 60s poll window skews that
                // slice's figure) — the same convention the old per-slice
                // post used. dip_slice_count/dip_spent_usdc reset to 0 on
                // day rollover, so a shrinking counter = day reset.
                if (dipSlotDate !== etDate()) {
                    dipSlotDate = etDate();
                    dipSlotMinute = rollDipSlotMinute();
                }
                const sliceDelta =
                    dipSliceCount >= prevDipSliceCount
                        ? dipSliceCount - prevDipSliceCount
                        : dipSliceCount;
                const spentDelta =
                    dipSpentUsdc >= prevDipSpentUsdc
                        ? dipSpentUsdc - prevDipSpentUsdc
                        : dipSpentUsdc;
                if (sliceDelta > 0 || spentDelta > 0) {
                    dipPendingSlices += Math.max(
                        sliceDelta,
                        spentDelta > 0 ? 1 : 0
                    );
                    dipPendingUsdcWhole += toWhole(spentDelta, usdcDecimals);
                    const afhoDelta = afhoVaultRaw - prevAfhoVaultRaw;
                    if (afhoDelta > 0) {
                        dipPendingAfhoWhole += toWhole(
                            afhoDelta,
                            afhoDecimals
                        );
                    }
                    // Dip fired after today's slot but still inside a band →
                    // fresh random slot later today. Outside the bands the
                    // pending window simply waits for tomorrow's slot.
                    const etNow = etMinutesOfDay();
                    const band = DIP_SLOT_BANDS.find(
                        ([lo, hi]) => etNow >= lo && etNow < hi
                    );
                    if (
                        dipAnnouncedDate !== etDate() &&
                        band &&
                        dipSlotMinute <= etNow
                    ) {
                        dipSlotMinute = rollDipSlotMinuteFrom(etNow, band[1]);
                    }
                }
                if (
                    (dipPendingSlices > 0 || dipPendingUsdcWhole > 0) &&
                    dipAnnouncedDate !== etDate() &&
                    etMinutesOfDay() >= dipSlotMinute
                ) {
                    const price =
                        dipPendingAfhoWhole > 0
                            ? dipPendingUsdcWhole / dipPendingAfhoWhole
                            : 0;
                    await announce(
                        dipDigestMessage(
                            dipPendingSlices,
                            dipPendingAfhoWhole,
                            dipPendingUsdcWhole,
                            price,
                            toWhole(usdcDipRaw, usdcDecimals)
                        ),
                        { x: false } // X: sheets + morning open only
                    );
                    dipAnnouncedDate = etDate();
                    dipPendingSlices = 0;
                    dipPendingAfhoWhole = 0;
                    dipPendingUsdcWhole = 0;
                }

                // ── 5: ratchet-floor decay — randomized noon digest ─────
                // The floor never moves down except via calc_completed_offers
                // decay (fills ratchet it up), so floor < last-announced floor
                // = a decay happened. Held for a RANDOM minute inside the
                // 12:00–13:00 ET band (re-rolled daily): decays land at the
                // day-start transition (~9:30 ET on mainnet) and the digest
                // batches them to lunch at a time that moves day to day, once
                // per ET calendar day. Ratchets upward move the baseline
                // silently so the next decay measures from the true peak.
                if (decaySlotDate !== etDate()) {
                    decaySlotDate = etDate();
                    decaySlotMinute = rollDecaySlotMinute();
                }
                if (floorAnnouncedRaw === null) floorAnnouncedRaw = floorRaw;
                if (floorRaw > floorAnnouncedRaw) floorAnnouncedRaw = floorRaw;
                if (
                    floorRaw < floorAnnouncedRaw &&
                    decayAnnouncedDate !== etDate() &&
                    etMinutesOfDay() >= decaySlotMinute
                ) {
                    await announce(
                        floorDecayMessage(
                            Number(floorAnnouncedRaw) / 1e9,
                            Number(floorRaw) / 1e9
                        ),
                        { x: false } // X: sheets + morning open only
                    );
                    decayAnnouncedDate = etDate();
                    floorAnnouncedRaw = floorRaw;
                }
            }

            // ── advance cross-poll memory ──────────────────────────────────────────
            if (!initialized) {
                // COLD START ONLY (a resumed process keeps its loaded latches
                // — see the state-file block above). Decay digest seed:
                // baseline = the live floor at startup, so a cold start never
                // announces a long-past decay; the NEXT decay (floor dropping
                // below this baseline) re-arms it. Desk latch: treat the desk
                // as already-announced ONLY if it is live AND currently
                // passing the discount gate.
                floorAnnouncedRaw = floorRaw;
                if (
                    (state === 1 || state === 2) &&
                    offerDay === marketDay &&
                    !offerListEmpty(offerList) &&
                    deskDiscount >= DESK_ANNOUNCE_MIN_DISCOUNT_BP100
                ) {
                    deskAnnouncedDay = offerDay;
                }
            }
            prevState = state;
            prevOfferDayIndex = offerDay;
            prevAfhoVaultRaw = afhoVaultRaw;
            prevDipSpentUsdc = dipSpentUsdc;
            prevDipSliceCount = dipSliceCount;
            initialized = true;
            saveState();
        } catch (e) {
            console.error("!! poll failed:", (e as Error).message);
        }

        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
}

if (require.main === module) {
    main().catch((e) => {
        console.error("!! announcer fatal:", e);
        process.exit(1);
    });
}
