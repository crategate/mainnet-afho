import { useCallback } from 'react';
import { PublicKey } from '@solana/web3.js';
import { useChainData } from '../../context/useChainData';

export interface StakePoolData {
    totalStaked: { toString(): string };
    maxMultiplierBps: number;
    posrTaxBps: number;
    afterHoursPenaltyBps: number;
    closedPenaltyBps: number;
    haltedPenaltyBps: number;
    accruedRewardPerShare: { toString(): string };
    [key: string]: unknown;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function usePool(_mint?: PublicKey | null) {
    const { pool, poolLoading, refresh } = useChainData();

    const doRefresh = useCallback(() => {
        void refresh('pool');
    }, [refresh]);

    return { pool, loading: poolLoading, refresh: doRefresh };
}
