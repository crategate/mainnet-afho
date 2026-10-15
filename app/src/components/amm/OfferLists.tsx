import { useEffect, useMemo, useRef, useState } from 'react';
import { useWallet, useConnection } from '@solana/wallet-adapter-react';
import { useWalletModal } from '@solana/wallet-adapter-react-ui';
import { getAccount, getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { useAmmData, type OfferTierData } from '../../hooks/amm/useAmmData.ts';
import { useOfferClaim, type ClaimCurrency } from '../../hooks/amm/useOfferClaim.ts';
import {
    formatSol,
    formatTokens,
    formatUsdc,
    lamportsForCost,
    lamportsForCostExact,
    meetsMinRealDiscount,
    pricePerToken,
    quoteCostRaw,
    quoteDiscounted,
    quoteSheetEffective,
    ratchetActive,
} from '../../hooks/amm/offerMath.ts';
import SizedOffers from './SizedOffers.tsx';
import { GlitchText } from '../GlitchText.tsx';
import FlashNumber from '../FlashNumber.tsx';
import { WalletMark } from '../WalletMark.tsx';
import { SolscanMark, SolanaMark } from '../BrandIcons.tsx';
import { explorerUrls } from '../TxResultModal.tsx';
import { useDeployment } from '../../hooks/useDeployment';

const PERCENT_STEPS = [25, 50, 75, 100] as const;

// A buy decision must never run on a stale price snapshot: the poll cadence
// is POLL_MS (30s default) and websocket account-change notifications keep a
// healthy session fresh within seconds, but a rate-limited (429) stretch can
// silently age the price well past that. After PRICE_STALE_MS the desk stops
// quoting and blocks the buy until a fresh tick lands — a locked price on a
// moving pool is exactly how "buyable" quotes turn into on-chain reverts.
const PRICE_STALE_MS = 90_000;
const PRICE_AGE_TICK_MS = 5_000;

function deskMessage(state: number | null, sheetStale: boolean, offersLive: boolean, altActive: boolean): string {
    if (state === 3) {
        // The alt window replaces the regular desk message while it's live.
        if (altActive) return '';
        return 'Offer desk is paused while the market is suspended.';
    }
    if (state === 0) return 'Desk opens after market close — check back at the end of the trading day.';
    if (state === 1 || state === 2) {
        if (sheetStale) return "Tonight's offer sheet hasn't posted yet — check back shortly after close.";
        if (!offersLive) return "No offers on tonight's sheet — check back at the end of the next trading day.";
    }
    return '';
}

export default function OfferLists() {
    const data = useAmmData();
    const { connected, publicKey } = useWallet();
    const { connection } = useConnection();
    // Alt mode rides the same claim machinery: when the alt window is live
    // the hook routes to alt_offer_claim / alt_offer_claim_sol (alt sheet
    // account, state-3 gate) instead of the night-desk instructions.
    const { claim, status, txSig, error: claimError, reset } = useOfferClaim(
        data.accounts,
        data.solAccounts,
        data.usdcDecimals,
        data.altActive,
    );
    const { setVisible } = useWalletModal();
    const { deployment } = useDeployment();
    const [quantities, setQuantities] = useState<Record<string, number>>({ big: 0, med: 0, sml: 0 });
    const [currency, setCurrency] = useState<ClaimCurrency>('usdc');
    const [menuOpen, setMenuOpen] = useState(false);
    const [balances, setBalances] = useState<{ usdc: bigint | null; sol: bigint | null }>({ usdc: null, sol: null });
    const pickerRef = useRef<HTMLDivElement>(null);
    const claimErrorRef = useRef<HTMLDivElement>(null);
    const rpcErrorRef = useRef<HTMLDivElement>(null);

    // Age of the live-price snapshot, re-ticked every few seconds so the
    // staleness gate flips without waiting for a render.
    const [nowMs, setNowMs] = useState(() => Date.now());
    useEffect(() => {
        const id = window.setInterval(() => setNowMs(Date.now()), PRICE_AGE_TICK_MS);
        return () => window.clearInterval(id);
    }, []);
    const priceAgeMs = data.updatedAt ? Math.max(0, nowMs - new Date(data.updatedAt).getTime()) : null;
    const priceStale = data.livePrice !== null && (priceAgeMs === null || priceAgeMs > PRICE_STALE_MS);

    // Errors render at the bottom of the section — pull them into view when
    // they appear so a failed claim is never silent below the fold.
    useEffect(() => {
        if (status === 'error' && claimError) {
            claimErrorRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
    }, [status, claimError]);
    useEffect(() => {
        if (data.error) {
            rpcErrorRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
    }, [data.error]);

    // Clamp quantities if the sheet refreshes with fewer remaining lots
    useEffect(() => {
        setQuantities((prev) => {
            const next = { ...prev };
            let changed = false;
            for (const t of data.tiers) {
                if ((next[t.key] ?? 0) > t.remaining) {
                    next[t.key] = t.remaining;
                    changed = true;
                }
            }
            // Return `prev` (same reference) when nothing changed, otherwise
            // the new object re-renders forever — data.tiers is a fresh array
            // while offerList is loading → "Maximum update depth exceeded".
            return changed ? next : prev;
        });
    }, [data.tiers]);

    // Buyer's spendable balances for the % quick-fill buttons. Own 15s cadence
    // (not tied to the 30s price poll) to spare the rate-limited devnet RPC.
    // `accounts` is read through a ref and the interval is keyed by a stable
    // string: the accounts memo is rebuilt whenever any snapshot field changes
    // identity (every 30s poll), and an effect keyed on the object itself
    // would tear down + recreate the interval and fire an immediate fetch on
    // EVERY poll — an idle page doubling its own RPC cadence.
    const accountsRef = useRef(data.accounts);
    accountsRef.current = data.accounts;
    const accountsKey = data.accounts ? 'ready' : 'none';
    useEffect(() => {
        let cancelled = false;
        const fetchBalances = async () => {
            const accounts = accountsRef.current;
            if (!publicKey || !accounts) {
                setBalances({ usdc: null, sol: null });
                return;
            }
            try {
                const buyerUsdc = getAssociatedTokenAddressSync(accounts.usdcMint, publicKey, false, TOKEN_PROGRAM_ID);
                const [lamports, usdc] = await Promise.all([
                    connection.getBalance(publicKey),
                    getAccount(connection, buyerUsdc, 'confirmed', TOKEN_PROGRAM_ID).catch(() => null),
                ]);
                if (!cancelled) {
                    setBalances({ usdc: usdc ? usdc.amount : 0n, sol: BigInt(lamports) });
                }
            } catch {
                if (!cancelled) setBalances({ usdc: null, sol: null });
            }
        };
        void fetchBalances();
        const interval = window.setInterval(() => {
            if (!document.hidden) void fetchBalances();
        }, 15000);
        return () => { cancelled = true; window.clearInterval(interval); };
    }, [connection, publicKey, accountsKey]);

    // Close the currency menu on any outside click.
    useEffect(() => {
        if (!menuOpen) return;
        const onDown = (e: MouseEvent) => {
            if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) setMenuOpen(false);
        };
        document.addEventListener('mousedown', onDown);
        return () => document.removeEventListener('mousedown', onDown);
    }, [menuOpen]);

    const setQty = (tierKey: string, qty: number) => {
        if (status !== 'idle') reset();
        setQuantities((prev) => ({ ...prev, [tierKey]: Math.max(0, qty) }));
    };

    const selections = data.tiers
        .filter((t) => (quantities[t.key] ?? 0) > 0)
        .map((t) => ({ tier: t.tier, units: quantities[t.key] }));

    const totalLots = selections.reduce((n, s) => n + s.units, 0);
    const totalTokens = data.tiers.reduce(
        (n, t) => n + (quantities[t.key] ?? 0) * t.lotTokens, 0
    );
    // Sheet-aware effective prices. The regular desk mirrors quote_claim
    // (discount + state-2 boost + ratchet floor + the tier-scaling rule that
    // keeps clamped tiers strictly ordered big>med>sml). The alt desk has
    // none of that: it is a fixed-terms sheet priced strictly below live by
    // construction (NO ratchet floor, NO bonus, NO above-spot gate), so its
    // effective price is the raw discounted quote.
    const sheet = useMemo(() => {
        if (data.altActive) {
            if (data.livePrice === null || data.livePrice <= 0n) return null;
            const out: Record<string, bigint> = {};
            for (const t of data.tiers) {
                out[t.key] = quoteDiscounted(data.livePrice, t.discountBps, 0, 3);
            }
            return out;
        }
        return quoteSheetEffective(data.livePrice, data.floorBasis, data.marketState,
            data.tiers.map((t) => ({ key: t.key, discountTenths: t.discountBps, bonusTenths: t.bonusBps })));
    }, [data.livePrice, data.floorBasis, data.marketState, data.tiers, data.altActive]);
    const tierPrice = (t: OfferTierData): bigint | null => sheet?.[t.key] ?? null;
    const estCostRaw = data.tiers.reduce(
        (sum, t) => sum + quoteCostRaw(tierPrice(t) ?? 0n, t.lotTier, quantities[t.key] ?? 0, data.afhoDecimals),
        0n,
    );

    const priceKnown = data.livePrice !== null && data.livePrice > 0n;
    const solPriceKnown = data.solPrice !== null && data.solPrice > 0n;
    // Exact SOL charge mirror: the on-chain offer_claim_sol handler solves
    // its wSOL input from the pool's LIVE reserves (spot + the trade's own
    // price impact), so the estimate that matches the charge does the same.
    // Falls back to the spot-ratio estimate while reserves load; a null
    // solve with known reserves means the pool's USDC side cannot cover the
    // order — the claim would revert on-chain (InsufficientPoolLiquidity).
    const solCharge = (costRaw: bigint): bigint | null =>
        lamportsForCostExact(costRaw, data.solPoolReserves);
    const solPoolShort =
        currency === 'sol' && solPriceKnown && totalLots > 0 &&
        data.solPoolReserves !== null && solCharge(estCostRaw) === null;
    // Ratchet / at-or-above-spot / floor-blocks-all are regular-desk-only
    // gates. The alt desk has no ratchet floor and every alt tier prices
    // strictly below live, so none of these can ever apply to it.
    const ratchet = !data.altActive && priceKnown && data.tiers.some(
        (t) => (quantities[t.key] ?? 0) > 0 &&
            tierPrice(t) !== null && ratchetActive(data.livePrice as bigint, t.discountBps, t.bonusBps, data.floorBasis, data.marketState)
    );
    // Within-0.5%-of-spot (or at/above it): the effective price (floor-held,
    // with only the bonus's own depth allowed below the floor at night —
    // state 2 only) carries less than the minimum REAL discount
    // — mirrored 1:1 with quote_claim's FloorHeldAtSpot revert (50bps
    // minimum), which enforces this on-chain. A near-spot-priced,
    // vesting-locked bond is strictly dominated by buying on the pool, and
    // fills slow the floor's decay (demand keep in calc_completed_offers),
    // so gating these accelerates the return to real discounts.
    const atOrAboveSpot = !data.altActive && priceKnown && data.tiers.some(
        (t) => (quantities[t.key] ?? 0) > 0 &&
            !meetsMinRealDiscount(data.livePrice as bigint, tierPrice(t) ?? 0n)
    );
    // Desk dark by floor: the market window is open and tonight's sheet is
    // live, but EVERY tier is within 0.5% of spot or above it (the ratchet
    // floor holds the whole desk) — the claim would revert FloorHeldAtSpot
    // on-chain. Surfaced BEFORE the buyer tries to add anything to the cart.
    const floorBlocksAll = !data.altActive && priceKnown && data.tiers.length > 0 && data.tiers.every(
        (t) => !meetsMinRealDiscount(data.livePrice as bigint, tierPrice(t) ?? 0n)
    );
    // The alt window is its own open desk: `data.deskOpen` is the regular
    // night-sheet flag (false in state 3), so every buy/banner gate below
    // treats a live alt window as an open desk too.
    const deskOpen = data.deskOpen || data.altActive;
    const deskBlocked = !deskOpen || floorBlocksAll;

    // Per-lot cost in the SELECTED currency. SOL uses the spot-ratio estimate
    // here (it only sizes the %-of-balance quick-fill); the exact charge
    // mirror — spot + the order's own price impact — is applied to the whole
    // order in displayCost / handleBuy / useOfferClaim below.
    const costPerLot = (t: OfferTierData): bigint => {
        const c = quoteCostRaw(tierPrice(t) ?? 0n, t.lotTier, 1, data.afhoDecimals);
        return currency === 'usdc' ? c : lamportsForCost(c, data.solPrice ?? 0n);
    };

    const solReady = data.solAccounts !== null && solPriceKnown;

    const canBuy = connected && deskOpen && totalLots > 0 && priceKnown &&
        status !== 'pending' && !atOrAboveSpot && !priceStale &&
        (currency === 'usdc' ? data.accounts !== null : solReady && !solPoolShort);

    const buyLabel = !connected
        ? 'Connect wallet to buy'
        : !deskOpen
            ? 'Desk closed'
            : floorBlocksAll
                ? 'Desk closed: floor at spot'
                : atOrAboveSpot
                    ? 'Selected offers under 0.5% off'
                    : priceStale
                        ? 'Live price stale — waiting for refresh'
                        : solPoolShort
                            ? 'SOL pool too thin'
                            : status === 'pending'
                                ? 'Claiming…'
                                : 'Buy selected offers';

    const handleBuy = async () => {
        const ok = await claim(selections, estCostRaw, {
            currency,
            solPrice: data.solPrice,
            solPoolReserves: data.solPoolReserves,
            claimLookupTable: data.claimLookupTable,
        });
        if (ok) setQuantities({ big: 0, med: 0, sml: 0 });
        setTimeout(data.refresh, 2000);
    };

    const selectCurrency = (next: ClaimCurrency) => {
        if (status !== 'idle') reset();
        setCurrency(next);
        setMenuOpen(false);
    };

    // Quick-fill: pick a combination of whole lots whose total cost is the
    // largest amount not exceeding pct% of the selected wallet balance. This is
    // a small bounded knapsack (3 tiers), so a brute-force search is exact and
    // fast enough for a button click.
    const applyPercent = (pct: number) => {
        if (!priceKnown) return;
        const bal = currency === 'usdc' ? balances.usdc : balances.sol;
        if (bal === null || bal <= 0n) return;
        const target = (bal * BigInt(pct)) / 100n;

        const byKey = (key: string) => data.tiers.find((t) => t.key === key);
        const big = byKey('big');
        const med = byKey('med');
        const sml = byKey('sml');
        const bigCost = big ? costPerLot(big) : 0n;
        const medCost = med ? costPerLot(med) : 0n;
        const smlCost = sml ? costPerLot(sml) : 0n;

        const maxCount = (tier: OfferTierData | undefined, perLot: bigint): number => {
            if (!tier || perLot <= 0n) return 0;
            return Math.min(tier.remaining, Number(target / perLot));
        };

        const bigMax = maxCount(big, bigCost);
        const medMax = maxCount(med, medCost);

        let bestCost = 0n;
        const best: Record<string, number> = { big: 0, med: 0, sml: 0 };

        for (let b = 0; b <= bigMax; b++) {
            const costB = bigCost * BigInt(b);
            if (costB > target) break;
            for (let m = 0; m <= medMax; m++) {
                const costBM = costB + medCost * BigInt(m);
                if (costBM > target) break;
                const remaining = target - costBM;
                const smlMax = sml ? Math.min(sml.remaining, Number(remaining / smlCost)) : 0;
                // For this (big, med) pair the best sml count is the most that
                // still fits; scanning a couple below catches near-target ties
                // without noticeably increasing work.
                for (let s = Math.max(0, smlMax - 1); s <= smlMax; s++) {
                    const cost = costBM + smlCost * BigInt(s);
                    if (cost <= target && cost > bestCost) {
                        bestCost = cost;
                        best.big = b;
                        best.med = m;
                        best.sml = s;
                    }
                }
            }
        }

        if (status !== 'idle') reset();
        setQuantities(best);
    };

    const closedMessage = deskMessage(data.marketState, data.sheetStale, data.offersLive, data.altActive);

    // Tiles exist inside the desk's night window with tonight's sheet posted,
    // OR while the alt window is live (state 3 + today's alt sheet — tiers
    // then come from the alt sheet via useAmmData's display override).
    // Market open / a stale sheet = desk closed → tiles hidden. Sold out
    // during the night = tiles stay up, greyed via each tier's sold-out
    // state (remaining reads 0 / N).
    const night = data.marketState === 1 || data.marketState === 2 || data.altActive;
    const showTiles =
        night &&
        (data.altActive || (data.marketState !== 3 && !data.sheetStale)) &&
        data.tiers.length > 0;

    const displayCost = totalLots > 0 && priceKnown
        ? currency === 'usdc'
            ? `≈ ${formatUsdc(estCostRaw, data.usdcDecimals)}`
            : !solPriceKnown
                ? '—'
                : solCharge(estCostRaw) !== null
                    ? `≈ ${formatSol(solCharge(estCostRaw) as bigint)}`
                    : 'SOL pool too thin'
        : '—';

    const balanceAmount = currency === 'usdc'
        ? balances.usdc !== null ? formatUsdc(balances.usdc, data.usdcDecimals) : null
        : balances.sol !== null ? formatSol(balances.sol) : null;

    const livePxStr = data.livePrice !== null && data.livePrice > 0n
        ? (() => {
            const px = pricePerToken(data.livePrice);
            return px >= 1 ? px.toLocaleString('en-US', { maximumFractionDigits: 4 }) : px.toPrecision(4);
        })()
        : null;

    return (
        <section className="offer-desk">
            {status === 'success' && txSig && (
                <div className="desk-banner success glass-pane desk-banner--sticky">
                    <span>
                        Claim submitted — AFHO is vesting in your stake positions.
                    </span>
                    <span className="desk-banner-links">
                        {(() => {
                            const urls = explorerUrls(txSig, deployment?.cluster);
                            return (
                                <>
                                    <a className="tx-explorer-button tx-explorer-button--solscan" href={urls.solscan} target="_blank" rel="noreferrer">
                                        <SolscanMark size={14} />
                                        <span>View on Solscan</span>
                                    </a>
                                    <a className="tx-explorer-button tx-explorer-button--solana" href={urls.solana} target="_blank" rel="noreferrer">
                                        <SolanaMark size={14} />
                                        <span>Solana Explorer</span>
                                    </a>
                                </>
                            );
                        })()}
                    </span>
                </div>
            )}
            {data.error && <div ref={rpcErrorRef} className="desk-banner error glass-pane">RPC error: {data.error} — showing last known state</div>}
            {data.loading && !data.tiers.length && <div className="desk-banner glass-pane">Loading offer sheet…</div>}

            {!data.loading && !deskOpen && closedMessage && (
                <div className="desk-banner closed glass-pane">{closedMessage}</div>
            )}
            {!data.loading && deskOpen && floorBlocksAll && (
                <div className="desk-banner paused glass-pane" role="alert">
                    Desk paused.. prices too low to offer bonds.
                    Every tier currently priced at or above the live DEX
                    price. Sales resume if market AFHO price raises
                </div>
            )}
            {deskOpen && !floorBlocksAll && priceStale && (
                <div className="desk-banner paused glass-pane" role="status">
                    Desk paused..  live price is stale; buys resume on the next price refresh.
                </div>
            )}
            {deskOpen && !floorBlocksAll && !priceStale && (
                <div className="desk-banner open glass-pane">
                    Desk open.. purchased AFHO goes straight into a vesting stake position, not your wallet.
                </div>
            )}

            {showTiles && (
                <SizedOffers
                    tiers={data.tiers}
                    quantities={quantities}
                    livePrice={data.livePrice}
                    marketState={data.marketState}
                    currency={currency}
                    solPrice={data.solPrice}
                    solPoolReserves={data.solPoolReserves}
                    afhoDecimals={data.afhoDecimals}
                    sheet={sheet}
                    disabled={!deskOpen || floorBlocksAll || status === 'pending'}
                    priceStale={priceStale}
                    onQtyChange={setQty}
                />
            )}

            <div
                className="order-bar glass-pane"
                data-order={totalLots > 0 ? 'active' : 'idle'}
                data-desk={deskBlocked ? 'closed' : 'open'}
                style={{ '--order-excite': String(Math.min(1 + totalLots * 0.18, 2.6)) } as React.CSSProperties}
            >
                <div className="order-total">
                    {deskBlocked && (
                        <span className="order-desk-closed" role="status">
                            {!deskOpen
                                ? 'Desk closed.. sales open after the next close→open roll'
                                : 'Desk closed.. buyback floor at or above the live pool price; sales resume once it decays below spot'}
                        </span>
                    )}
                    <span className="order-total-label"><GlitchText text="Total order size (approx.)" variant="light" split="letter" step={0.3} /></span>
                    {/* {currency == "sol" && (<div>
                        <p className="sol-warn">Sol offers fails simulation in some wallets</p>< p className="sol-warn">and may require multiple transactions</p></div>)} */}
                    <div className="order-total-line">
                        <strong><FlashNumber value={displayCost} /></strong>
                        <div className="currency-picker" ref={pickerRef}>
                            <button
                                type="button"
                                className="currency-select"
                                onClick={() => setMenuOpen((o) => !o)}
                                aria-haspopup="listbox"
                                aria-expanded={menuOpen}
                            >
                                {currency === 'usdc' ? 'USDC' : 'SOL'}
                                <span className="currency-caret">▾</span>
                            </button>
                            {menuOpen && (
                                <div className="currency-menu" role="listbox">
                                    <button
                                        type="button"
                                        className="currency-option"
                                        role="option"
                                        aria-selected={currency === 'usdc'}
                                        onClick={() => selectCurrency('usdc')}
                                    >
                                        USDC
                                        {currency === 'usdc' && <span className="hint">selected</span>}
                                    </button>
                                    <button
                                        type="button"
                                        className="currency-option"
                                        role="option"
                                        aria-selected={currency === 'sol'}
                                        disabled={!data.solAccounts}
                                        title={data.solAccounts ? undefined : 'SOL payments need the SOL/USDC pool pinned (anchor run set-sol-usdc-pool)'}
                                        onClick={() => selectCurrency('sol')}
                                    >
                                        SOL
                                        {currency === 'sol'
                                            ? <span className="hint">selected</span>
                                            : !data.solAccounts && <span className="hint">pool not pinned</span>}
                                    </button>
                                </div>
                            )}
                        </div>
                    </div>
                    <div className="pct-row">
                        {PERCENT_STEPS.map((pct) => (
                            <button
                                key={pct}
                                type="button"
                                className="pct-btn"
                                disabled={!priceKnown || (currency === 'usdc' ? balances.usdc === null || balances.usdc <= 0n : balances.sol === null || balances.sol <= 0n)}
                                onClick={() => applyPercent(pct)}
                            >
                                {pct === 100 ? 'MAX' : `${pct}%`}
                            </button>
                        ))}
                        {balanceAmount !== null && (
                            <span className="order-balance">
                                Balance: <FlashNumber value={balanceAmount} /> {currency === 'usdc' ? 'USDC' : 'SOL'}
                            </span>
                        )}
                    </div>
                    {totalLots > 0 && (
                        <span className="order-total-sub">
                            <FlashNumber value={formatTokens(totalTokens)} /> AFHO · <FlashNumber value={totalLots} /> lot{totalLots !== 1 ? 's' : ''}
                            {atOrAboveSpot
                                ? ' · buyback floor ≥ spot — sales paused until it decays below spot'
                                : ratchet
                                    ? ' · buyback-floor ratchet active (still below spot)'
                                    : ''}
                        </span>
                    )}
                    {priceKnown && (
                        <span className="order-live-price">
                            Live AFHO ≈ ${livePxStr !== null ? <FlashNumber value={livePxStr} /> : '—'}{' '}
                            · source: {data.accounts ? (data.afhoPriceIsTwap ? 'pool (TWAP)' : 'pool (spot)') : 'oracle'}
                            {data.updatedAt && (
                                <> · updated <FlashNumber
                                    value={data.updatedAt}
                                    render={(v) => Math.max(0, Math.round((Date.now() - new Date(v as string).getTime()) / 1000))}
                                />s ago</>
                            )}
                            {priceStale && ' · stale — buy paused until the next price refresh'}
                        </span>
                    )}
                </div>
                <button
                    type="button"
                    className={`buy-button${!connected ? ' needs-wallet' : ''}${totalLots > 0 ? ' has-order' : ''}${canBuy ? ' ready' : ''}`}
                    onClick={() => {
                        if (!connected) {
                            setVisible(true);
                            return;
                        }
                        void handleBuy();
                    }}
                    disabled={connected && !canBuy}
                >
                    <WalletMark size={18} />
                    <GlitchText text={buyLabel} variant="light" split="letter" step={0.3} />
                </button>
            </div>
            <p className="order-note">
                <GlitchText
                    text="Estimate only — the live oracle price at claim time sets the final cost. Payment splits 80% buybacks / 10% dip reserve / 10% staker rewards."
                    variant="light"
                    split="word"
                    step={0.12}
                />
                {currency === 'sol' && ' SOL payments swap to USDC at claim (you cover the 0.25% pool fee).'}
            </p>

            {
                status === 'error' && claimError && (
                    <div ref={claimErrorRef} className="desk-banner error glass-pane">Claim failed: {claimError}</div>
                )
            }
        </section >
    );
}
