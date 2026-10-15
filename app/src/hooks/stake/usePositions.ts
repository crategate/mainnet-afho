import { useCallback, useEffect, useRef } from 'react';
import { useWallet, useConnection } from '@solana/wallet-adapter-react';
import { PublicKey } from '@solana/web3.js';
import { useQuery } from '@tanstack/react-query';
import { useChainData } from '../../context/useChainData';
import {
    decodeStakePosition,
    derivePoolPda,
    derivePositionPda,
    deriveUserIndexPda,
} from '../../context/chainDataHelpers';
import { STAKING_PROGRAM_ID, useStakingProgram } from '../../anchor/setup';

export interface Position {
    pda: PublicKey;
    index: number;
    amount: number;
    entryTradingDay: number;
    lastClaimTimestamp: number;
    daysToUnlock: number;
    currentWeight: string;
    rewardDebt: string;
    // Freeze feature — decodeStakePosition defaults both to 0 on pre-freeze
    // accounts, so they are always present.
    frozenUntilDay: number;
    freezeBonusBps: number;
}

type AccountNamespace = Record<
    string,
    { fetchNullable(key: PublicKey): Promise<unknown> } | undefined
>;

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function usePositions(_mint?: PublicKey | null) {
    const { publicKey } = useWallet();
    const { connection } = useConnection();
    const program = useStakingProgram();
    const { deployment } = useChainData();
    const mint = deployment?.mintKey;

    const fetchPositions = useCallback(async (): Promise<Position[]> => {
        if (!publicKey || !program || !mint) return [];

        const poolPda = derivePoolPda(mint);
        const userIndexPda = deriveUserIndexPda(publicKey);
        const userIndex = (await (program.account as AccountNamespace).userStakeIndex?.fetchNullable(
            userIndexPda,
        )) as { nextIndex: { toString(): string } } | null | undefined;
        const nextIndex = userIndex ? Number(userIndex.nextIndex) : 0;
        if (nextIndex === 0) return [];

        const pdas: PublicKey[] = [];
        for (let i = 0; i < nextIndex; i++) {
            pdas.push(derivePositionPda(poolPda, publicKey, i));
        }

        const infos = await connection.getMultipleAccountsInfo(pdas, 'confirmed');
        const fetched: Position[] = [];

        for (let i = 0; i < infos.length; i++) {
            const info = infos[i];
            if (!info) continue;
            try {
                const decoded = decodeStakePosition(info.data);
                if (decoded) {
                    fetched.push({
                        pda: pdas[i],
                        index: i,
                        amount: Number(decoded.amount),
                        entryTradingDay: Number(decoded.entryTradingDay),
                        lastClaimTimestamp: Number(decoded.lastClaimTimestamp),
                        daysToUnlock: decoded.daysToUnlock ?? 0,
                        currentWeight: decoded.currentWeight
                            ? decoded.currentWeight.toString()
                            : decoded.amount.toString(),
                        rewardDebt: decoded.rewardDebt ? decoded.rewardDebt.toString() : '0',
                        frozenUntilDay: decoded.frozenUntilDay ?? 0,
                        freezeBonusBps: decoded.freezeBonusBps ?? 0,
                    });
                }
            } catch (e) {
                console.warn(`Skipping position ${i}: stale account data (pre-upgrade layout)`, e);
            }
        }
        return fetched;
    }, [publicKey, program, mint, connection]);

    const query = useQuery({
        queryKey: ['positions', publicKey?.toBase58() ?? '', mint?.toBase58() ?? ''],
        queryFn: fetchPositions,
        enabled: !!publicKey && !!program && !!mint,
        staleTime: 15000,
        refetchOnWindowFocus: false,
        retry: (failureCount, error) => {
            const msg = error instanceof Error ? error.message : String(error);
            return /429|rate/i.test(msg) ? failureCount < 3 : failureCount < 1;
        },
        retryDelay: (attemptIndex) => Math.min(1000 * 2 ** attemptIndex, 30000),
    });

    // Stable subscription handle: `query` changes identity on every fetch, so
    // putting it in the effect deps churned the listeners (unsubscribe +
    // resubscribe per update, plus StrictMode double-subscription) — events
    // landing in those gaps were lost. Register once per wallet/connection and
    // route events through a ref instead.
    const refetchRef = useRef<() => Promise<unknown>>(async () => {});
    refetchRef.current = () => query.refetch();

    useEffect(() => {
        if (!connection || !publicKey) return;

        // One stake fires BOTH the user-index write (next_index++) and the new
        // position account, so debounce the refetch briefly to collapse them.
        let lastRefetchAt = 0;
        const refetchSoon = () => {
            const now = Date.now();
            if (now - lastRefetchAt < 400) return;
            lastRefetchAt = now;
            void refetchRef.current();
        };

        const userIndexPda = deriveUserIndexPda(publicKey);
        const subs: number[] = [
            connection.onAccountChange(userIndexPda, refetchSoon, 'confirmed'),
            connection.onProgramAccountChange(
                STAKING_PROGRAM_ID,
                refetchSoon,
                'confirmed',
                [{ memcmp: { offset: 8, bytes: publicKey.toBase58() } }],
            ),
        ];

        return () => {
            void connection.removeAccountChangeListener(subs[0]);
            void connection.removeProgramAccountChangeListener(subs[1]);
        };
    }, [connection, publicKey]);

    return {
        positions: query.data ?? [],
        loading: query.isLoading,
        refresh: query.refetch,
    };
}
