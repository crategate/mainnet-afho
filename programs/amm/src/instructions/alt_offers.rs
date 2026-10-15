// programs/amm/src/instructions/alt_offers.rs
//
// The alt desk — a second, fixed-terms bond sheet that only exists while
// the market-status feed reports the suspended/halted state (state 3). It
// is deliberately a SEPARATE instruction family (not a quote_claim
// exception): the night desk's pricing, ratchet floor, above-spot gate,
// closed-session boost and freshness rules are untouched, and the
// battle-tested offer_claim path stays byte-identical.
//
// Sheet terms (fixed, no combinator, no metrics interaction):
//   exactly 5% of the afho_vault balance is offered, split
//     big = 1% of vault · med = 1.5% · sml = 2.5% (rounding leftovers in
//     big/med fold into extra sml lots — the bottom tier targets ~250 lots)
//   priced AT CLAIM TIME off the live pinned-pool price:
//     big −5.0% · med −4.0% · sml −3.0%
//   vesting fixed: big 7d · med 4d · sml 3d
//   NO ratchet-floor bound, NO above-spot gate (every tier prices strictly
//   below live by construction), NO fill recording (accepted_offers /
//   demand-keep / ratchet never see these fills).
//
// Lifecycle:
//   make_alt_offers       authority||keeper, ONLY in state 3, ONE sheet
//                         per trading day (alt_list.day_index cooldown)
//   alt_offer_claim       USDC payment, ONLY in state 3, only today's sheet
//   alt_offer_claim_sol   SOL payment, same gate (lamports solved from the
//                         pinned SOL/USDC pool exactly like offer_claim_sol)
//   any 3→(0|1|2) transition retires the sheet: claims hard-error outside
//   state 3 (the sheet account itself goes dormant and revives if the
//   market re-enters state 3 on the SAME trading day; a new day requires a
//   fresh make_alt_offers).
//
// Payment splits 80/10/10 (buyback/dip/rewards) exactly like the night
// desk; proceeds also accumulate into total_usdc_proceeds. Purchased AFHO
// moves straight into a vesting StakePosition via the same staking CPI.

use crate::state::offers_state::{lot_sizer, AmmState, Offer, OfferList};
use anchor_lang::prelude::*;

use crate::error::AmmError;
use anchor_spl::associated_token::{create_idempotent, AssociatedToken, Create};
use anchor_spl::token::{sync_native, SyncNative};
use anchor_spl::token_interface::{
    transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked,
};

// The pinned SOL/USDC amm_config's input-leg trade fee (0.25%) — the same
// sizing assumption offer_claim's SOL path makes (single source of truth).
use super::offer_claim::SOL_POOL_TRADE_FEE_BPS;

// Fixed alt-desk terms: stored discounts are tenths of a percent (50 =
// 5.0%), vesting in whole trading days. Strict big > med > sml discount
// ordering by construction.
const ALT_DISCOUNT: [u8; 3] = [30, 40, 50]; // sml, med, big
const ALT_VESTING: [u8; 3] = [3, 4, 7];
// Lot-count targets: the bottom tier aims for ~250 lots, the upper tiers
// ride the same ladder at ~30/~6 lots so the sheet reads as ~250 small
// bonds with a handful of large ones.
const SML_LOT_TARGET: u64 = 250;
const MED_LOT_TARGET: u64 = 30;
const BIG_LOT_TARGET: u64 = 6;

// ---------------------------------------------------------------------------
// Sheet post (keeper-driven, state 3 only)
// ---------------------------------------------------------------------------

#[derive(Accounts)]
pub struct MakeAltOffers<'info> {
    #[account(mut)]
    pub cranker: Signer<'info>,
    #[account(
        mut,
        seeds = [b"amm_state", amm_state.afho_mint.as_ref()],
        bump = amm_state.bump,
    )]
    pub amm_state: Box<Account<'info, AmmState>>,
    // Lazily created on the first post so live deployments (whose
    // initialize ran before this account existed) get it without a
    // re-init. Seeds are fixed under this program, so init_if_needed
    // cannot be steered to a foreign account; the handler additionally
    // detects the fresh (zeroed) account via owner == default to dodge
    // the day-0 cooldown collision (u64::MAX seeding is unavailable
    // pre-init).
    #[account(
        init_if_needed,
        payer = cranker,
        seeds = [b"alt_offer_list", amm_state.afho_mint.as_ref()],
        bump,
        space = 8 + std::mem::size_of::<OfferList>(),
    )]
    pub alt_list: Box<Account<'info, OfferList>>,
    /// CHECK: market status PDA (seeds-verified against the pinned crank)
    #[account(
        seeds = [b"market_status"],
        seeds::program = amm_state.crank_program,
        bump
    )]
    pub market_status: UncheckedAccount<'info>,
    #[account(address = amm_state.afho_mint)]
    pub afho_mint: Box<InterfaceAccount<'info, Mint>>,
    /// CHECK: bond vault — raw balance read only
    #[account(mut, address = amm_state.afho_vault)]
    pub afho_vault: AccountInfo<'info>,
    pub system_program: Program<'info, System>,
}

// Largest ladder tier whose lot fits `per_lot` whole tokens; 0 when even
// tier 1 (10 tokens) does not fit.
fn pick_tier(per_lot: u64) -> u8 {
    for t in (1..=22u8).rev() {
        if lot_sizer(t) as u64 <= per_lot {
            return t;
        }
    }
    0
}

pub(crate) fn handler_make(ctx: Context<MakeAltOffers>) -> Result<()> {
    let amm_state = &ctx.accounts.amm_state;
    let alt_list = &mut ctx.accounts.alt_list;
    let caller = ctx.accounts.cranker.key();
    require!(
        caller == amm_state.authority || caller == amm_state.keeper,
        AmmError::UnauthorizedCaller
    );

    // ── Market gate: the alt sheet exists only in the suspended state ──
    // MarketStatus layout: disc(8) + current_state(1) + timestamp(8) +
    // trading_day_index(8) — same raw read as make_offers/offer_claim.
    let market_data = ctx.accounts.market_status.try_borrow_data()?;
    require!(market_data.len() >= 25, AmmError::InvalidMarketStatus);
    let current_state = market_data[8];
    let current_day = u64::from_le_bytes(market_data[17..25].try_into().unwrap());
    require!(current_state == 3, AmmError::InvalidMarketState);
    drop(market_data);

    // ── Cooldown: ONE alt sheet per trading day ──
    // A fresh account reads owner == default (zeroed init); its day_index
    // of 0 would collide with trading day 0, so freshness bypasses the
    // cooldown check exactly once.
    let fresh = alt_list.owner == Pubkey::default();
    if !fresh {
        require!(alt_list.day_index != current_day, AmmError::AlreadyPosted);
    }

    // ── Sizing: exactly 5% of the bond vault, no scaling, no exceptions ──
    // Vault balance is read raw (Token-2022 ATA — same direct read as
    // make_offers; unreadable vault → 0 → empty sheet, fail dark).
    let vault_raw = super::raydium::token_account_amount(&ctx.accounts.afho_vault).unwrap_or(0);
    let unit = 10u64
        .checked_pow(ctx.accounts.afho_mint.decimals as u32)
        .unwrap_or(1);
    let vault_whole = vault_raw / unit;
    let total = vault_whole / 20; // 5% of the vault
    let big_alloc = total / 5; // 1% of the vault
    let med_alloc = total * 3 / 10; // 1.5% of the vault
                                    // sml absorbs its own 2.5% PLUS every big/med rounding leftover — the
                                    // "don't round out evenly → fill into additional bottom tiers" rule.

    let sml_alloc = total.saturating_sub(big_alloc).saturating_sub(med_alloc);
    let sml_tier = {
        let t = pick_tier(sml_alloc / SML_LOT_TARGET);
        if t == 0 {
            1
        } else {
            t
        }
    };
    // Tier ordering invariant: sml < med < big (≥1 apart), clamped to the
    // ladder top. The upper clamps only bind on unreachable vaults (≥20B
    // tokens); the lower clamps keep the ordering on dust vaults (counts
    // land at 0 and those tiers simply stay unlisted).
    let med_tier = pick_tier(med_alloc / MED_LOT_TARGET)
        .max(sml_tier.saturating_add(1))
        .min(22);
    let big_tier = pick_tier(big_alloc / BIG_LOT_TARGET)
        .max(med_tier.saturating_add(1))
        .min(22);
    let lot = |t: u8| lot_sizer(t) as u64; // big/med tiers ≥ 3 → never 0

    let big_count = big_alloc / lot(big_tier);
    let med_count = med_alloc / lot(med_tier);
    let placed = big_count
        .saturating_mul(lot(big_tier))
        .saturating_add(med_count.saturating_mul(lot(med_tier)));
    let sml_count = if placed < total {
        (total - placed) / lot(sml_tier)
    } else {
        0
    };

    alt_list.owner = amm_state.authority;
    alt_list.seed = 0;
    alt_list.day_index = current_day;
    alt_list.total_complete = 0;
    alt_list.bump = ctx.bumps.alt_list;
    alt_list.big_offer = Offer {
        lot_size: big_tier,
        vesting_days: ALT_VESTING[2],
        discount_bps: ALT_DISCOUNT[2],
        _pad: 0,
        remaining: big_count.min(u32::MAX as u64) as u32,
        total_offered: big_count.min(u32::MAX as u64) as u32,
    };
    alt_list.med_offer = Offer {
        lot_size: med_tier,
        vesting_days: ALT_VESTING[1],
        discount_bps: ALT_DISCOUNT[1],
        _pad: 0,
        remaining: med_count.min(u32::MAX as u64) as u32,
        total_offered: med_count.min(u32::MAX as u64) as u32,
    };
    alt_list.sml_offer = Offer {
        lot_size: sml_tier,
        vesting_days: ALT_VESTING[0],
        discount_bps: ALT_DISCOUNT[0],
        _pad: 0,
        remaining: sml_count.min(u32::MAX as u64) as u32,
        total_offered: sml_count.min(u32::MAX as u64) as u32,
    };

    msg!(
        "alt sheet day {}: {} tok (5% of vault); tiers {}/{}/{}; counts {}/{}/{}; disc {}/{}/{}; vest {}/{}/{}",
        current_day,
        total,
        alt_list.sml_offer.lot_size,
        alt_list.med_offer.lot_size,
        alt_list.big_offer.lot_size,
        alt_list.sml_offer.total_offered,
        alt_list.med_offer.total_offered,
        alt_list.big_offer.total_offered,
        alt_list.sml_offer.discount_bps,
        alt_list.med_offer.discount_bps,
        alt_list.big_offer.discount_bps,
        alt_list.sml_offer.vesting_days,
        alt_list.med_offer.vesting_days,
        alt_list.big_offer.vesting_days,
    );
    Ok(())
}

// ---------------------------------------------------------------------------
// Pricing (shared by both currencies)
// ---------------------------------------------------------------------------

struct AltQuote {
    total_tokens: u64,
    total_raw: u64,
    cost_usdc: u64,
    vesting_days: u8,
    effective_price: u64,
    discount_bps: u64,
}

// Fixed-terms pricing off the LIVE pool price. Deliberately no ratchet
// floor, no late-nite boost, no tier scaling and no above-spot gate: every
// tier prices strictly below live by construction (discount > 0), which is
// the entire point of the alt desk — a real below-market take while the
// regular desk is dark. Freshness (today's sheet) still applies.
fn quote_alt_claim(
    market_status: &AccountInfo,
    alt_list: &Account<OfferList>,
    afho_decimals: u8,
    live_price: u64,
    tier: u8,
    units: u32,
) -> Result<AltQuote> {
    require!(units > 0, AmmError::ZeroAmount);

    // ── Market gate: active ONLY while the suspended state holds ──
    // MarketStatus layout: disc(8) + current_state(1) + timestamp(8) +
    // trading_day_index(8). Any 3→(0|1|2) transition retires the sheet.
    let market_data = market_status.try_borrow_data()?;
    require!(market_data.len() >= 25, AmmError::InvalidMarketStatus);
    let current_state = market_data[8];
    let current_day = u64::from_le_bytes(market_data[17..25].try_into().unwrap());
    drop(market_data);
    require!(current_state == 3, AmmError::NotActive);

    // ── Freshness: only the sheet posted this trading day is claimable ──
    require!(
        alt_list.day_index == current_day,
        AmmError::StaleOfferSheet
    );

    let offer = match tier {
        0 => alt_list.sml_offer,
        1 => alt_list.med_offer,
        2 => alt_list.big_offer,
        _ => return err!(AmmError::InvalidTier),
    };
    require!(offer.remaining >= units, AmmError::InsufficientOffer);
    let lot_tier = offer.lot_size;

    // ── Price: live absolute price minus the fixed tier discount ──
    // discount_bps stored in tenths of a percent (50 = 5.0%) → ×10 = bps.
    require!(live_price > 0, AmmError::InvalidOracle);
    let discount_bps = offer.discount_bps as u64 * 10;
    let effective_price = live_price
        .checked_sub(
            live_price
                .checked_mul(discount_bps)
                .ok_or(AmmError::MathOverflow)?
                / 10_000,
        )
        .ok_or(AmmError::MathOverflow)?;
    require!(
        effective_price > 0 && effective_price < live_price,
        AmmError::InvalidOracle
    );

    // lot_size is a TIER INDEX — translate via lot_sizer to whole tokens,
    // then to raw units. Price units: (usdc_raw × 1e12) / afho_raw
    // (price per whole AFHO × 1e9) — identical scaling to offer_claim.
    let unit = 10u64.checked_pow(afho_decimals as u32).unwrap_or(1);
    let total_tokens = lot_sizer(lot_tier) as u64 * units as u64;
    require!(total_tokens > 0, AmmError::InsufficientOffer);
    let total_raw = (total_tokens as u128)
        .checked_mul(unit as u128)
        .ok_or(AmmError::MathOverflow)?;
    let cost = total_raw
        .checked_mul(effective_price as u128)
        .ok_or(AmmError::MathOverflow)?
        / 1_000_000_000_000u128;
    let cost_usdc = u64::try_from(cost).map_err(|_| AmmError::MathOverflow)?;
    require!(cost_usdc > 0, AmmError::ZeroAmount);

    Ok(AltQuote {
        total_tokens,
        total_raw: u64::try_from(total_raw).map_err(|_| AmmError::MathOverflow)?,
        cost_usdc,
        vesting_days: offer.vesting_days,
        effective_price,
        discount_bps,
    })
}

// ---------------------------------------------------------------------------
// USDC payment
// ---------------------------------------------------------------------------

#[derive(Accounts)]
#[instruction(tier: u8, units: u32, index: u64)]
pub struct AltOfferClaim<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,

    #[account(
        mut,
        seeds = [b"amm_state", amm_state.afho_mint.as_ref()],
        bump = amm_state.bump,
    )]
    pub amm_state: Box<Account<'info, AmmState>>,

    #[account(
        mut,
        seeds = [b"alt_offer_list", amm_state.afho_mint.as_ref()],
        bump = alt_list.bump,
    )]
    pub alt_list: Box<Account<'info, OfferList>>,

    #[account(address = amm_state.afho_mint)]
    pub afho_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(address = amm_state.usdc_mint)]
    pub usdc_mint: Box<InterfaceAccount<'info, Mint>>,

    /// CHECK: pool state, pinned to amm_state.cpmm_pool_state in the handler
    pub cpmm_pool_state: Option<AccountInfo<'info>>,
    /// CHECK: pool observation (TWAP ring)
    pub cpmm_observation: Option<AccountInfo<'info>>,
    /// CHECK: pool USDC vault (quote leg)
    pub cpmm_input_vault: Option<AccountInfo<'info>>,
    /// CHECK: pool AFHO vault (base leg)
    pub cpmm_output_vault: Option<AccountInfo<'info>>,

    /// CHECK: seeds-verified against the crank program stored at init
    #[account(
        seeds = [b"market_status"],
        seeds::program = amm_state.crank_program,
        bump
    )]
    pub market_status: UncheckedAccount<'info>,

    #[account(mut, token::mint = usdc_mint, token::authority = buyer)]
    pub buyer_usdc: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(mut, address = amm_state.usdc_vault)]
    pub amm_usdc_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, address = amm_state.usdc_dip)]
    pub usdc_dip: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, address = amm_state.usdc_rewards)]
    pub usdc_rewards: Box<InterfaceAccount<'info, TokenAccount>>,

    pub staking_program: Program<'info, staking::program::Staking>,
    #[account(mut, address = amm_state.staking_pool)]
    pub staking_pool: Box<Account<'info, staking::StakePool>>,
    /// CHECK: derived under the staking program; next_index checked in handler
    #[account(
        mut,
        seeds = [b"user_index", buyer.key().as_ref()],
        seeds::program = staking_program,
        bump
    )]
    pub user_index: UncheckedAccount<'info>,
    /// CHECK: position PDA created by the CPI
    #[account(
        mut,
        seeds = [
            b"position",
            staking_pool.key().as_ref(),
            buyer.key().as_ref(),
            &index.to_le_bytes(),
        ],
        seeds::program = staking_program,
        bump
    )]
    pub stake_position: UncheckedAccount<'info>,

    /// Source: AMM's AFHO reserve (authority = amm_state PDA)
    #[account(mut, address = amm_state.afho_vault)]
    pub amm_afho_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    /// Destination: staking pool vault
    #[account(mut, address = staking_pool.vault)]
    pub staking_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    /// Classic SPL (USDC legs)
    pub token_program: Interface<'info, TokenInterface>,
    /// Token-2022 (AFHO leg into staking)
    pub token_2022_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

pub(crate) fn handler_claim(ctx: Context<AltOfferClaim>, tier: u8, units: u32, index: u64) -> Result<()> {
    let clock = Clock::get()?;
    let amm_state = &ctx.accounts.amm_state;
    let pinned = amm_state.cpmm_pool_state != Pubkey::default();
    require!(pinned, AmmError::PoolNotPinned);
    super::offer_claim::require_pinned_pricing_accounts(
        amm_state.cpmm_program,
        amm_state.cpmm_pool_state,
        &ctx.accounts.afho_mint.key(),
        &ctx.accounts.usdc_mint.key(),
        ctx.accounts.cpmm_pool_state.as_ref(),
        ctx.accounts.cpmm_observation.as_ref(),
        ctx.accounts.cpmm_output_vault.as_ref(),
        ctx.accounts.cpmm_input_vault.as_ref(),
    )?;
    let live_price = super::raydium::read_cpmm_price_floor(
        ctx.accounts.cpmm_pool_state.as_ref().unwrap(),
        ctx.accounts.cpmm_observation.as_ref().unwrap(),
        ctx.accounts.cpmm_output_vault.as_ref().unwrap(),
        ctx.accounts.cpmm_input_vault.as_ref().unwrap(),
        &ctx.accounts.afho_mint.key(),
        &ctx.accounts.usdc_mint.key(),
        clock.unix_timestamp as u64,
    )
    .ok_or(AmmError::InvalidOracle)?;

    let q = quote_alt_claim(
        &ctx.accounts.market_status,
        &ctx.accounts.alt_list,
        ctx.accounts.afho_mint.decimals,
        live_price,
        tier,
        units,
    )?;

    // ── 80/10/10 split of the payment (rounding favors the buyback vault) ──
    let dip = q.cost_usdc / 10;
    let rewards = q.cost_usdc / 10;
    let buyback = q.cost_usdc - dip - rewards;

    let usdc_decimals = ctx.accounts.usdc_mint.decimals;
    for (to, amount) in [
        (ctx.accounts.amm_usdc_vault.to_account_info(), buyback),
        (ctx.accounts.usdc_dip.to_account_info(), dip),
        (ctx.accounts.usdc_rewards.to_account_info(), rewards),
    ] {
        if amount == 0 {
            continue;
        }
        transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.buyer_usdc.to_account_info(),
                    mint: ctx.accounts.usdc_mint.to_account_info(),
                    to,
                    authority: ctx.accounts.buyer.to_account_info(),
                },
            ),
            amount,
            usdc_decimals,
        )?;
    }

    super::offer_claim::validate_user_index(&ctx.accounts.user_index.to_account_info(), index)?;
    super::offer_claim::settle_sheet(&mut ctx.accounts.alt_list, tier, units, q.total_tokens);
    let amm_state = &mut ctx.accounts.amm_state;
    amm_state.total_usdc_proceeds = amm_state.total_usdc_proceeds.saturating_add(q.cost_usdc);

    // ── CPI into staking: purchased AFHO goes DIRECTLY from the AMM vault
    // into a locked StakePosition (vesting = the tier's fixed days) ──
    let mint_key = amm_state.afho_mint;
    let state_bump = amm_state.bump;
    let seeds: &[&[u8]] = &[b"amm_state", mint_key.as_ref(), &[state_bump]];
    super::offer_claim::cpi_create_position(
        ctx.accounts.staking_program.to_account_info(),
        ctx.accounts.buyer.to_account_info(),
        ctx.accounts.afho_mint.to_account_info(),
        ctx.accounts.staking_pool.to_account_info(),
        ctx.accounts.amm_state.to_account_info(),
        ctx.accounts.user_index.to_account_info(),
        ctx.accounts.stake_position.to_account_info(),
        ctx.accounts.amm_afho_vault.to_account_info(),
        ctx.accounts.staking_vault.to_account_info(),
        ctx.accounts.market_status.to_account_info(),
        ctx.accounts.token_2022_program.to_account_info(),
        ctx.accounts.system_program.to_account_info(),
        seeds,
        q.total_raw,
        index,
        q.vesting_days,
    )?;

    msg!(
        "alt claim: {} AFHO ({} lots, tier {}) at {} ({}bps off); paid {} usdc -> {} buyback / {} dip / {} rewards",
        q.total_tokens,
        units,
        tier,
        q.effective_price,
        q.discount_bps,
        q.cost_usdc,
        buyback,
        dip,
        rewards,
    );

    Ok(())
}

// ---------------------------------------------------------------------------
// SOL payment — same desk, lamports in, converted on the pinned SOL/USDC
// pool exactly like offer_claim_sol (solve → wrap → swap → fail-closed
// netting check → 80/10/10 split).
// ---------------------------------------------------------------------------

#[derive(Accounts)]
#[instruction(tier: u8, units: u32, index: u64)]
pub struct AltOfferClaimSol<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,

    #[account(
        mut,
        seeds = [b"amm_state", amm_state.afho_mint.as_ref()],
        bump = amm_state.bump,
    )]
    pub amm_state: Box<Account<'info, AmmState>>,

    #[account(
        mut,
        seeds = [b"alt_offer_list", amm_state.afho_mint.as_ref()],
        bump = alt_list.bump,
    )]
    pub alt_list: Box<Account<'info, OfferList>>,

    #[account(address = amm_state.afho_mint)]
    pub afho_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(address = amm_state.usdc_mint)]
    pub usdc_mint: Box<InterfaceAccount<'info, Mint>>,

    /// Market status PDA — same gate as the USDC path.
    /// CHECK: seeds-verified against the crank program stored at init
    #[account(
        seeds = [b"market_status"],
        seeds::program = amm_state.crank_program,
        bump
    )]
    pub market_status: UncheckedAccount<'info>,

    /// 80% — USDC buyback vault (also the SOL→USDC swap output)
    #[account(mut, address = amm_state.usdc_vault)]
    pub usdc_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    /// 10% — USDC dip reserve
    #[account(mut, address = amm_state.usdc_dip)]
    pub usdc_dip: Box<InterfaceAccount<'info, TokenAccount>>,
    /// 10% — staker rewards holding vault (USDC)
    #[account(mut, address = amm_state.usdc_rewards)]
    pub usdc_rewards: Box<InterfaceAccount<'info, TokenAccount>>,

    // --- wSOL wrap + SOL/USDC swap (All-USDC conversion) ---
    /// CHECK: wSOL ATA owned by amm_state — lamports land here, then sync_native
    #[account(mut)]
    pub wsol_vault: UncheckedAccount<'info>,
    /// wSOL mint (So1111...)
    pub wrapped_sol_mint: Box<InterfaceAccount<'info, Mint>>,
    /// CHECK: SOL/USDC CPMM pool state PDA
    #[account(mut)]
    pub sol_usdc_pool_state: UncheckedAccount<'info>,
    /// CHECK: SOL/USDC amm_config
    pub sol_usdc_amm_config: UncheckedAccount<'info>,
    /// CHECK: pool wSOL vault
    #[account(mut)]
    pub sol_usdc_input_vault: UncheckedAccount<'info>,
    /// CHECK: pool USDC vault
    #[account(mut)]
    pub sol_usdc_output_vault: UncheckedAccount<'info>,
    /// CHECK: pool observation
    #[account(mut)]
    pub sol_usdc_observation: UncheckedAccount<'info>,
    /// CHECK: pool authority PDA
    pub sol_usdc_authority: UncheckedAccount<'info>,

    // --- staking CPI (identical to the USDC path) ---
    pub staking_program: Program<'info, staking::program::Staking>,
    #[account(mut, address = amm_state.staking_pool)]
    pub staking_pool: Box<Account<'info, staking::StakePool>>,
    /// CHECK: derived under the staking program; next_index checked in handler
    #[account(
        mut,
        seeds = [b"user_index", buyer.key().as_ref()],
        seeds::program = staking_program,
        bump
    )]
    pub user_index: UncheckedAccount<'info>,
    /// CHECK: position PDA created by the CPI
    #[account(
        mut,
        seeds = [
            b"position",
            staking_pool.key().as_ref(),
            buyer.key().as_ref(),
            &index.to_le_bytes(),
        ],
        seeds::program = staking_program,
        bump
    )]
    pub stake_position: UncheckedAccount<'info>,

    /// Source: AMM's AFHO reserve (authority = amm_state PDA)
    #[account(mut, address = amm_state.afho_vault)]
    pub amm_afho_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    /// Destination: staking pool vault
    #[account(mut, address = staking_pool.vault)]
    pub staking_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    /// Classic SPL (wSOL + USDC legs)
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub token_program: Interface<'info, TokenInterface>,
    /// Token-2022 (AFHO leg into staking)
    pub token_2022_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,

    // --- Pricing accounts — the pinned pools are the ONLY price sources.
    // Kept as Options purely so the client can omit them when unset; the
    // handler hard-errors unless both pools are pinned and verify.
    /// CHECK: pool state, pinned to amm_state.cpmm_pool_state in the handler
    pub cpmm_pool_state: Option<AccountInfo<'info>>,
    /// CHECK: pool observation (TWAP ring)
    pub cpmm_observation: Option<AccountInfo<'info>>,
    /// CHECK: pool USDC vault (quote leg)
    pub cpmm_input_vault: Option<AccountInfo<'info>>,
    /// CHECK: pool AFHO vault (base leg)
    pub cpmm_output_vault: Option<AccountInfo<'info>>,
}

pub(crate) fn handler_claim_sol(
    ctx: Context<AltOfferClaimSol>,
    tier: u8,
    units: u32,
    index: u64,
) -> Result<()> {
    let clock = Clock::get()?;
    let (cpmm_pool_state, cpmm_program, cpmm_sol_usdc_pool) = {
        let a = &ctx.accounts.amm_state;
        (a.cpmm_pool_state, a.cpmm_program, a.cpmm_sol_usdc_pool)
    };
    let pinned = cpmm_pool_state != Pubkey::default();
    let sol_pinned = cpmm_sol_usdc_pool != Pubkey::default();

    // Both pools are REQUIRED: the AFHO/USDC pool prices the bond, the
    // SOL/USDC pool prices + executes the lamports conversion. No stubs.
    require!(pinned, AmmError::PoolNotPinned);
    require!(sol_pinned, AmmError::PoolNotPinned);

    // AFHO/USDC spot-price accounts.
    super::offer_claim::require_pinned_pricing_accounts(
        cpmm_program,
        cpmm_pool_state,
        &ctx.accounts.afho_mint.key(),
        &ctx.accounts.usdc_mint.key(),
        ctx.accounts.cpmm_pool_state.as_ref(),
        ctx.accounts.cpmm_observation.as_ref(),
        ctx.accounts.cpmm_output_vault.as_ref(),
        ctx.accounts.cpmm_input_vault.as_ref(),
    )?;
    // SOL/USDC swap accounts.
    require!(
        super::raydium::pinned_sol_usdc_accounts_valid(
            cpmm_program,
            cpmm_sol_usdc_pool,
            ctx.accounts.amm_state.cpmm_sol_usdc_config,
            ctx.accounts.wrapped_sol_mint.key(),
            ctx.accounts.usdc_mint.key(),
            &ctx.accounts.sol_usdc_pool_state.to_account_info(),
            &ctx.accounts.sol_usdc_amm_config.to_account_info(),
            &ctx.accounts.sol_usdc_input_vault.to_account_info(),
            &ctx.accounts.sol_usdc_output_vault.to_account_info(),
            &ctx.accounts.sol_usdc_observation.to_account_info(),
            &ctx.accounts.sol_usdc_authority.to_account_info(),
        ),
        AmmError::InvalidPoolAccount
    );

    let live_price = super::raydium::read_cpmm_price_floor(
        ctx.accounts.cpmm_pool_state.as_ref().unwrap(),
        ctx.accounts.cpmm_observation.as_ref().unwrap(),
        ctx.accounts.cpmm_output_vault.as_ref().unwrap(),
        ctx.accounts.cpmm_input_vault.as_ref().unwrap(),
        &ctx.accounts.afho_mint.key(),
        &ctx.accounts.usdc_mint.key(),
        clock.unix_timestamp as u64,
    )
    .ok_or(AmmError::InvalidOracle)?;

    let q = quote_alt_claim(
        &ctx.accounts.market_status,
        &ctx.accounts.alt_list,
        ctx.accounts.afho_mint.decimals,
        live_price,
        tier,
        units,
    )?;

    // ── Convert the USDC-denominated cost into lamports ──
    // The sol_price read is a fail-closed validation that the pinned pool
    // still prices the wSOL/USDC pair; the input is SOLVED from the pool's
    // actual reserves so the swap nets the full USDC cost after the 0.25%
    // input-leg fee AND the trade's own price impact.
    let sol_price = super::raydium::read_cpmm_price_floor(
        &ctx.accounts.sol_usdc_pool_state.to_account_info(),
        &ctx.accounts.sol_usdc_observation.to_account_info(),
        &ctx.accounts.sol_usdc_input_vault.to_account_info(), // wSOL (base)
        &ctx.accounts.sol_usdc_output_vault.to_account_info(), // USDC (quote)
        &ctx.accounts.wrapped_sol_mint.key(),
        &ctx.accounts.usdc_mint.key(),
        clock.unix_timestamp as u64,
    )
    .ok_or(AmmError::InvalidOracle)?;
    require!(sol_price > 0, AmmError::InvalidOracle);
    let pool_wsol =
        super::raydium::token_account_amount(&ctx.accounts.sol_usdc_input_vault.to_account_info())
            .ok_or(AmmError::InvalidOracle)?;
    let pool_usdc =
        super::raydium::token_account_amount(&ctx.accounts.sol_usdc_output_vault.to_account_info())
            .ok_or(AmmError::InvalidOracle)?;
    let lamports = super::raydium::cpmm_swap_input_for_out(
        pool_wsol,
        pool_usdc,
        q.cost_usdc,
        SOL_POOL_TRADE_FEE_BPS,
    )
    .ok_or(AmmError::InsufficientPoolLiquidity)?;
    require!(lamports > 0, AmmError::ZeroAmount);

    // ── 0. Ensure the wSOL ATA exists (bounty_top_up closes it after
    //       unwrapping; recreated here idempotently). ──
    let mint_key = ctx.accounts.amm_state.afho_mint;
    let state_bump = ctx.accounts.amm_state.bump;
    let seeds: &[&[u8]] = &[b"amm_state", mint_key.as_ref(), &[state_bump]];
    create_idempotent(
        CpiContext::new(
            ctx.accounts.associated_token_program.to_account_info(),
            Create {
                payer: ctx.accounts.buyer.to_account_info(),
                associated_token: ctx.accounts.wsol_vault.to_account_info(),
                authority: ctx.accounts.amm_state.to_account_info(),
                mint: ctx.accounts.wrapped_sol_mint.to_account_info(),
                system_program: ctx.accounts.system_program.to_account_info(),
                token_program: ctx.accounts.token_program.to_account_info(),
            },
        )
        .with_signer(&[seeds]),
    )?;

    // ── 1. Wrap the buyer's lamports into the wSOL vault ──
    let buyer_key = ctx.accounts.buyer.key();
    anchor_lang::solana_program::program::invoke(
        &anchor_lang::solana_program::system_instruction::transfer(
            &buyer_key,
            &ctx.accounts.wsol_vault.key(),
            lamports,
        ),
        &[
            ctx.accounts.buyer.to_account_info(),
            ctx.accounts.wsol_vault.to_account_info(),
            ctx.accounts.system_program.to_account_info(),
        ],
    )?;
    sync_native(CpiContext::new(
        ctx.accounts.token_program.to_account_info(),
        SyncNative {
            account: ctx.accounts.wsol_vault.to_account_info(),
        },
    ))?;

    // ── 2. Swap wSOL → USDC via the SOL/USDC pool, output into usdc_vault ──
    let usdc_before = ctx.accounts.usdc_vault.amount;
    // Raydium enforces the economics itself: the input is solved from the
    // pool's reserves so the pool nets ≥ cost_usdc, and the CPI min-out
    // pins that same floor. The vault-delta check re-verifies fail-closed.
    let min_out = q.cost_usdc;
    let ix = crate::instructions::raydium::cpmm_swap_base_input_ix(
        cpmm_program,
        ctx.accounts.amm_state.key(),
        ctx.accounts.sol_usdc_authority.key(),
        ctx.accounts.sol_usdc_amm_config.key(),
        ctx.accounts.sol_usdc_pool_state.key(),
        ctx.accounts.wsol_vault.key(),
        ctx.accounts.usdc_vault.key(),
        ctx.accounts.sol_usdc_input_vault.key(),
        ctx.accounts.sol_usdc_output_vault.key(),
        ctx.accounts.token_program.key(),
        ctx.accounts.token_program.key(),
        ctx.accounts.wrapped_sol_mint.key(),
        ctx.accounts.usdc_mint.key(),
        ctx.accounts.sol_usdc_observation.key(),
        lamports,
        min_out,
    );
    anchor_lang::solana_program::program::invoke_signed(
        &ix,
        &[
            ctx.accounts.amm_state.to_account_info(),
            ctx.accounts.sol_usdc_authority.to_account_info(),
            ctx.accounts.sol_usdc_amm_config.to_account_info(),
            ctx.accounts.sol_usdc_pool_state.to_account_info(),
            ctx.accounts.wsol_vault.to_account_info(),
            ctx.accounts.usdc_vault.to_account_info(),
            ctx.accounts.sol_usdc_input_vault.to_account_info(),
            ctx.accounts.sol_usdc_output_vault.to_account_info(),
            ctx.accounts.token_program.to_account_info(),
            ctx.accounts.token_program.to_account_info(),
            ctx.accounts.wrapped_sol_mint.to_account_info(),
            ctx.accounts.usdc_mint.to_account_info(),
            ctx.accounts.sol_usdc_observation.to_account_info(),
        ],
        &[seeds],
    )?;

    // The swap must net the protocol the full USDC cost: the 80/10/10 split
    // below moves cost-derived amounts out of usdc_vault, so a pool shortfall
    // would otherwise be silently drawn from the pre-existing buyback-vault
    // balance. Fail closed instead.
    ctx.accounts.usdc_vault.reload()?;
    let usdc_got = ctx.accounts.usdc_vault.amount.saturating_sub(usdc_before);
    require!(usdc_got >= q.cost_usdc, AmmError::InsufficientSwapOutput);

    // ── 3. 80/10/10 split of the USDC (rounding favors the buyback vault;
    //       the buyback share simply stays in usdc_vault) ──
    let dip = q.cost_usdc / 10;
    let rewards = q.cost_usdc / 10;
    let usdc_decimals = ctx.accounts.usdc_mint.decimals;
    for (to, amount) in [
        (ctx.accounts.usdc_dip.to_account_info(), dip),
        (ctx.accounts.usdc_rewards.to_account_info(), rewards),
    ] {
        if amount == 0 {
            continue;
        }
        transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.usdc_vault.to_account_info(),
                    mint: ctx.accounts.usdc_mint.to_account_info(),
                    to,
                    authority: ctx.accounts.amm_state.to_account_info(),
                },
                &[seeds],
            ),
            amount,
            usdc_decimals,
        )?;
    }

    super::offer_claim::validate_user_index(&ctx.accounts.user_index.to_account_info(), index)?;
    super::offer_claim::settle_sheet(&mut ctx.accounts.alt_list, tier, units, q.total_tokens);
    let amm_state = &mut ctx.accounts.amm_state;
    amm_state.total_usdc_proceeds = amm_state.total_usdc_proceeds.saturating_add(q.cost_usdc);

    // ── CPI into staking (identical to the USDC path) ──
    let mint_key = amm_state.afho_mint;
    let state_bump = amm_state.bump;
    let seeds: &[&[u8]] = &[b"amm_state", mint_key.as_ref(), &[state_bump]];
    super::offer_claim::cpi_create_position(
        ctx.accounts.staking_program.to_account_info(),
        ctx.accounts.buyer.to_account_info(),
        ctx.accounts.afho_mint.to_account_info(),
        ctx.accounts.staking_pool.to_account_info(),
        ctx.accounts.amm_state.to_account_info(),
        ctx.accounts.user_index.to_account_info(),
        ctx.accounts.stake_position.to_account_info(),
        ctx.accounts.amm_afho_vault.to_account_info(),
        ctx.accounts.staking_vault.to_account_info(),
        ctx.accounts.market_status.to_account_info(),
        ctx.accounts.token_2022_program.to_account_info(),
        ctx.accounts.system_program.to_account_info(),
        seeds,
        q.total_raw,
        index,
        q.vesting_days,
    )?;

    msg!(
        "alt claim: {} AFHO ({} lots, tier {}) at {} ({}bps off); paid {} lamports -> {} usdc",
        q.total_tokens,
        units,
        tier,
        q.effective_price,
        q.discount_bps,
        lamports,
        q.cost_usdc,
    );

    Ok(())
}

// Error enum — this module is appended LAST in instructions/mod.rs so the
// code numbers below extend (never shift) the program's existing codes.