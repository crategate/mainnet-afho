use crate::state::offers_state::{AcceptedOffers, AmmState, MarketMetrics, OfferList};
use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token_2022::Token2022,
    token_interface::{Mint, TokenAccount, TokenInterface},
};

pub(crate) fn handler(
    ctx: Context<InitializeAmm>,
    staking_pool: Pubkey,
) -> Result<()> {
    let amm_state = &mut ctx.accounts.amm_state;
    let offer_list = &mut ctx.accounts.offer_list;

    amm_state.authority = ctx.accounts.authority.key();
    // Single-wallet setups (devnet) work out of the box; rotate for mainnet.
    amm_state.keeper = ctx.accounts.authority.key();
    amm_state.afho_mint = ctx.accounts.afho_mint.key();
    amm_state.usdc_mint = ctx.accounts.usdc_mint.key();
    amm_state.usdc_vault = ctx.accounts.usdc_vault.key();
    amm_state.usdc_dip = ctx.accounts.usdc_dip.key();
    amm_state.afho_vault = ctx.accounts.afho_vault.key();
    amm_state.offer_list = offer_list.key();
    amm_state.accepted_offers = ctx.accounts.accepted_offers.key();
    amm_state.market_status_pda = ctx.accounts.market_status_pda.key();
    amm_state.crank_program = ctx.accounts.crank_program.key();
    // Raydium CPMM pool is pinned later via set_cpmm_pool (once the launch
    // pool exists); default(0) until then.
    amm_state.cpmm_pool_state = Pubkey::default();
    amm_state.cpmm_amm_config = Pubkey::default();
    amm_state.cpmm_program = Pubkey::default();
    amm_state.cpmm_sol_usdc_pool = Pubkey::default();
    amm_state.cpmm_sol_usdc_config = Pubkey::default();
    amm_state.total_usdc_proceeds = 0;
    amm_state.highest_buyback_basis = 0;
    // All day-index guards init to u64::MAX, NOT 0: the first trading day IS
    // day 0, and the guards are `stored != current_day` — a 0 init would
    // deadlock make_offers / update_tradeday_stats / calc_completed_offers /
    // distribute_staker_rewards on launch day (L1). u64::MAX never collides
    // with a real day index.
    amm_state.bb_day_index = u64::MAX;
    amm_state.bb_budget_usdc = 0;
    amm_state.bb_spent_usdc = 0;
    amm_state.bb_slice_count = 0;
    amm_state.bb_last_slot = 0;
    amm_state.untaken_days = 0;
    amm_state.staking_pool = staking_pool;
    amm_state.usdc_rewards = ctx.accounts.usdc_rewards.key();
    amm_state.rewards_day_index = u64::MAX;
    amm_state.dip_day_index = u64::MAX;
    amm_state.dip_day_usdc = 0;
    amm_state.dip_spent_usdc = 0;
    amm_state.dip_last_slot = 0;
    amm_state.dip_slice_count = 0;
    amm_state.bump = ctx.bumps.amm_state;

    offer_list.owner = ctx.accounts.authority.key();
    offer_list.seed = 0;
    offer_list.day_index = u64::MAX; // L1: see day-index comment above
    offer_list.total_complete = 0;
    offer_list.bump = ctx.bumps.offer_list;

    let empty_offer = crate::state::offers_state::Offer {
        lot_size: 0,
        vesting_days: 0,
        discount_bps: 0,
        _pad: 0,
        remaining: 0,
        total_offered: 0,
    };
    offer_list.big_offer = empty_offer;
    offer_list.med_offer = empty_offer;
    offer_list.sml_offer = empty_offer;

    let accepted_offers = &mut ctx.accounts.accepted_offers;
    accepted_offers.day_index = u64::MAX; // L1
    accepted_offers.big_offers_accepted = [0; 5];
    accepted_offers.med_offers_accepted = [0; 5];
    accepted_offers.sml_offers_accepted = [0; 5];

    let metrics = &mut ctx.accounts.metrics;
    metrics.day_index = u64::MAX; // L1
    metrics.price_changes = [0; 20];
    metrics.sample_head = 0;
    metrics.total_staked = 0;
    metrics.total_supply = 0;
    metrics.available_supply = 0;
    metrics.trailing_stake_health = [0; 5];
    metrics.spot_prices = [0; 32];
    metrics.spot_head = 0;
    metrics.spot_last_slot = 0;

    msg!(
        "did initialize the AMM empty state for mint {}",
        amm_state.afho_mint
    );
    Ok(())
}

#[derive(Accounts)]
pub struct InitializeAmm<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    pub afho_mint: Box<InterfaceAccount<'info, Mint>>,
    pub usdc_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(
        init,
        payer=authority,
        seeds=[b"amm_state", afho_mint.key().as_ref()],
        bump,
        space = 8 + std::mem::size_of::<AmmState>(),
    )]
    pub amm_state: Box<Account<'info, AmmState>>,
    /// CHECK: afho vault
    #[account(
        associated_token::mint = afho_mint,
        associated_token::authority = amm_state,
        associated_token::token_program = token_2022_program,
    )]
    pub afho_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: usdc vault
    #[account(
       associated_token::mint = usdc_mint,
        associated_token::authority = amm_state,
        associated_token::token_program = token_program,
    )]
    pub usdc_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    /// 10% — dip reserve. PDA-derived token account, NOT an ATA: the ATA of
    /// (usdc_mint, amm_state) IS usdc_vault, so "three ATAs" would be one
    /// account and the 80/10/10 split would collapse into it.
    #[account(
        init,
        payer = authority,
        seeds = [b"amm_usdc_dip", afho_mint.key().as_ref()],
        bump,
        token::mint = usdc_mint,
        token::authority = amm_state,
        token::token_program = token_program,
    )]
    pub usdc_dip: Box<InterfaceAccount<'info, TokenAccount>>,
    /// Holding vault for the stakers' 10% USDC share (same PDA-token pattern
    /// as usdc_dip — distinct address from usdc_vault by construction)
    #[account(
        init,
        payer = authority,
        seeds = [b"amm_usdc_rewards", afho_mint.key().as_ref()],
        bump,
        token::mint = usdc_mint,
        token::authority = amm_state,
        token::token_program = token_program,
    )]
    pub usdc_rewards: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        init,
        payer = authority,
        seeds = [b"offer_list", afho_mint.key().as_ref()],
        bump,
        space = 8 + std::mem::size_of::<OfferList>(),
    )]
    pub offer_list: Box<Account<'info, OfferList>>,
    #[account(
        init,
        payer = authority,
        seeds = [b"accepted_offers", afho_mint.key().as_ref()],
        bump,
        space = 8 + std::mem::size_of::<AcceptedOffers>(),
    )]
    pub accepted_offers: Box<Account<'info, AcceptedOffers>>,
    #[account(
        init,
        payer = authority,
        seeds = [b"metrics", afho_mint.key().as_ref()],
        bump,
        space = 8 + std::mem::size_of::<MarketMetrics>(),
    )]
    pub metrics: Box<Account<'info, MarketMetrics>>,

    /// CHECK: seeds derive against the crank program
    #[account(
        seeds = [b"market_status"],
        bump,
        seeds::program = crank_program,
    )]
    pub market_status_pda: UncheckedAccount<'info>,

    /// CHECK: stored for verification in make_offers
    pub crank_program: AccountInfo<'info>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub token_program: Interface<'info, TokenInterface>,
    pub token_2022_program: Program<'info, Token2022>,
    pub system_program: Program<'info, System>,
}