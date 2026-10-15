import SingleOffer from './singleOffer.tsx';
import type { OfferTierData } from '../../hooks/amm/useAmmData.ts';

interface SizedOffersProps {
    tiers: OfferTierData[];
    quantities: Record<string, number>;
    livePrice: bigint | null;
    marketState: number | null;
    currency: 'usdc' | 'sol';
    solPrice: bigint | null;
    solPoolReserves: { wsolRaw: bigint; usdcRaw: bigint } | null;
    afhoDecimals: number;
    /** Sheet-aware effective prices per tier key (quoteSheetEffective) — the
     *  claim-consistent quote including the ratchet tier scaling. */
    sheet: Record<string, bigint> | null;
    disabled: boolean;
    /** True when the live-price snapshot is too old to quote a buy against —
     *  tiles show their stale note and stop accepting quantities. */
    priceStale?: boolean;
    onQtyChange: (tierKey: string, qty: number) => void;
}

export default function SizedOffers({
    tiers,
    quantities,
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
}: SizedOffersProps) {
    return (
        <div className="offer-grid">
            {tiers.map((offer) => (
                <SingleOffer
                    key={offer.key}
                    offer={offer}
                    qty={quantities[offer.key] ?? 0}
                    livePrice={livePrice}
                    marketState={marketState}
                    currency={currency}
                    solPrice={solPrice}
                    solPoolReserves={solPoolReserves}
                    afhoDecimals={afhoDecimals}
                    sheet={sheet}
                    disabled={disabled || priceStale === true}
                    priceStale={priceStale}
                    onQtyChange={(q) => onQtyChange(offer.key, q)}
                />
            ))}
        </div>
    );
}
