import { useCallback } from 'react';
import { PublicKey } from '@solana/web3.js';
import { useChainData } from '../context/useChainData';

interface MarketStatusData {
    state: number;
    timestamp: number;
    tradingDay: number;
}

interface UseMarketStatusReturn {
    data: MarketStatusData | null;
    loading: boolean;
    error: string | null;
    refresh: () => void;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function useMarketStatus(_marketStatusPda?: string | PublicKey): UseMarketStatusReturn {
    const { marketStatus, marketStatusLoading, refresh } = useChainData();

    const doRefresh = useCallback(() => {
        void refresh('marketStatus');
    }, [refresh]);

    return {
        data: marketStatus,
        loading: marketStatusLoading,
        error: marketStatusLoading ? null : marketStatus ? null : 'Market status unavailable',
        refresh: doRefresh,
    };
}
