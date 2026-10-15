// Metric helpers for make_offers — the three inputs to the offer combinator.
// Pure functions over MarketMetrics / AcceptedOffers; no account logic here.

use crate::state::offers_state::{AcceptedOffers, MarketMetrics};
use anchor_lang::prelude::*;

// Record today's close→close price change (centi-percent) into the 20-day ring.
// The input is the absolute close price (floor units) from the spot oracle; the
// change vs `daily_close` is written once per trading day. First close seeds the
// baseline; a 0 read (cold oracle) skips.
pub(crate) fn record_price_change(metrics: &mut MarketMetrics, close: u64) {
    if close == 0 {
        return;
    }
    if metrics.daily_close == 0 {
        metrics.daily_close = close;
        return;
    }
    let prev = metrics.daily_close;
    let change_cp = ((close as i128 - prev as i128) * 10_000 / prev as i128) as i64;
    let v = change_cp.clamp(i16::MIN as i64, i16::MAX as i64) as i16;
    let head = (metrics.sample_head as usize) % metrics.price_changes.len();
    metrics.price_changes[head] = v;
    metrics.sample_head = ((head + 1) % metrics.price_changes.len()) as u8;
    metrics.daily_close = close;
    msg!("recorded daily price change: {} centi-percent", v);
}

// Current staking participation as a whole %: staked / available supply.
// Available = total_supply minus the AFHO still in the AMM's own vault (the
// bond-desk inventory the public can't stake). Falls back to total_supply
// until update_tradeday_stats records the first live circulating figure.
fn current_stake_ratio(metrics: &MarketMetrics) -> u8 {
    let supply = if metrics.available_supply > 0 {
        metrics.available_supply
    } else {
        metrics.total_supply
    };
    if supply == 0 {
        return 0;
    }
    ((metrics.total_staked as u128 * 100) / supply as u128) as u8
}

// Stake health score, 0-100. Consumed by the combinator's VESTING step:
// a high/rising score means a sticky, committed staking base, so new buyers
// get LONGER locks (they join the committed); a low/falling score shortens
// locks so offers stay attractive while stakers exit.
//   base = current staking ratio
//   adjustment = today's ratio vs 5-day trailing average, clamped to +/-20
pub(crate) fn calculate_stake_health(metrics: &MarketMetrics) -> u8 {
    let current = current_stake_ratio(metrics) as i16;
    let trailing_avg = (metrics
        .trailing_stake_health
        .iter()
        .map(|&v| v as u16)
        .sum::<u16>()
        / 5) as i16;
    let adjustment = (current - trailing_avg).clamp(-20, 20);
    (current + adjustment).clamp(0, 100) as u8
}

// Record today's ratio into the 5-day trailing buffer (index 0 = oldest).
pub(crate) fn record_stake_ratio(metrics: &mut MarketMetrics) {
    let current = current_stake_ratio(metrics);
    metrics.trailing_stake_health.copy_within(1.., 0);
    metrics.trailing_stake_health[4] = current;
}

// Offer acceptance aggression, 0-10000 (2 decimal bps precision).
// Weighted mean of the last 5 days' fill % per tier; recent days and bigger
// tiers weigh more. Consumed by the combinator as the EXCITEMENT gauge:
// high aggression -> bigger/more lots and LOWER discounts (demand is proven,
// so the desk gives away less).
// Ring values are written by calc_completed_offers at the start of the next
// trading day; 0 for days with no sheet (bear), which drags the score down.
pub(crate) fn offer_accepted_aggression(accepted: &AcceptedOffers) -> u16 {
    const RECENCY_WEIGHTS: [u16; 5] = [5, 6, 7, 8, 9];

    // Tier weights: big lots signal more conviction
    const TIER_WEIGHTS: [u16; 3] = [1, 2, 4]; // sml, med, big

    let tiers = [
        &accepted.sml_offers_accepted,
        &accepted.med_offers_accepted,
        &accepted.big_offers_accepted,
    ];

    let mut total_weighted: u16 = 0;
    let mut total_possible: u16 = 0;

    for (tier_idx, tier_samples) in tiers.iter().enumerate() {
        for (day_idx, &pct) in tier_samples.iter().enumerate() {
            let weight = RECENCY_WEIGHTS[day_idx] * TIER_WEIGHTS[tier_idx];
            total_weighted += (pct as u16) * weight;
            total_possible += 100 * weight;
        }
    }

    // Returns 0-10000 (basis points, 2 decimal precision)
    // 0 = dead, 10000 = every offer cleared instantly for 5 days
    // u32 math: total_weighted can reach 24500 — * 10000 would overflow u16
    (total_weighted as u32 * 10000 / total_possible as u32) as u16
}

// Momentum score, 0-10000 (5000 = flat). Primary weight in offer construction.
// Derived only from the 20-day price_changes ring (daily close→close change,
// centi-percent). No volume input — price is the signal, per design.
//   blended = recency-weighted mean + (recent-5-day avg - older avg) / 2
//   score   = 5000 + blended * 10  →  sustained ±5% daily move pins the scale
// Each sample is capped at ±SAMPLE_CAP_CP, so one wash pump/dump boosts or
// sinks the score for a few days but can't pin it — only SUSTAINED extreme
// moves reach 0 / 10000.
// Cold start: fewer than MIN_SAMPLES nonzero ring entries → 0 (no offers).
// Note: a genuine 0.00% day reads as "no sample" — acceptable at this precision.
pub(crate) fn calculate_momentum_score(metrics: &MarketMetrics) -> u64 {
    const MIN_SAMPLES: usize = 5;
    const NEUTRAL: i64 = 5_000;
    const CP_FULL_SCALE: i64 = 500; // 5.00% in centi-percent
    const SAMPLE_CAP_CP: i64 = 1_000; // ±10%/day effective per sample

    let n = metrics.price_changes.len();
    let head = metrics.sample_head as usize % n;

    let mut count = 0usize;
    let mut w_sum: i64 = 0;
    let mut w_total: i64 = 0;
    let mut recent_sum: i64 = 0;
    let mut recent_n: i64 = 0;
    let mut older_sum: i64 = 0;
    let mut older_n: i64 = 0;

    // age 0 = oldest entry (sample_head = next write = oldest slot)
    for age in 0..n {
        let raw = metrics.price_changes[(head + age) % n];
        if raw == 0 {
            continue;
        }
        let v = (raw as i64).clamp(-SAMPLE_CAP_CP, SAMPLE_CAP_CP);
        count += 1;
        let w = (age + 1) as i64; // newer days weigh more
        w_sum += v * w;
        w_total += w;
        if age >= n - 5 {
            recent_sum += v;
            recent_n += 1;
        } else {
            older_sum += v;
            older_n += 1;
        }
    }

    if count < MIN_SAMPLES {
        return 0;
    }

    let weighted_avg = w_sum / w_total;
    // Guard both windows: all samples in the recent window (cold ring) or all
    // in the older window (recent days read as 0.00% = "no sample") → no trend.
    let trend = if recent_n > 0 && older_n > 0 {
        recent_sum / recent_n - older_sum / older_n
    } else {
        0
    };

    let blended = weighted_avg + trend / 2;
    (NEUTRAL + blended * NEUTRAL / CP_FULL_SCALE).clamp(0, 10_000) as u64
}