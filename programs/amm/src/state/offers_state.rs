use anchor_lang::prelude::*;

pub fn lot_sizer(tier: u8) -> u32 {
    match tier {
        0 => 0,
        1 => 10,
        2 => 25,
        3 => 50,
        4 => 100,
        5 => 250,
        6 => 500,
        7 => 750,
        8 => 1000,
        9 => 2500,
        10 => 5000,
        11 => 7500,
        12 => 10000,
        13 => 15000,
        14 => 20000,
        15 => 50000,
        16 => 100000,
        17 => 250000,
        18 => 500000,
        19 => 1000000,
        20 => 2500000,
        21 => 5000000,
        // devnet-big: tier 22 (10M tokens) is the ladder TOP — a full 1B-token
        // vault (the supply cap) places its 1% ceiling tier exactly here, so
        // the vault-scale window never pins below the top at any reachable
        // vault size. Tiers above this were dead headroom: t_hat ≥ 23 needs
        // a vault ≥ 2.5B tokens, past the 1B supply cap.
        22 => 10_000_000,
        _ => 0,
    }
}

// NOTE: the account structs below are zero-copy (`#[account(zero_copy)]`).
// bytemuck::Pod requires a padding-free layout, so fields are ordered align 8
// (u64) -> align 2 (u16) -> align 1 (u8 / Pubkey) and tail-padded to a multiple
// of 8. The zero-copy AccountDeserialize is a memcpy (not borsh); instruction
// contexts keep the borsh-style `Account<T>` wrapper, so the `seeds` /
// `address` / `has_one` / `bump` constraints work unchanged. We only supply
// the missing `AccountSerialize` (also a memcpy) below.

#[repr(C)]
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
pub struct Offer {
    pub lot_size: u8, // tier index into lot_sizer()
    pub vesting_days: u8, // trading days until unlock
    pub discount_bps: u8, // discount from the live DEX price, tenths of a percent (115 = 11.5%)
    pub _pad: u8, // explicit pad: keeps the u32 fields 4-aligned with no
    //              implicit padding (bytemuck rejects implicit padding)
    pub remaining: u32, // units still offered today
    pub total_offered: u32, // units offered at sheet construction
}

#[account(zero_copy)]
pub struct OfferList {
    pub owner: Pubkey,
    pub seed: u64,
    // Last trading day a sheet was constructed — make_offers' idempotency
    // guard (metrics accounts are read-only to make_offers).
    pub day_index: u64,
    pub total_complete: u32, // total whole AFHO tokens sold
    pub bump: u8,
    // pad: big_offer must start 4-aligned (Offer holds u32s; bytemuck rejects
    // implicit padding, so this is explicit).
    pub _align: [u8; 3],
    pub big_offer: Offer,
    pub med_offer: Offer,
    pub sml_offer: Offer,
    // tail pad: struct stays a multiple of 8 for the zero-copy memcpy layout
    // (disc(8) + 96-byte struct = 104-byte account).
    pub _pad: [u8; 4],
}

#[account(zero_copy)]
pub struct AmmState {
    // --- align 8 (u64) block ---
    pub total_usdc_proceeds: u64,
    // AMM never offers bulk deals with price per share lower than this
    // (ratchet floor, moves up via fills, decays down via calc_completed_offers).
    pub highest_buyback_basis: u64,
    // Buyback day schedule. Budget snapshots the vault balances at the first
    // buyback call of a trading day; unspent budget just stays in the vaults
    // and rolls into the next day with fills (no bookkeeping needed).
    pub bb_day_index: u64,
    pub bb_budget_usdc: u64,
    pub bb_spent_usdc: u64,
    pub bb_last_slot: u64,
    // Idempotency guard for distribute_staker_rewards.
    pub rewards_day_index: u64,
    // Buy-the-dip day schedule (mirrors bb_*): dip-reserve snapshot at the
    // first dip call of a trading day; the day's slices are capped at
    // DAY_CAP of the snapshot and paced by dip_last_slot.
    pub dip_day_index: u64,
    pub dip_day_usdc: u64,
    pub dip_spent_usdc: u64,
    pub dip_last_slot: u64,
    // --- align 2 (u16) block ---
    pub bb_slice_count: u16,
    // Ratchet decay: consecutive LOCKED trading days (live < floor). After
    // FLOOR_LOCK_GRACE_DAYS straight, highest_buyback_basis decays toward
    // the live price, fill-modulated + depth-accelerated (see
    // calc_completed_offers). Fills do NOT reset it — only price recovery
    // (live >= floor) does.
    pub untaken_days: u16,
    pub dip_slice_count: u16,
    // --- align 1 (u8) block ---
    pub bump: u8,
    pub _pad: [u8; 1],
    // --- align 1 (Pubkey) block ---
    pub authority: Pubkey,
    // Hot wallet allowed to fire the daily crank-gated instructions
    // (make_offers, calc_completed_offers, dex_buyback, buy_the_dip,
    // distribute_staker_rewards). Pool pinning is authority-only.
    pub keeper: Pubkey,
    pub afho_mint: Pubkey,
    pub usdc_mint: Pubkey,
    // Main AFHO vault: launch supply lands here; buyback swaps draw from it.
    pub afho_vault: Pubkey,
    pub usdc_vault: Pubkey,
    pub usdc_dip: Pubkey,
    pub offer_list: Pubkey,
    pub accepted_offers: Pubkey,
    pub market_status_pda: Pubkey,
    pub crank_program: Pubkey,
    // Raydium CPMM pool pinning (swap adapter). Pubkey::default() until
    // set_cpmm_pool pins the real pool.
    pub cpmm_pool_state: Pubkey,
    pub cpmm_amm_config: Pubkey,
    pub cpmm_program: Pubkey,
    // Second pool (Raydium SOL/USDC CPMM) used to convert SOL bond payments
    // to USDC at claim time (All-USDC route).
    pub cpmm_sol_usdc_pool: Pubkey,
    pub cpmm_sol_usdc_config: Pubkey,
    // Staking pool the offer desk CPIs into (purchased AFHO vest here).
    pub staking_pool: Pubkey,
    // Holding vault for the stakers' 10% share of USDC proceeds.
    pub usdc_rewards: Pubkey,
}

// Fill-% rings, written by calc_completed_offers on the day-start transition
// (1→0 or 2→0).
#[account(zero_copy)]
pub struct AcceptedOffers {
    pub day_index: u64, // last trading day recorded; prevents double-record
    pub big_offers_accepted: [u8; 5], // stored as whole number % (0-100), last 5 offer instances
    // should be 0 for days when no offers were available (bear cycle)
    pub med_offers_accepted: [u8; 5],
    pub sml_offers_accepted: [u8; 5],
    pub _pad: [u8; 1],
}

#[account(zero_copy)]
pub struct MarketMetrics {
    pub day_index: u64,
    pub total_staked: u64,
    pub total_supply: u64,
    // Circulating stake-health denominator: total_supply minus the AFHO still
    // held in the AMM's own vault (the bond-desk inventory the public can't
    // stake). Refreshed with total_staked/total_supply at end of trading day.
    pub available_supply: u64,
    pub spot_last_slot: u64,
    // Most recent end-of-day absolute close (floor units). Used to compute the
    // daily change into price_changes (close→close). 0 = no baseline yet.
    pub daily_close: u64,
    // High-frequency spot-price ring (floor units: usdc_raw x 1e6 / afho_raw),
    // self-sampled by buy_the_dip (throttled to one sample per SPOT_SAMPLE_SLOTS).
    pub spot_prices: [u64; 32],
    // Daily close→close change, centi-percent (1.29% -> 129), written once per
    // trading day by update_tradeday_stats. Ring buffer, 20 trading days.
    pub price_changes: [i16; 20],
    pub sample_head: u8, // next write index into price_changes
    pub spot_head: u8,   // next write index into spot_prices
    // Trailing stake-health ring, whole-number % (0-100).
    pub trailing_stake_health: [u8; 5],
    pub _pad: [u8; 1],
    // ── Freeze feature (appended 2026-10; offsets are a cross-program
    // contract — the staking program reads momentum_score at ACCOUNT offset
    // 360, append-only like BountyConfig) ──
    // Momentum score snapshotted once per trading day (single computation
    // site for make_offers, the freeze curve, and the frontend).
    pub momentum_score: u64,
    // Whole-number % of staked AFHO carrying a freeze, daily ring (graph).
    pub frozen_share: [u8; 30],
    pub frozen_head: u8,
    pub _pad2: [u8; 1],
}

// `#[account(zero_copy)]` provides AccountDeserialize (memcpy) but not
// AccountSerialize; `Account<T>` still requires the latter so the deserialized
// struct can be written back on exit. This memcpy is the serialization mirror.
macro_rules! impl_zero_copy_account_serialize {
    ($t:ty) => {
        impl anchor_lang::AccountSerialize for $t {
            fn try_serialize<W: std::io::Write>(&self, writer: &mut W) -> anchor_lang::Result<()> {
                if writer
                    .write_all(<$t as anchor_lang::Discriminator>::DISCRIMINATOR)
                    .is_err()
                {
                    return Err(anchor_lang::error::ErrorCode::AccountDidNotSerialize.into());
                }
                if writer.write_all(bytemuck::bytes_of(self)).is_err() {
                    return Err(anchor_lang::error::ErrorCode::AccountDidNotSerialize.into());
                }
                Ok(())
            }
        }
    };
}

impl_zero_copy_account_serialize!(OfferList);
impl_zero_copy_account_serialize!(AmmState);
impl_zero_copy_account_serialize!(AcceptedOffers);
impl_zero_copy_account_serialize!(MarketMetrics);
