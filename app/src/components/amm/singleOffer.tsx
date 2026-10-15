import { useState } from 'react';
import { formatSol, formatTokens, lamportsForCost, lamportsForCostExact, meetsMinRealDiscount, pricePerToken, quoteCostRaw, quoteDiscounted } from '../../hooks/amm/offerMath.ts';
import type { OfferTierData } from '../../hooks/amm/useAmmData.ts';
import FlashNumber from '../FlashNumber.tsx';

interface SingleOfferProps {
    offer: OfferTierData;
    qty: number;
    livePrice: bigint | null;
    marketState: number | null;
    currency: 'usdc' | 'sol';
    solPrice: bigint | null;
    solPoolReserves: { wsolRaw: bigint; usdcRaw: bigint } | null;
    afhoDecimals: number;
    /** Sheet-aware effective price for THIS tier (quoteSheetEffective) — the
     *  claim-consistent quote including the ratchet tier scaling. */
    sheet: Record<string, bigint> | null;
    disabled: boolean;
    /** Live-price snapshot too old to quote against — the tile shows its
     *  stale note and freezes the steppers until the next refresh lands. */
    priceStale?: boolean;
    onQtyChange: (qty: number) => void;
}

export default function SingleOffer({
    offer,
    qty,
    livePrice,
    marketState,
    currency,
    solPrice,
    solPoolReserves,
    afhoDecimals,
    sheet,
    disabled,
    priceStale,
    onQtyChange,
}: SingleOfferProps) {
    const soldOut = offer.remaining === 0;
    const selected = qty > 0;

    // Local draft while the quantity input is focused: typing lands in the
    // draft, and the committed quantity updates on blur / Enter, clamped to
    // the tier's remaining lots. Clicking +/- blurs the input first, so the
    // buttons always operate on the committed value.
    const [draft, setDraft] = useState<string | null>(null);
    const commitDraft = () => {
        if (draft === null) return;
        setDraft(null);
        const parsed = Number.parseInt(draft, 10);
        if (Number.isNaN(parsed)) return; // revert to the committed qty
        onQtyChange(Math.min(Math.max(parsed, 0), offer.remaining));
    };

    // Approximate per-lot price in the SELECTED payment currency — the final
    // price is fixed on-chain at claim time. USDC pays the discounted spot
    // directly; SOL mirrors the claim handler's own charge solve
    // (cpmm_swap_input_for_out against the SOL/USDC pool's live reserves —
    // spot + the trade's own price impact), falling back to the spot ratio
    // while reserves load. If even one lot can't be served by the pool's
    // USDC side, the claim would revert on-chain — say so instead of quoting
    // a phantom number.
    let perLot: string | null = null;
    let perLotUnit = 'USDC';
    let perLotNote: string | null = null;
    if (livePrice !== null && livePrice > 0n) {
        const eff = sheet?.[offer.key] ?? null;
        if (currency === 'sol' && solPrice !== null && solPrice > 0n) {
            const usdcRaw = quoteCostRaw(eff ?? 0n, offer.lotTier, 1, afhoDecimals);
            const exact = lamportsForCostExact(usdcRaw, solPoolReserves);
            if (exact !== null) {
                perLot = formatSol(exact);
            } else if (solPoolReserves !== null) {
                perLotNote = 'SOL pool too thin';
            } else {
                perLot = formatSol(lamportsForCost(usdcRaw, solPrice));
            }
            perLotUnit = 'SOL';
        } else if (currency === 'usdc' && eff !== null) {
            const usd = pricePerToken(eff) * offer.lotTokens;
            perLot = usd >= 1
                ? usd.toLocaleString('en-US', { maximumFractionDigits: 2 })
                : usd.toPrecision(3);
        }
    }

    const excite = qty > 0 ? Math.min(1 + (qty - 1) * 0.35, 2.4) : 1;

    // Real delivered discount vs live spot, shown in the header pill (the
    // listed "up to" ceiling moves to its own muted line under the header)
    // — outside the bonus window the buyback floor can shrink the actual %.
    // Tones (mirroring quote_claim):
    //   full discount, no bonus       → green  (same as the "up to" pill)
    //   full discount + late-nite     → slow green↔blue pulse
    //   bonus only (floor would bind) → blue   (bonus is the live discount)
    //   ratchet holds, no bonus       → muted  (partial discount)
    const eff = sheet?.[offer.key] ?? null;
    const realPct = eff !== null && livePrice !== null
        ? Math.max(0, (1 - Number(eff) / Number(livePrice)) * 100)
        : null;
    // "Maximum discount applied": the effective price carries the tier's
    // full listed discount — i.e. it equals the discounted quote itself,
    // with no floor uplift. The bonus only exists in state 2 (closed
    // session), where it also deepens the quote.
    const fullDiscount = eff !== null && livePrice !== null && livePrice > 0n
        ? eff <= quoteDiscounted(livePrice, offer.discountBps, offer.bonusBps, marketState)
        : false;
    // The late-nite bonus is a CLOSED-session (state 2) feature only.
    // Enforce that invariant at the render boundary too: even if a stray
    // non-zero bonusBps ever arrived in any other state, it could never
    // paint the bonus pill, tones, or the floor-held note. (Belt-and-
    // braces on top of useAmmData's state-2 gating.)
    const bonusApplied = offer.bonusBps > 0 && marketState === 2;
    // Floor-held tier: the effective price sits within 0.5% of live spot (or
    // at/above it) — this tier is not buyable (on-chain quote_claim reverts
    // FloorHeldAtSpot under the minimum-real-discount gate). Surface it on
    // the tile BEFORE the buyer adds it to the cart.
    const floorHeld = eff !== null && livePrice !== null && livePrice > 0n && !meetsMinRealDiscount(livePrice, eff) && !soldOut;
    const priceTone = perLot === null || realPct === null
        ? undefined
        : fullDiscount
            // In state 2 the bonus genuinely deepens the discount → pulse.
            // bonusApplied already embeds the state-2 gate, so it is only
            // ever true in the closed session — never in state 1.
            ? bonusApplied
                ? 'offer-price--full-bonus'
                : 'offer-price--full'
            : bonusApplied
                ? 'offer-price--bonus-only'
                : 'offer-price--reduced';

    return (
        <article
            className={`offer-card glass-pane ${selected ? 'selected' : ''} ${soldOut ? 'sold-out' : ''} ${floorHeld ? 'floor-held' : ''} ${priceStale && !soldOut ? 'price-stale' : ''}`}
            data-tier={offer.tier}
            style={{
                '--tier-excite': String(excite),
                '--glitch-delay': `${(offer.tier * 1.35 + 0.4).toFixed(2)}s`,
            } as React.CSSProperties}
        >
            <header className="offer-card-header">
                <h3>{offer.label}</h3>
                <span className="offer-discount">
                    {realPct !== null
                        ? <><FlashNumber value={realPct.toFixed(1)} />% off</>
                        : <>up to <FlashNumber value={offer.discountBps / 10} />% off</>}
                </span>
            </header>
            {bonusApplied && (
                <div className="offer-bonus-row">
                    <span className="offer-discount offer-discount--bonus">+0.5% late nite bonus</span>
                </div>
            )}

            <div className="offer-lot-size">
                {formatTokens(offer.lotTokens)} <span>AFHO / lot</span>
            </div>

            <dl className="offer-facts">
                <div>
                    <dt>Vesting</dt>
                    <dd><FlashNumber value={offer.vestingDays} /> trading days</dd>
                </div>
                <div>
                    <dt>Remaining</dt>
                    <dd><FlashNumber value={offer.remaining} /> / {offer.totalOffered} lots</dd>
                </div>
                <div>
                    <dt>≈ Price / lot</dt>
                    <dd className={priceTone}>
                        {perLot !== null ? (<><FlashNumber value={perLot} /> {perLotUnit}</>) : perLotNote ?? '—'}
                    </dd>
                </div>
                {realPct !== null && (
                    <div className="offer-up-to-row">
                        <p>up to <FlashNumber value={offer.discountBps / 10} />% off</p>
                    </div>
                )}

            </dl>

            <div className="qty-stepper" aria-label={`${offer.label} quantity`}>
                <button
                    type="button"
                    onClick={() => onQtyChange(qty - 1)}
                    disabled={disabled || floorHeld || qty === 0}
                    aria-label="decrease"
                >
                    −
                </button>
                <input
                    type="number"
                    className="qty-input"
                    min={0}
                    max={offer.remaining}
                    value={draft ?? qty}
                    onChange={(e) => setDraft(e.target.value)}
                    onBlur={commitDraft}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur();
                    }}
                    disabled={disabled || floorHeld || soldOut}
                    aria-label={`${offer.label} quantity input`}
                />
                <button
                    type="button"
                    onClick={() => onQtyChange(qty + 1)}
                    disabled={disabled || floorHeld || soldOut || qty >= offer.remaining}
                    aria-label="increase"
                >
                    +
                </button>
            </div>
            {soldOut && <p className="offer-soldout">Sold out for today</p>}
            {priceStale && !soldOut && (
                <p className="offer-floor-held" role="status">
                    Live price stale — buy paused until the next refresh
                </p>
            )}
            {floorHeld && (
                <p className="offer-floor-held" role="status">
                    Floor held: less than 0.5% under spot{bonusApplied ? ' (late-nite bonus applied)' : ''}
                </p>
            )}
        </article>
    );
}
