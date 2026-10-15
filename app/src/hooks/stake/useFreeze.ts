import { useCallback, useState } from 'react';
import { useWallet, useConnection } from '@solana/wallet-adapter-react';
import { PublicKey } from '@solana/web3.js';
import BN from 'bn.js';
import { useStakingProgram, STAKING_PROGRAM_ID, CRANK_PROGRAM_ID, AMM_PROGRAM_ID } from '../../anchor/setup';
import type { Position } from './usePositions';

// freeze(index, days): owner-only, open-only, vested positions. The metrics
// PDA (momentum scalar) is seeds-verified on-chain against pool.amm_program —
// same derivation here.
export function useFreeze(mint: PublicKey | null, marketStatusPda?: PublicKey) {
    const { publicKey } = useWallet();
    const { connection } = useConnection();
    const program = useStakingProgram();
    const [loadingIndex, setLoadingIndex] = useState<number | null>(null);

    const freeze = useCallback(async (position: Position, days: number) => {
        if (!publicKey || !program || !mint || !connection) {
            throw new Error('Wallet not connected or missing parameters');
        }
        setLoadingIndex(position.index);
        try {
            const [poolPda] = PublicKey.findProgramAddressSync(
                [Buffer.from('pool'), mint.toBuffer()],
                STAKING_PROGRAM_ID,
            );
            const [metricsPda] = PublicKey.findProgramAddressSync(
                [Buffer.from('metrics'), mint.toBuffer()],
                AMM_PROGRAM_ID,
            );
            const marketStatus = marketStatusPda ?? PublicKey.findProgramAddressSync(
                [Buffer.from('market_status')],
                CRANK_PROGRAM_ID,
            )[0];

            const signature = await program.methods
                .freeze(new BN(position.index), days)
                .accounts({
                    owner: publicKey,
                    mint,
                    pool: poolPda,
                    position: position.pda,
                    metrics: metricsPda,
                    marketStatus,
                })
                .rpc({
                    skipPreflight: false,
                    preflightCommitment: 'confirmed',
                    maxRetries: 3,
                });
            return signature;
        } finally {
            setLoadingIndex(null);
        }
    }, [publicKey, program, mint, connection, marketStatusPda]);

    return { freeze, loadingIndex };
}
