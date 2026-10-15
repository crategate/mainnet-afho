import { useCallback, useEffect, useState } from 'react';
import { useConnection } from '@solana/wallet-adapter-react';
import { PublicKey } from '@solana/web3.js';
import {
    getAssociatedTokenAddressSync,
    TOKEN_2022_PROGRAM_ID,
} from '@solana/spl-token';

// SPL / Token-2022 token account `amount` is a u64 LE at offset 64.
// Returned as raw base units (bigint) so fill math never loses precision —
// the human float is derived, never the other way around.
function amountFromAccountInfo(info: { data: Uint8Array }): bigint {
    const view = new DataView(info.data.buffer, info.data.byteOffset, info.data.byteLength);
    return view.getBigUint64(64, true);
}

/**
 * Live wallet token balance, driven by an `onAccountChange` subscription on
 * the associated token account (push, no polling). Fetches once on mount and
 * then updates as soon as the account changes on-chain.
 */
export function useTokenBalance(
    mint: PublicKey | null,
    owner: PublicKey | null,
    decimals = 9,
    offCurve = false,
): { balance: number | null; rawBalance: bigint | null; refresh: () => Promise<void> } {
    const { connection } = useConnection();
    const [balance, setBalance] = useState<number | null>(null);
    const [rawBalance, setRawBalance] = useState<bigint | null>(null);

    const applyAmount = useCallback(
        (info: { data: Uint8Array } | null) => {
            const raw = info ? amountFromAccountInfo(info) : 0n;
            setRawBalance(raw);
            setBalance(Number(raw) / 10 ** decimals);
        },
        [decimals],
    );

    const refresh = useCallback(async () => {
        if (!connection || !mint || !owner) {
            setBalance(null);
            setRawBalance(null);
            return;
        }
        try {
            const ata = getAssociatedTokenAddressSync(mint, owner, offCurve, TOKEN_2022_PROGRAM_ID);
            const info = await connection.getAccountInfo(ata, 'confirmed');
            applyAmount(info);
        } catch {
            applyAmount(null);
        }
    }, [connection, mint, owner, offCurve, applyAmount]);

    useEffect(() => {
        if (!connection || !mint || !owner) {
            void Promise.resolve().then(() => {
                setBalance(null);
                setRawBalance(null);
            });
            return;
        }

        const ata = getAssociatedTokenAddressSync(mint, owner, offCurve, TOKEN_2022_PROGRAM_ID);
        let cancelled = false;

        void Promise.resolve().then(async () => {
            try {
                const info = await connection.getAccountInfo(ata, 'confirmed');
                if (!cancelled) applyAmount(info);
            } catch {
                if (!cancelled) applyAmount(null);
            }
        });

        const subscriptionId = connection.onAccountChange(
            ata,
            (info) => {
                if (!cancelled && !document.hidden) {
                    applyAmount(info);
                }
            },
            'confirmed',
        );

        return () => {
            cancelled = true;
            void connection.removeAccountChangeListener(subscriptionId);
        };
    }, [connection, mint, owner, offCurve, applyAmount]);

    return { balance, rawBalance, refresh };
}
