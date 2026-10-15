import { createContext } from 'react';
import type { ResolvedDeployment } from '../config';
import type {
    AmmStateData,
    LivePriceData,
    MarketStatusData,
    OfferListData,
    StakePoolData,
} from './chainDataHelpers';

export type RefreshKey = 'deployment' | 'marketStatus' | 'pool' | 'amm' | 'livePrice';

export interface ChainDataContextValue {
    deployment: ResolvedDeployment | null;
    deploymentLoading: boolean;
    marketStatus: MarketStatusData | null;
    marketStatusLoading: boolean;
    pool: StakePoolData | null;
    poolLoading: boolean;
    ammState: AmmStateData | null;
    ammStateLoading: boolean;
    offerList: OfferListData | null;
    offerListLoading: boolean;
    /** Alt desk sheet — same layout as offerList, separate PDA. Null while
     *  the account doesn't exist yet (created lazily by the first
     *  make_alt_offers). */
    altList: OfferListData | null;
    livePrice: LivePriceData;
    livePriceLoading: boolean;
    /** Last successful live-price fetch (ms epoch) — 0/null when never fetched. */
    livePriceUpdatedAt: number | null;
    /** True while the shared snapshot query has a fetch in flight (initial,
    *   polled, WS-invalidated, or the visibility-return recovery fetch). */
    snapshotFetching: boolean;
    refresh: (key: RefreshKey) => Promise<void>;
}

export const ChainDataContext = createContext<ChainDataContextValue | null>(null);
