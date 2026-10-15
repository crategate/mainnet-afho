import { useCallback, useMemo } from 'react';
import { useConnection } from '@solana/wallet-adapter-react';
import { PublicKey, type ParsedAccountData } from '@solana/web3.js';
import { useQuery } from '@tanstack/react-query';
import { useChainData } from '../context/useChainData';
import { STAKING_PROGRAM_ID } from '../anchor/setup';
import type { StakePoolData } from './stake/usePool';

function pub(obj: Record<string, unknown> | null, ...names: string[]): PublicKey | null {
    for (const n of names) {
        const v = obj?.[n];
        if (v instanceof PublicKey) return v;
        if (typeof v === 'string') {
            try {
                return new PublicKey(v);
            } catch {
                /* ignore */
            }
        }
    }
    return null;
}

export interface PoolStats {
    totalStaked: number;
    frozen: number;
    totalSupply: number;
    vaultBalance: number;
    userCount: number;
    decimals: number;
}

const FIVE_MINUTES = 5 * 60 * 1000;

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function usePoolStats(_mint?: PublicKey | null) {
    const { connection } = useConnection();
    const { deployment, pool, poolLoading, refresh } = useChainData();
    const mint = deployment?.mintKey;

    const mintQuery = useQuery({
        queryKey: ['poolStatsMint', mint?.toBase58() ?? ''],
        queryFn: async () => {
            if (!mint) throw new Error('Mint unknown');
            const info = await connection.getParsedAccountInfo(mint, 'confirmed');
            let supply = 0;
            let decimals = 9;
            if (info.value && 'parsed' in info.value.data) {
                const parsed = (info.value.data as ParsedAccountData).parsed.info;
                supply = Number(parsed.supply);
                decimals = Number(parsed.decimals);
            }
            return { supply, decimals };
        },
        enabled: !!mint,
        staleTime: FIVE_MINUTES,
        gcTime: FIVE_MINUTES * 2,
        refetchOnWindowFocus: false,
    });

    const vaultQuery = useQuery({
        queryKey: ['poolStatsVault', pool ? pub(pool as StakePoolData, 'vault')?.toBase58() ?? '' : ''],
        queryFn: async () => {
            const vault = pool ? pub(pool as StakePoolData, 'vault') : null;
            if (!vault) throw new Error('Vault unknown');
            const info = await connection.getParsedAccountInfo(vault, 'confirmed');
            if (info.value && 'parsed' in info.value.data) {
                const parsed = (info.value.data as ParsedAccountData).parsed.info;
                return Number(parsed.tokenAmount?.amount ?? 0);
            }
            return 0;
        },
        enabled: !!pool,
        staleTime: 15000,
        refetchOnWindowFocus: false,
    });

    const userCountQuery = useQuery({
        queryKey: ['poolStatsUserCount', STAKING_PROGRAM_ID.toBase58()],
        queryFn: async () => {
            const accounts = await connection.getProgramAccounts(STAKING_PROGRAM_ID, {
                filters: [{ dataSize: 16 }], // UserStakeIndex accounts
                commitment: 'confirmed',
            });
            return accounts.length;
        },
        enabled: true,
        staleTime: FIVE_MINUTES,
        gcTime: FIVE_MINUTES * 2,
        refetchOnWindowFocus: false,
    });

    const stats = useMemo((): PoolStats | null => {
        if (!pool || !mintQuery.data) return null;
        const decimals = mintQuery.data.decimals;
        return {
            totalStaked: Number((pool as StakePoolData).totalStaked) / 10 ** decimals,
            frozen: Number((pool as StakePoolData).frozenAmount?.toString?.() ?? 0) / 10 ** decimals,
            totalSupply: mintQuery.data.supply / 10 ** decimals,
            vaultBalance: (vaultQuery.data ?? 0) / 10 ** decimals,
            userCount: userCountQuery.data ?? 0,
            decimals,
        };
    }, [pool, mintQuery.data, vaultQuery.data, userCountQuery.data]);

    const doRefresh = useCallback(() => {
        void refresh('pool');
    }, [refresh]);

    return {
        stats,
        loading: poolLoading || mintQuery.isLoading || vaultQuery.isLoading || userCountQuery.isLoading,
        refresh: doRefresh,
    };
}
