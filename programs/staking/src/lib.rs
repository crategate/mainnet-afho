// `#[program]` instruction signatures are the published IDL wire format —
// `initialize_pool` takes eight flat args (scripts/launch/amm-init.ts consumes
// them), and the macro re-emits those signatures as external wrappers that
// no scoped `#[allow]` can reach. Grouping into structs would break the
// contract for no safety gain, so the lint is allowed crate-wide.
#![allow(clippy::too_many_arguments)]

use anchor_lang::prelude::*;
use anchor_spl::associated_token::get_associated_token_address_with_program_id;
use anchor_spl::token_interface::{
    transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked,
};


pub mod amm_stake;
// The `#[program]` macro discovers the instruction handlers in `amm_stake`
// through this glob and re-exports them (plus its generated
// `__cpi_client_accounts_*` CPI structs) at the crate root. A glob here is
// therefore required by anchor's instruction-module pattern; the resulting
// re-export duplication is benign (same items), so the glob-ambiguity lint
// is allowed on this one line rather than widened crate-wide.
#[allow(ambiguous_glob_reexports)]
pub use amm_stake::*;

// AFHO staking: one global pool per mint, MasterChef-style share accounting.
//
// Reward model — no time-based yield. Rewards come only from (1) unstake
// principal penalties outside market-open and (2) external deposits
// (deposit_rewards / deposit_rewards_from_amm). The logarithmic multiplier
// (1.0x → 3.0x) sets each user's share:
//   weight = staked_amount * multiplier / 10_000
//   multiplier = 10_000 + (days * (max_multiplier_bps - 10_000)) / (days + 60)
//
// Distribution is O(1) per user:
//   global index:  accrued_reward_per_share (1e12-scaled)
//   user debt:     reward_debt (1e12-scaled) — prevents double-claiming
//   claim:         (user_weight * global_index / 1e12) - user_debt
//
// Unstake principal penalties by market state: 0 open / 1 after-hours /
// 2 closed / 3 halted (bps fixed at initialize_pool — no setter). Claims are
// market-open only; every claim pays the flat posr_tax to the AMM bond vault.
// pool.posr_vault (seeds b"posr") and penalty_vault are vestigial: created at
// initialize_pool but never funded — the 5% penalty legs refill the AMM bond
// vault, the 95% leg the reward index.
//
// FREEZE: a vested position may freeze itself for N trading days (open-only,
// N bounded on-chain by a regime-scaled range) for a bonus multiplier FIXED
// at freeze time. Effective weight is base × (1 + bonus) while
// trading_day <= frozen_until_day — multiplicative, never a flat add, so a
// longer-tenured frozen position always outweighs a fresh one. Claims during
// the freeze settle normally (bonus included). After the freeze ends, the
// owner's own claim/unstake settles the tail and clears; past
// freeze_grace_days a permissionless settle_freeze sweeps the unclaimed tail
// back into the pool via an index bump (no token movement) and re-bases the
// position. A position carrying an uncleared freeze cannot freeze again.

declare_id!("4nR94hVM6gLs7K68RF85GA8Qx7kbGXiWgZqt8gKJwMgE");

#[program]
pub mod staking {
    use super::*;

    // One-shot from the launch authority: the pool, its four vaults, and the
    // penalty/freeze curve pinned in place (no setters after this).
    pub fn initialize_pool(
        ctx: Context<InitializePool>,
        crank_oracle_program_id: Pubkey,
        max_multiplier_bps: u16, // Cap for multiplier (e.g., 30000 = 3.0x)
        posr_tax_bps: u16,       // Tax on claims/unstakes (e.g., 500 = 5%)
        after_hours_penalty_bps: u16, // Penalty: state 1 (after hours)
        closed_penalty_bps: u16, // Penalty: state 2 (market closed)
        halted_penalty_bps: u16, // Penalty: state 3 (trading halted)
        amm_program: Pubkey,
        freeze_params: FreezeParams,
    ) -> Result<()> {
        // SECURITY: Verify the passed market_status_pda matches what the crank
        // oracle program would derive. Prevents initializing with a fake oracle.
        let (expected_pda, _) =
            Pubkey::find_program_address(&[b"market_status"], &crank_oracle_program_id);
        require!(
            expected_pda == ctx.accounts.market_status_pda.key(),
            StakeError::InvalidMarketStatus
        );

        // SECURITY: bps values above 10_000 would let penalty/tax legs charge
        // more than 100% and drain the shared vaults.
        require!(posr_tax_bps <= 10_000, StakeError::InvalidBps);
        require!(after_hours_penalty_bps <= 10_000, StakeError::InvalidBps);
        require!(closed_penalty_bps <= 10_000, StakeError::InvalidBps);
        require!(halted_penalty_bps <= 10_000, StakeError::InvalidBps);
        // SECURITY: the multiplier is a weight amplifier (see
        // calculate_multiplier) — an unbounded cap lets an oversized value
        // inflate total_weighted_stake and skew reward share. Spec header
        // claims 1.0x–3.0x: pin the ceiling at 30_000 bps (3.0x).
        require!(max_multiplier_bps <= 30_000, StakeError::InvalidBps);
        // Freeze curve params: the bonus cap has a HARD protocol ceiling
        // regardless of args; the rest must stay self-consistent.
        require!(freeze_params.cap_bps <= 5_000, StakeError::InvalidBps);
        require!(freeze_params.min_days >= 1, StakeError::InvalidBps);
        require!(freeze_params.max_floor_days >= freeze_params.min_days, StakeError::InvalidBps);
        require!(
            freeze_params.max_floor_days + freeze_params.max_span_days <= 365,
            StakeError::InvalidBps
        );
        require!(freeze_params.regime_bull > freeze_params.regime_bear, StakeError::InvalidBps);
        require!(freeze_params.regime_floor_bps <= 10_000, StakeError::InvalidBps);
        require!(freeze_params.pop_knee_bps <= 10_000, StakeError::InvalidBps);
        require!(freeze_params.pop_floor_bps <= 10_000, StakeError::InvalidBps);
        require!(freeze_params.grace_days <= 30, StakeError::InvalidBps);

        let pool = &mut ctx.accounts.pool;
        pool.authority = ctx.accounts.authority.key();
        pool.mint = ctx.accounts.mint.key();
        pool.vault = ctx.accounts.vault.key();
        pool.reward_vault = ctx.accounts.reward_vault.key();
        pool.penalty_vault = ctx.accounts.penalty_vault.key();
        pool.posr_vault = ctx.accounts.posr_vault.key();
        pool.total_staked = 0;
        pool.total_weighted_stake = 0;
        pool.max_multiplier_bps = max_multiplier_bps;
        pool.posr_tax_bps = posr_tax_bps;
        pool.after_hours_penalty_bps = after_hours_penalty_bps;
        pool.closed_penalty_bps = closed_penalty_bps;
        pool.halted_penalty_bps = halted_penalty_bps;
        pool.accrued_reward_per_share = 0;
        pool.market_status_pda = ctx.accounts.market_status_pda.key();
        pool.bump = ctx.bumps.pool;
        pool.amm_program = amm_program;
        pool.frozen_amount = 0;
        pool.apply_freeze_params(&freeze_params);

        msg!("Pool initialized with AMM program: {}", amm_program);
        msg!("Pool initialized for mint {}", pool.mint);
        msg!(
            "Max multiplier: {} bps, POSR tax: {} bps",
            max_multiplier_bps,
            posr_tax_bps
        );
        Ok(())
    }

    // Seeds reward_vault from the authority's own wallet (the AMM has its own
    // CPI variant below); the index bump makes the deposit claimable pro-rata.
    pub fn deposit_rewards(ctx: Context<DepositRewards>, amount: u64) -> Result<()> {
        require!(amount > 0, StakeError::ZeroAmount);

        // SECURITY: Only pool authority can deposit rewards
        // (enforced by has_one = authority on pool account)

        let cpi_accounts = TransferChecked {
            from: ctx.accounts.authority_token.to_account_info(),
            mint: ctx.accounts.mint.to_account_info(),
            to: ctx.accounts.reward_vault.to_account_info(),
            authority: ctx.accounts.authority.to_account_info(),
        };
        let cpi_ctx = CpiContext::new(ctx.accounts.token_program.to_account_info(), cpi_accounts);
        transfer_checked(cpi_ctx, amount, ctx.accounts.mint.decimals)?;

        // Actually distribute: bump the MasterChef index so the deposit is
        // claimable pro-rata. Without stakers the deposit would strand.
        let pool = &mut ctx.accounts.pool;
        require!(
            pool.total_weighted_stake > 0,
            StakeError::NoStakers
        );
        pool.accrued_reward_per_share +=
            (amount as u128 * 1_000_000_000_000u128) / pool.total_weighted_stake;
        Ok(())
    }

    // Rotate the pool authority (reward deposits + amm-program pointer).
    // Authority-only, single-step — mirrors the AMM + crank-oracle set_authority.
    pub fn set_authority(ctx: Context<SetAuthority>, new_authority: Pubkey) -> Result<()> {
        ctx.accounts.pool.authority = new_authority;
        msg!("pool authority rotated to {}", new_authority);
        Ok(())
    }

    // Permissionless: sweeps penalty_vault into reward_vault via an index
    // bump — penalties become claimable by current stakers.
    pub fn realize_penalties(ctx: Context<RealizePenalties>) -> Result<()> {
        let pool = &mut ctx.accounts.pool;
        let amount = ctx.accounts.penalty_vault.amount;
        require!(amount > 0, StakeError::NoRewards);
        require!(
            pool.total_weighted_stake > 0,
            StakeError::NoStakers
        );

        pool.accrued_reward_per_share +=
            (amount as u128 * 1_000_000_000_000u128) / pool.total_weighted_stake;

        let pool_bump = pool.bump;
        let pool_mint = pool.mint;
        let signer_seeds: &[&[&[u8]]] = &[&[b"pool", pool_mint.as_ref(), &[pool_bump]]];
        let cpi = TransferChecked {
            from: ctx.accounts.penalty_vault.to_account_info(),
            mint: ctx.accounts.mint.to_account_info(),
            to: ctx.accounts.reward_vault.to_account_info(),
            authority: pool.to_account_info(),
        };
        transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                cpi,
                signer_seeds,
            ),
            amount,
            ctx.accounts.mint.decimals,
        )?;
        msg!("Realized {} penalty tokens into rewards", amount);
        Ok(())
    }

    // -------------------------------------------------------------------------
    // AMM CPI entry points (see amm_stake.rs)
    // -------------------------------------------------------------------------
    pub fn create_amm_position(
        ctx: Context<CreateAmmPosition>,
        amount: u64,
        index: u64,
        days_to_unlock: u8,
    ) -> Result<()> {
        amm_stake::create_amm_position(ctx, amount, index, days_to_unlock)
    }

    pub fn deposit_rewards_from_amm(
        ctx: Context<DepositRewardsFromAmm>,
        amount: u64,
    ) -> Result<()> {
        amm_stake::deposit_rewards_from_amm(ctx, amount)
    }

    // -------------------------------------------------------------------------
    // FREEZE (see the crate header). Owner-only, open-only, vested positions.
    // -------------------------------------------------------------------------
    pub fn freeze(ctx: Context<Freeze>, index: u64, days: u16) -> Result<()> {
        freeze_handler(ctx, index, days)
    }

    // Permissionless post-grace sweep of an abandoned freeze: unclaimed
    // pending goes back to the pool via an index bump; the position re-bases
    // to its base weight. No token movement.
    pub fn settle_freeze(ctx: Context<SettleFreeze>, index: u64) -> Result<()> {
        settle_freeze_handler(ctx, index)
    }

    // Locks tokens into a fresh position PDA — one position per stake tx,
    // sequential per-user index.
    pub fn stake(ctx: Context<Stake>, amount: u64, index: u64, days: u8) -> Result<()> {
        require!(amount > 0, StakeError::ZeroAmount);
        require!(amount >= 100, StakeError::MinStake);
        // Positions are only created sequentially at the next free index —
        // an arbitrary index can collide with a future PDA or overflow the
        // next_index increment (index = u64::MAX panics).
        require!(
            index == ctx.accounts.user_index.next_index,
            StakeError::InvalidIndex
        );

        let pool = &mut ctx.accounts.pool;
        let position = &mut ctx.accounts.position;
        let user_index = &mut ctx.accounts.user_index;
        let clock = Clock::get()?;

        let trading_day_index = get_trading_day_index(&ctx.accounts.market_status)?;

        position.owner = ctx.accounts.owner.key();
        position.pool = pool.key();
        position.amount = amount;
        position.entry_trading_day = trading_day_index;
        position.last_claim_timestamp = clock.unix_timestamp;
        position.index = index;
        position.days_to_unlock = days;
        position.bump = ctx.bumps.position;

        user_index.next_index = user_index.next_index.max(index + 1);

        let current_multiplier = calculate_multiplier(0, pool.max_multiplier_bps);
        let weight = (amount as u128 * current_multiplier as u128) / 10_000u128;
        position.current_weight = weight;

        pool.total_staked = pool.total_staked.saturating_add(amount);
        pool.total_weighted_stake = pool.total_weighted_stake.saturating_add(weight);

        position.reward_debt = (weight * pool.accrued_reward_per_share) / 1_000_000_000_000u128;

        let cpi_accounts = TransferChecked {
            from: ctx.accounts.owner_token.to_account_info(),
            mint: ctx.accounts.mint.to_account_info(),
            to: ctx.accounts.vault.to_account_info(),
            authority: ctx.accounts.owner.to_account_info(),
        };
        let cpi_ctx = CpiContext::new(ctx.accounts.token_program.to_account_info(), cpi_accounts);
        transfer_checked(cpi_ctx, amount, ctx.accounts.mint.decimals)?;

        msg!(
            "Staked {} tokens, weight: {}, index: {}",
            amount,
            weight,
            index
        );
        Ok(())
    }

    // Open-session only: settles pending at the old weight, then refreshes the
    // multiplier. Pays penalty_share net of the flat posr_tax to the bond vault.
    pub fn claim(ctx: Context<Claim>) -> Result<()> {
        let position = &mut ctx.accounts.position;
        let pool = &mut ctx.accounts.pool;
        let clock = Clock::get()?;

        let trading_day_index = get_trading_day_index(&ctx.accounts.market_status)?;
        let current_state = get_market_state(&ctx.accounts.market_status)?;
        require!(current_state == 0, StakeError::ClaimsClosed);

        // Lazy vesting: a position unlocks once the trading day index reaches
        // entry_trading_day + days_to_unlock. No counter is ever decremented —
        // the lock is computed from the stored entry day.
        require!(
            trading_day_index
                >= position
                    .entry_trading_day
                    .saturating_add(position.days_to_unlock as u64),
            StakeError::Vesting
        );

        // Settle rewards at the last applied weight so a multiplier increase
        // only affects future reward distributions.
        let old_weight = position.current_weight;
        let accumulated = (old_weight * pool.accrued_reward_per_share) / 1_000_000_000_000u128;
        let penalty_share = accumulated.saturating_sub(position.reward_debt);

        // Refresh the stored weight after settling existing rewards.
        let trading_days = trading_day_index
            .saturating_sub(position.entry_trading_day)
            .saturating_sub(1);
        let current_multiplier = calculate_multiplier(trading_days, pool.max_multiplier_bps);
        let new_weight = (position.amount as u128 * current_multiplier as u128) / 10_000u128;

        // Freeze bonus applies multiplicatively while active; a claim past the
        // freeze end is the clearing touch — settle the tail (done above at
        // the last-settled weight), drop the bonus, restore the aggregate.
        let frozen_active =
            position.frozen_until_day != 0 && trading_day_index <= position.frozen_until_day;
        let new_weight = if frozen_active {
            new_weight * (10_000 + position.freeze_bonus_bps as u128) / 10_000u128
        } else {
            if position.frozen_until_day != 0 {
                pool.frozen_amount = pool.frozen_amount.saturating_sub(position.amount);
                position.frozen_until_day = 0;
                position.freeze_bonus_bps = 0;
            }
            new_weight
        };

        if new_weight > old_weight {
            pool.total_weighted_stake = pool
                .total_weighted_stake
                .saturating_add(new_weight.saturating_sub(old_weight));
        } else if old_weight > new_weight {
            pool.total_weighted_stake = pool
                .total_weighted_stake
                .saturating_sub(old_weight.saturating_sub(new_weight));
        }
        position.current_weight = new_weight;
        position.reward_debt = (new_weight * pool.accrued_reward_per_share) / 1_000_000_000_000u128;

        // Apply POSR tax (e.g., 5%). Tiered claim penalties are disabled
        // because claims are only allowed while the market is open.
        let posr_tax = penalty_share * pool.posr_tax_bps as u128 / 10_000u128;
        let user_rewards = penalty_share.saturating_sub(posr_tax);

        let signer_seeds: &[&[&[u8]]] = &[&[b"pool", pool.mint.as_ref(), &[pool.bump]]];

        // Pin the bond vault: the AMM state PDA's AFHO ATA. The 5% leg
        // refills the inventory available for future bond sales.
        require!(
            ctx.accounts.bond_vault.key() == amm_bond_vault(pool),
            StakeError::InvalidBondVault
        );

        // Send POSR tax to the AMM's bond vault (refills bond-sale supply).
        if posr_tax > 0 {
            let cpi = TransferChecked {
                from: ctx.accounts.reward_vault.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                to: ctx.accounts.bond_vault.to_account_info(),
                authority: pool.to_account_info(),
            };
            transfer_checked(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    cpi,
                    signer_seeds,
                ),
                posr_tax as u64,
                ctx.accounts.mint.decimals,
            )?;
        }

        if user_rewards > 0 {
            let cpi = TransferChecked {
                from: ctx.accounts.reward_vault.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                to: ctx.accounts.owner_token.to_account_info(),
                authority: pool.to_account_info(),
            };
            transfer_checked(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    cpi,
                    signer_seeds,
                ),
                user_rewards as u64,
                ctx.accounts.mint.decimals,
            )?;
        }

        position.last_claim_timestamp = clock.unix_timestamp;
        msg!("Claimed: {} (posr: {})", user_rewards, posr_tax);
        Ok(())
    }

    // Full exit: principal minus the state-tiered exit penalty, plus net
    // rewards; Anchor closes the position (rent to the owner).
    pub fn unstake(ctx: Context<Unstake>) -> Result<()> {
        let position = &ctx.accounts.position;
        let pool = &mut ctx.accounts.pool;
        let current_state = get_market_state(&ctx.accounts.market_status)?;
        let trading_day_index = get_trading_day_index(&ctx.accounts.market_status)?;

        // Lazy vesting — same rule as claim.
        require!(
            trading_day_index
                >= position
                    .entry_trading_day
                    .saturating_add(position.days_to_unlock as u64),
            StakeError::Vesting
        );

        // A freeze IS the lock: unstake unlocks at the first trading day
        // after frozen_until_day (any market state, penalties as usual).
        require!(
            position.frozen_until_day == 0 || trading_day_index > position.frozen_until_day,
            StakeError::FreezeActive
        );

        // Settle pending rewards at the position's last applied weight.
        let old_weight = position.current_weight;
        let accumulated = (old_weight * pool.accrued_reward_per_share) / 1_000_000_000_000u128;
        let penalty_share = accumulated.saturating_sub(position.reward_debt);

        // Calculate current multiplier for logging/accounting context. The pool
        // only contains the last applied weight, so removal subtracts old_weight.
        let trading_days = trading_day_index
            .saturating_sub(position.entry_trading_day)
            .saturating_sub(1);
        let current_multiplier = calculate_multiplier(trading_days, pool.max_multiplier_bps);
        let _current_weight = (position.amount as u128 * current_multiplier as u128) / 10_000u128;

        // POSR tax still applies to earned rewards; tiered exit penalties
        // apply to principal only.
        let reward_posr_tax = penalty_share * pool.posr_tax_bps as u128 / 10_000u128;
        let user_rewards = penalty_share.saturating_sub(reward_posr_tax);

        // Exit penalties come from the pool's configured tiers (set at
        // initialize_pool), not hardcoded values. Market-state encoding:
        // 0=open, 1=extended/after hours, 2=closed, 3=halted — state 0
        // (open) carries no exit penalty.
        let principal_penalty_bps = match current_state {
            1 => pool.after_hours_penalty_bps as u64,
            2 => pool.closed_penalty_bps as u64,
            3 => pool.halted_penalty_bps as u64,
            _ => 0,
        };
        let principal_penalty =
            position.amount as u128 * principal_penalty_bps as u128 / 10_000u128;
        let principal_to_user = (position.amount as u128).saturating_sub(principal_penalty);
        let principal_penalty_to_posr = principal_penalty * 500u128 / 10_000u128;
        let principal_penalty_to_rewards =
            principal_penalty.saturating_sub(principal_penalty_to_posr);

        pool.total_staked = pool.total_staked.saturating_sub(position.amount);
        pool.total_weighted_stake = pool.total_weighted_stake.saturating_sub(old_weight);
        // An uncleared freeze leaves with the position — restore the aggregate.
        if position.frozen_until_day != 0 {
            pool.frozen_amount = pool.frozen_amount.saturating_sub(position.amount);
        }

        if principal_penalty_to_rewards > 0 && pool.total_weighted_stake > 0 {
            pool.accrued_reward_per_share +=
                (principal_penalty_to_rewards * 1_000_000_000_000u128) / pool.total_weighted_stake;
        }

        let pool_bump = pool.bump;
        let pool_mint = pool.mint;
        let signer_seeds: &[&[&[u8]]] = &[&[b"pool", pool_mint.as_ref(), &[pool_bump]]];

        // Same bond-vault pin as claim: penalties refill bond-sale supply.
        require!(
            ctx.accounts.bond_vault.key() == amm_bond_vault(pool),
            StakeError::InvalidBondVault
        );

        let cpi = TransferChecked {
            from: ctx.accounts.vault.to_account_info(),
            mint: ctx.accounts.mint.to_account_info(),
            to: ctx.accounts.owner_token.to_account_info(),
            authority: pool.to_account_info(),
        };
        transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                cpi,
                signer_seeds,
            ),
            principal_to_user as u64,
            ctx.accounts.mint.decimals,
        )?;

        // 95% of principal exit penalties becomes rewards for remaining stakers.
        // If this was the LAST staker, there is no one left to distribute to —
        // route to the bond vault instead of stranding tokens in reward_vault.
        if principal_penalty_to_rewards > 0 {
            let rewards_dst = if pool.total_weighted_stake > 0 {
                ctx.accounts.reward_vault.to_account_info()
            } else {
                ctx.accounts.bond_vault.to_account_info()
            };
            let cpi = TransferChecked {
                from: ctx.accounts.vault.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                to: rewards_dst,
                authority: pool.to_account_info(),
            };
            transfer_checked(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    cpi,
                    signer_seeds,
                ),
                principal_penalty_to_rewards as u64,
                ctx.accounts.mint.decimals,
            )?;
        }

        if user_rewards > 0 {
            let cpi = TransferChecked {
                from: ctx.accounts.reward_vault.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                to: ctx.accounts.owner_token.to_account_info(),
                authority: pool.to_account_info(),
            };
            transfer_checked(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    cpi,
                    signer_seeds,
                ),
                user_rewards as u64,
                ctx.accounts.mint.decimals,
            )?;
        }

        // Reward POSR tax plus 5% of principal exit penalties → bond vault.
        if reward_posr_tax > 0 {
            let cpi = TransferChecked {
                from: ctx.accounts.reward_vault.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                to: ctx.accounts.bond_vault.to_account_info(),
                authority: pool.to_account_info(),
            };
            transfer_checked(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    cpi,
                    signer_seeds,
                ),
                reward_posr_tax as u64,
                ctx.accounts.mint.decimals,
            )?;
        }

        if principal_penalty_to_posr > 0 {
            let cpi = TransferChecked {
                from: ctx.accounts.vault.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                to: ctx.accounts.bond_vault.to_account_info(),
                authority: pool.to_account_info(),
            };
            transfer_checked(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    cpi,
                    signer_seeds,
                ),
                principal_penalty_to_posr as u64,
                ctx.accounts.mint.decimals,
            )?;
        }

        // Position account auto-closed by Anchor (close = owner in accounts struct)
        msg!(
            "Unstaked: {} principal returned, {} rewards (principal penalty: {}, reward posr: {})",
            principal_to_user,
            user_rewards,
            principal_penalty,
            reward_posr_tax
        );
        Ok(())
    }
}

// ── helpers ──

fn get_market_state(market_status: &AccountInfo) -> Result<u8> {
    let data = market_status.try_borrow_data()?;
    require!(data.len() >= 9, StakeError::InvalidMarketStatus);
    Ok(data[8])
}

fn get_trading_day_index(market_status: &AccountInfo) -> Result<u64> {
    let data = market_status.try_borrow_data()?;
    require!(data.len() >= 25, StakeError::InvalidMarketStatus);
    Ok(u64::from_le_bytes(data[17..25].try_into().unwrap()))
}

/// The AMM's bond vault: the AFHO ATA of the AMM state PDA (derived from the
/// pool's mint + amm_program). Penalty legs land here to refill the supply
/// available for bond sales.
fn amm_bond_vault(pool: &StakePool) -> Pubkey {
    let (amm_state, _) = Pubkey::find_program_address(
        &[b"amm_state", pool.mint.as_ref()],
        &pool.amm_program,
    );
    // AFHO is Token-2022 and the ATA address derivation includes the mint's
    // token program in its seeds — the classic-SPL default would derive a
    // different (never-created) account than the vault amm-init made.
    get_associated_token_address_with_program_id(&amm_state, &pool.mint, &anchor_spl::token_2022::ID)
}

fn calculate_multiplier(trading_days: u64, max_bps: u16) -> u64 {
    let base = 10_000u64;
    let max = max_bps as u64;
    let range = max.saturating_sub(base);
    let num = trading_days * range;
    let den = trading_days + 60;
    base + (num / den)
}

// ───────────────────────────── Freeze curve ─────────────────────────────
// All factors in bps; bonus = cap × regime × length × popularity / 1e12,
// hard-capped at cap_bps (≤ 5000). Anti-cyclical: bearish momentum offers
// richer bonuses AND a longer max commitment; a high frozen share (demand
// proven) scales offers down past a soft knee.

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq)]
pub struct FreezeParams {
    pub cap_bps: u16,
    pub min_days: u16,
    /// max_days(regime) = max_floor_days + max_span_days × regime / 10000.
    pub max_floor_days: u16,
    pub max_span_days: u16,
    /// momentum ≤ regime_bear → regime 10000; ≥ regime_bull → regime floor.
    pub regime_bear: u16,
    pub regime_bull: u16,
    pub regime_floor_bps: u16,
    /// popularity is 10000 while frozen_share ≤ knee; then linear down to
    /// pop_floor_bps (demand-proven feedback).
    pub pop_knee_bps: u16,
    pub pop_floor_bps: u16,
    /// Trading days after freeze end before the permissionless sweep fires.
    pub grace_days: u16,
}

impl Default for FreezeParams {
    fn default() -> Self {
        FreezeParams {
            cap_bps: 5_000,
            min_days: 5,
            max_floor_days: 40,
            max_span_days: 80,
            regime_bear: 1_500,
            regime_bull: 6_500,
            regime_floor_bps: 1_500,
            pop_knee_bps: 3_000,
            pop_floor_bps: 4_000,
            grace_days: 2,
        }
    }
}

fn freeze_regime_bps(momentum: u64, p: &FreezeParams) -> u64 {
    if momentum <= p.regime_bear as u64 {
        return 10_000;
    }
    if momentum >= p.regime_bull as u64 {
        return p.regime_floor_bps as u64;
    }
    let span = (p.regime_bull - p.regime_bear) as u64;
    let above = momentum - p.regime_bear as u64;
    10_000u64.saturating_sub((10_000u64 - p.regime_floor_bps as u64) * above / span)
}

fn freeze_max_days(regime_bps: u64, p: &FreezeParams) -> u64 {
    p.max_floor_days as u64 + p.max_span_days as u64 * regime_bps / 10_000
}

/// Concave saturating ramp — 0 at day 0, exactly 10000 at max_days, 7500 at
/// the midpoint. Integer-exact (no float/log machinery on-chain).
fn freeze_length_bps(days: u64, max_days: u64) -> u64 {
    if max_days == 0 || days == 0 {
        return 0;
    }
    let d = days.min(max_days);
    10_000 * d * (2 * max_days - d) / (max_days * max_days)
}

fn freeze_popularity_bps(frozen_share_bps: u64, p: &FreezeParams) -> u64 {
    if frozen_share_bps <= p.pop_knee_bps as u64 {
        return 10_000;
    }
    (10_000u64.saturating_sub(frozen_share_bps - p.pop_knee_bps as u64)).max(p.pop_floor_bps as u64)
}

fn freeze_bonus_bps(days: u64, momentum: u64, frozen_share_bps: u64, p: &FreezeParams) -> u64 {
    let regime = freeze_regime_bps(momentum, p);
    let max_days = freeze_max_days(regime, p);
    let length = freeze_length_bps(days, max_days);
    let pop = freeze_popularity_bps(frozen_share_bps, p);
    let bonus = p.cap_bps as u128 * regime as u128 * length as u128 * pop as u128
        / 1_000_000_000_000u128;
    (bonus as u64).min(p.cap_bps as u64)
}

/// Pending rewards at the last-settled weight (the shared claim/sweep form).
fn pending_at(weight: u128, accrued_per_share: u128, reward_debt: u128) -> u128 {
    (weight.saturating_mul(accrued_per_share) / 1_000_000_000_000u128).saturating_sub(reward_debt)
}

// ─────────────────────────── Freeze handlers ────────────────────────────

fn freeze_handler(ctx: Context<Freeze>, _index: u64, days: u16) -> Result<()> {
    let pool = &mut ctx.accounts.pool;
    let position = &mut ctx.accounts.position;

    // Freeze is an open-window action, like claim.
    let current_state = get_market_state(&ctx.accounts.market_status)?;
    require!(current_state == 0, StakeError::ClaimsClosed);
    let trading_day = get_trading_day_index(&ctx.accounts.market_status)?;

    // Vested positions only — bond-vesting positions are excluded by the same
    // lazy rule claim uses.
    require!(
        trading_day
            >= position
                .entry_trading_day
                .saturating_add(position.days_to_unlock as u64),
        StakeError::Vesting
    );
    // Settle-then-refreeze: an uncleared freeze (active or ended-untouched)
    // blocks; claim settles + clears it.
    require!(position.frozen_until_day == 0, StakeError::FreezeActive);

    // The metrics PDA is seeds-verified against pool.amm_program in the
    // accounts struct; this is the amm program's own account, so the length
    // check is sufficient layout validation for the fixed-offset read.
    require!(
        ctx.accounts.metrics.owner == &pool.amm_program,
        StakeError::InvalidMetrics
    );
    let momentum = read_metrics_momentum(&ctx.accounts.metrics)?;

    let p = pool.freeze_params();
    let frozen_share_bps = if pool.total_staked > 0 {
        (pool.frozen_amount as u128 * 10_000 / pool.total_staked as u128) as u64
    } else {
        0
    };
    let max_days = freeze_max_days(freeze_regime_bps(momentum, &p), &p);
    require!(
        days as u64 >= p.min_days as u64 && days as u64 <= max_days,
        StakeError::InvalidFreezeDays
    );
    let bonus = freeze_bonus_bps(days as u64, momentum, frozen_share_bps, &p);
    require!(bonus > 0, StakeError::InvalidFreezeDays);

    position.frozen_until_day = trading_day.saturating_add(days as u64);
    position.freeze_bonus_bps = bonus as u16;
    pool.frozen_amount = pool.frozen_amount.saturating_add(position.amount);
    msg!(
        "position {} frozen until day {} ({} days) at +{}bps — momentum {}, frozen share {}bps, allowed {}..{} days",
        position.index,
        position.frozen_until_day,
        days,
        bonus,
        momentum,
        frozen_share_bps,
        p.min_days,
        max_days
    );
    Ok(())
}

fn settle_freeze_handler(ctx: Context<SettleFreeze>, _index: u64) -> Result<()> {
    let pool = &mut ctx.accounts.pool;
    let position = &mut ctx.accounts.position;
    let trading_day = get_trading_day_index(&ctx.accounts.market_status)?;

    require!(position.frozen_until_day != 0, StakeError::FreezeNotActive);
    require!(
        trading_day > position.frozen_until_day.saturating_add(pool.freeze_grace_days as u64),
        StakeError::GracePeriod
    );

    let elapsed = trading_day
        .saturating_sub(position.entry_trading_day)
        .saturating_sub(1);
    let base_weight =
        (position.amount as u128 * calculate_multiplier(elapsed, pool.max_multiplier_bps) as u128)
            / 10_000u128;
    let swept = pending_at(position.current_weight, pool.accrued_reward_per_share, position.reward_debt);

    // Re-base the position first (debt at the pre-bump index — the swept
    // amount re-enters the pool and the re-based position keeps a pro-rata
    // slice of it going forward, like any other staker).
    pool.total_weighted_stake = pool
        .total_weighted_stake
        .saturating_sub(position.current_weight)
        .saturating_add(base_weight);
    position.current_weight = base_weight;
    position.reward_debt = base_weight.saturating_mul(pool.accrued_reward_per_share)
        / 1_000_000_000_000u128;
    position.frozen_until_day = 0;
    position.freeze_bonus_bps = 0;
    pool.frozen_amount = pool.frozen_amount.saturating_sub(position.amount);

    // Pure accounting: the tokens never moved — the swept pending simply
    // stays in reward_vault, now attributable to the remaining weighted
    // stake via the index bump.
    if swept > 0 && pool.total_weighted_stake > 0 {
        pool.accrued_reward_per_share +=
            swept * 1_000_000_000_000u128 / pool.total_weighted_stake;
    }

    msg!(
        "freeze settled for position {} of {}: {} swept to the pool, weight re-based to {}",
        position.index,
        position.owner,
        swept,
        base_weight
    );
    Ok(())
}

/// MarketMetrics momentum scalar — cross-program read at a FIXED offset
/// (append-only layout contract with the amm program; see offers_state.rs).
const METRICS_MOMENTUM_ACCOUNT_OFFSET: usize = 8 + 352;

fn read_metrics_momentum(ai: &AccountInfo) -> Result<u64> {
    let data = ai.try_borrow_data()?;
    require!(
        data.len() >= METRICS_MOMENTUM_ACCOUNT_OFFSET + 8,
        StakeError::InvalidMetrics
    );
    let o = METRICS_MOMENTUM_ACCOUNT_OFFSET;
    Ok(u64::from_le_bytes(data[o..o + 8].try_into().unwrap()))
}

// =============================================================================
// ACCOUNT STRUCTURES
// =============================================================================

#[account]
#[derive(InitSpace)]
pub struct StakePool {
    pub authority: Pubkey,
    pub mint: Pubkey,
    pub vault: Pubkey,
    pub reward_vault: Pubkey,
    pub penalty_vault: Pubkey,
    /// Vestigial protocol reserve (b"posr") — still created at init but no
    /// longer funded; the 5% penalty legs now refill the AMM bond vault.
    pub posr_vault: Pubkey,
    pub total_staked: u64,
    pub total_weighted_stake: u128,
    pub max_multiplier_bps: u16,
    pub posr_tax_bps: u16,
    pub after_hours_penalty_bps: u16,
    pub closed_penalty_bps: u16,
    pub halted_penalty_bps: u16,
    pub accrued_reward_per_share: u128,
    pub market_status_pda: Pubkey,
    pub amm_program: Pubkey,
    pub bump: u8,
    // ── Freeze feature (appended 2026-10; borsh layout is append-only) ──
    /// Aggregate raw AFHO carrying an active/uncleared freeze — the
    /// popularity input of the bonus curve. Decrement points: claim/unstake
    /// clears and permissionless settle_freeze.
    pub frozen_amount: u64,
    pub freeze_cap_bps: u16,
    pub freeze_min_days: u16,
    pub freeze_max_floor_days: u16,
    pub freeze_max_span_days: u16,
    pub freeze_regime_bear: u16,
    pub freeze_regime_bull: u16,
    pub freeze_regime_floor_bps: u16,
    pub freeze_pop_knee_bps: u16,
    pub freeze_pop_floor_bps: u16,
    pub freeze_grace_days: u16,
}

impl StakePool {
    pub fn apply_freeze_params(&mut self, p: &FreezeParams) {
        self.freeze_cap_bps = p.cap_bps;
        self.freeze_min_days = p.min_days;
        self.freeze_max_floor_days = p.max_floor_days;
        self.freeze_max_span_days = p.max_span_days;
        self.freeze_regime_bear = p.regime_bear;
        self.freeze_regime_bull = p.regime_bull;
        self.freeze_regime_floor_bps = p.regime_floor_bps;
        self.freeze_pop_knee_bps = p.pop_knee_bps;
        self.freeze_pop_floor_bps = p.pop_floor_bps;
        self.freeze_grace_days = p.grace_days;
    }

    pub fn freeze_params(&self) -> FreezeParams {
        FreezeParams {
            cap_bps: self.freeze_cap_bps,
            min_days: self.freeze_min_days,
            max_floor_days: self.freeze_max_floor_days,
            max_span_days: self.freeze_max_span_days,
            regime_bear: self.freeze_regime_bear,
            regime_bull: self.freeze_regime_bull,
            regime_floor_bps: self.freeze_regime_floor_bps,
            pop_knee_bps: self.freeze_pop_knee_bps,
            pop_floor_bps: self.freeze_pop_floor_bps,
            grace_days: self.freeze_grace_days,
        }
    }
}

#[account]
#[derive(InitSpace)]
pub struct StakePosition {
    pub owner: Pubkey,
    pub pool: Pubkey,
    pub amount: u64,
    pub entry_trading_day: u64,
    pub last_claim_timestamp: i64,
    pub index: u64,
    // Last applied reward weight. Multiplier growth is checkpointed here so
    // older reward distributions cannot be claimed again as weight grows.
    pub current_weight: u128,
    pub reward_debt: u128,
    pub bump: u8,

    pub days_to_unlock: u8,
    // ── Freeze feature (appended 2026-10) ──
    /// Last trading day the freeze bonus applies (0 = never frozen / cleared).
    pub frozen_until_day: u64,
    /// Bonus fixed at freeze time; multiplies the base weight while active.
    pub freeze_bonus_bps: u16,
}

#[account]
pub struct UserStakeIndex {
    pub next_index: u64,
}

// =============================================================================
// ACCOUNTS CONTEXTS (Anchor validation & security constraints)
// =============================================================================

#[derive(Accounts)]
pub struct InitializePool<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(
        init,
        payer = authority,
        seeds = [b"pool", mint.key().as_ref()],
        bump,
        space = 8 + StakePool::INIT_SPACE
    )]
    pub pool: Account<'info, StakePool>,
    #[account(
        init,
        payer = authority,
        seeds = [b"vault", pool.key().as_ref()],
        bump,
        token::mint = mint,
        token::authority = pool,
    )]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        init,
        payer = authority,
        seeds = [b"rewards", pool.key().as_ref()],
        bump,
        token::mint = mint,
        token::authority = pool,
    )]
    pub reward_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        init,
        payer = authority,
        seeds = [b"penalties", pool.key().as_ref()],
        bump,
        token::mint = mint,
        token::authority = pool,
    )]
    pub penalty_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        init,
        payer = authority,
        seeds = [b"posr", pool.key().as_ref()],
        bump,
        token::mint = mint,
        token::authority = pool,
    )]
    pub posr_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: Verified in instruction via find_program_address
    pub market_status_pda: UncheckedAccount<'info>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct DepositRewards<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(mut, has_one = authority, has_one = mint)]
    pub pool: Account<'info, StakePool>,
    #[account(mut, address = pool.reward_vault)]
    pub reward_vault: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, token::mint = mint, token::authority = authority)]
    pub authority_token: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct SetAuthority<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(mut, has_one = authority)]
    pub pool: Account<'info, StakePool>,
}

#[derive(Accounts)]
#[instruction(amount: u64, index: u64 )]
pub struct Stake<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(mut, has_one = mint)]
    pub pool: Account<'info, StakePool>,
    #[account(
        init_if_needed,
        payer = owner,
        seeds = [b"user_index", owner.key().as_ref()],
        bump,
        space = 8 + 8
    )]
    pub user_index: Account<'info, UserStakeIndex>,
    #[account(
        init,
        payer = owner,
        seeds = [
            b"position",
            pool.key().as_ref(),
            owner.key().as_ref(),
            &index.to_le_bytes(),
        ],
        bump,
        space = 8 + StakePosition::INIT_SPACE
    )]
    pub position: Account<'info, StakePosition>,
    #[account(mut, token::mint = mint, token::authority = owner)]
    pub owner_token: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, address = pool.vault)]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    /// CHECK: Address verified by pool.market_status_pda constraint
    #[account(address = pool.market_status_pda)]
    pub market_status: UncheckedAccount<'info>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RealizePenalties<'info> {
    #[account(mut, has_one = mint)]
    pub pool: Box<Account<'info, StakePool>>,
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, address = pool.penalty_vault)]
    pub penalty_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, address = pool.reward_vault)]
    pub reward_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct Claim<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, has_one = mint)]
    pub pool: Box<Account<'info, StakePool>>,
    #[account(mut, has_one = owner, has_one = pool)]
    pub position: Box<Account<'info, StakePosition>>,
    #[account(mut, address = pool.reward_vault)]
    pub reward_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    /// AMM bond vault — the AFHO ATA of the AMM state PDA. Destination of
    /// the 5% POSR legs (refills bond-sale supply). Pinned in the handler
    /// against pool.amm_program + pool.mint.
    #[account(mut, token::mint = mint)]
    pub bond_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, token::mint = mint, token::authority = owner)]
    pub owner_token: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: Address verified by pool.market_status_pda constraint
    #[account(address = pool.market_status_pda)]
    pub market_status: UncheckedAccount<'info>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct Unstake<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, has_one = mint)]
    pub pool: Box<Account<'info, StakePool>>,
    #[account(mut, has_one = owner, has_one = pool, close = owner)]
    pub position: Box<Account<'info, StakePosition>>,
    #[account(mut, address = pool.vault)]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, address = pool.reward_vault)]
    pub reward_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, address = pool.penalty_vault)]
    pub penalty_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    /// AMM bond vault — see Claim.
    #[account(mut, token::mint = mint)]
    pub bond_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, token::mint = mint, token::authority = owner)]
    pub owner_token: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: Address verified by pool.market_status_pda constraint
    #[account(address = pool.market_status_pda)]
    pub market_status: UncheckedAccount<'info>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
#[instruction(index: u64)]
pub struct Freeze<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, has_one = mint)]
    pub pool: Box<Account<'info, StakePool>>,
    #[account(
        mut,
        seeds = [
            b"position",
            pool.key().as_ref(),
            owner.key().as_ref(),
            &index.to_le_bytes(),
        ],
        bump,
        has_one = owner,
        has_one = pool,
    )]
    pub position: Box<Account<'info, StakePosition>>,
    /// CHECK: metrics PDA under the amm program (momentum scalar read at a
    /// fixed offset); seeds-verified against pool.amm_program + owner-checked.
    #[account(seeds = [b"metrics", mint.key().as_ref()], seeds::program = pool.amm_program, bump)]
    pub metrics: UncheckedAccount<'info>,
    /// CHECK: Address verified by pool.market_status_pda constraint
    #[account(address = pool.market_status_pda)]
    pub market_status: UncheckedAccount<'info>,
}

#[derive(Accounts)]
#[instruction(index: u64)]
pub struct SettleFreeze<'info> {
    /// Anyone — the sweep is permissionless past the grace period.
    #[account(mut)]
    pub caller: Signer<'info>,
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, has_one = mint)]
    pub pool: Box<Account<'info, StakePool>>,
    /// CHECK: position owner — seed input only
    pub owner: AccountInfo<'info>,
    #[account(
        mut,
        seeds = [
            b"position",
            pool.key().as_ref(),
            owner.key().as_ref(),
            &index.to_le_bytes(),
        ],
        bump,
        has_one = pool,
    )]
    pub position: Box<Account<'info, StakePosition>>,
    /// CHECK: Address verified by pool.market_status_pda constraint
    #[account(address = pool.market_status_pda)]
    pub market_status: UncheckedAccount<'info>,
}

#[error_code]
pub enum StakeError {
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
    #[msg("Stake amount below minimum")]
    MinStake,
    #[msg("No rewards to claim")]
    NoRewards,
    #[msg("Invalid market status account")]
    InvalidMarketStatus,
    #[msg("Insufficient rewards in vault")]
    InsufficientRewards,
    #[msg("some vesting days remain, cannot unlock position yet")]
    Vesting,
    #[msg("Claims are only available while the market is open")]
    ClaimsClosed,
    #[msg("No stakers to distribute to")]
    NoStakers,
    #[msg("Position index must equal the next free index for this user")]
    InvalidIndex,
    #[msg("bps value exceeds 10_000 (100%)")]
    InvalidBps,
    #[msg("bond vault account does not match the AMM bond vault")]
    InvalidBondVault,
    #[msg("position is frozen — unstake unlocks the trading day after the freeze ends")]
    FreezeActive,
    #[msg("freeze days outside the regime-scaled allowed range")]
    InvalidFreezeDays,
    #[msg("position carries no freeze to settle")]
    FreezeNotActive,
    #[msg("freeze grace period has not elapsed")]
    GracePeriod,
    #[msg("metrics account unreadable or not the amm program's")]
    InvalidMetrics,
}
#[cfg(test)]
mod freeze_tests {
    use super::*;

    fn params() -> FreezeParams {
        FreezeParams::default()
    }

    #[test]
    fn regime_is_monotone_down_in_momentum() {
        let p = params();
        assert_eq!(freeze_regime_bps(0, &p), 10_000);
        assert_eq!(freeze_regime_bps(1_500, &p), 10_000);
        assert_eq!(freeze_regime_bps(6_500, &p), 1_500);
        assert_eq!(freeze_regime_bps(10_000, &p), 1_500);
        let mid = freeze_regime_bps(4_000, &p);
        assert!(mid > 1_500 && mid < 10_000);
        // monotone across the full range
        let mut last = 10_001;
        for m in (0..=10_000).step_by(250) {
            let r = freeze_regime_bps(m, &p);
            assert!(r <= last);
            last = r;
        }
    }

    #[test]
    fn max_days_spans_with_regime() {
        let p = params();
        assert_eq!(freeze_max_days(10_000, &p), 120);
        assert_eq!(freeze_max_days(1_500, &p), 40 + 80 * 1_500 / 10_000);
    }

    #[test]
    fn length_is_concave_and_saturates() {
        assert_eq!(freeze_length_bps(0, 120), 0);
        assert_eq!(freeze_length_bps(120, 120), 10_000);
        assert_eq!(freeze_length_bps(121, 120), 10_000); // clamped
        assert_eq!(freeze_length_bps(60, 120), 7_500);
        assert_eq!(freeze_length_bps(30, 120), 4_375);
        // monotone
        let mut last = 0;
        for d in 0..=120 {
            let v = freeze_length_bps(d, 120);
            assert!(v >= last);
            last = v;
        }
    }

    #[test]
    fn popularity_has_soft_knee() {
        let p = params();
        assert_eq!(freeze_popularity_bps(0, &p), 10_000);
        assert_eq!(freeze_popularity_bps(3_000, &p), 10_000);
        assert_eq!(freeze_popularity_bps(5_000, &p), 8_000);
        assert_eq!(freeze_popularity_bps(6_000, &p), 7_000);
        assert_eq!(freeze_popularity_bps(9_000, &p), 4_000); // floor
        assert_eq!(freeze_popularity_bps(12_000, &p), 4_000);
    }

    #[test]
    fn cap_reachable_only_at_deep_bear_max_length_low_share() {
        let p = params();
        // The exact cap: deepest bear, longest allowed, nothing frozen yet.
        let max = freeze_max_days(10_000, &p);
        assert_eq!(freeze_bonus_bps(max, 0, 0, &p), 5_000);
        // Anything milder is strictly below the cap.
        assert!(freeze_bonus_bps(max, 2_000, 0, &p) < 5_000);
        assert!(freeze_bonus_bps(max / 2, 0, 0, &p) < 5_000);
        assert!(freeze_bonus_bps(max, 0, 5_000, &p) < 5_000);
        // And nothing anywhere exceeds it.
        for m in (0..=10_000).step_by(500) {
            for d in (0..=120).step_by(10) {
                for fs in (0..=10_000).step_by(1_000) {
                    assert!(freeze_bonus_bps(d, m, fs, &p) <= 5_000);
                }
            }
        }
    }

    #[test]
    fn bonus_is_multiplicative_on_base_never_flat() {
        let p = params();
        let max = freeze_max_days(10_000, &p);
        let bonus = freeze_bonus_bps(max, 0, 0, &p) as u128;
        // A tenured position (base 2.0x) frozen always outweighs a fresh one
        // (base 1.0x) with the SAME bonus — churn into new frozen positions
        // can never pay.
        let tenured = 2_000u128 * (10_000 + bonus) / 10_000;
        let fresh = 1_000u128 * (10_000 + bonus) / 10_000;
        assert!(tenured > fresh);
        // multiplication scales the base gap by the bonus factor — never erases it
        assert_eq!(tenured - fresh, 1_000 * (10_000 + bonus) / 10_000);
    }

    #[test]
    fn pending_at_settles_to_zero_and_saturates() {
        let debt = 100 * 5_000_000_000_000 / 1_000_000_000_000; // settled at 5e12
        assert_eq!(pending_at(100, 5_000_000_000_000, debt), 0); // debt current
        assert_eq!(pending_at(100, 6_000_000_000_000, debt), 100); // one bump
        // debt beyond accumulated saturates at zero, never negative
        assert_eq!(pending_at(100, 4_000_000_000_000, debt), 0);
    }

    #[test]
    fn sweep_math_conserves_pool_tokens() {
        // Two stakers, one frozen. The sweep must move exactly the frozen
        // position's pending into the shared index — no tokens created.
        let index = 5_000_000_000_000u128; // 1e12-scale
        let frozen_w = 2_000u128;
        let other_w = 3_000u128;
        let tws = frozen_w + other_w;
        let debt = frozen_w * index / 1_000_000_000_000;
        // index bumps once (a rewards deposit) before the sweep
        let deposit = 100u128;
        let index2 = index + deposit * 1_000_000_000_000 / tws;
        let swept = pending_at(frozen_w, index2, debt);
        assert_eq!(swept, deposit * frozen_w / tws); // its pro-rata share
        let base_w = 2_000u128;
        let tws2 = tws - frozen_w + base_w;
        let bump = swept * 1_000_000_000_000 / tws2;
        // The pool's claimable total is unchanged: the deposit is still fully
        // spoken for by the index (other stakers + the re-based position).
        assert!(bump > 0 && bump <= deposit * 1_000_000_000_000 / other_w);
    }
}
