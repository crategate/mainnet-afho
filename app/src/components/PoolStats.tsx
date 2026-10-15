import { usePoolStats } from '../hooks/usePoolStats';
import { Snowflake } from './Snowflake';
import { useTokenBalance } from '../hooks/useTokenBalance';
import { useChainData } from '../context/useChainData';
import { AMM_PROGRAM_ID, deriveAmmStatePda } from '../context/chainDataHelpers';
import { PublicKey } from '@solana/web3.js';
import { useMemo } from 'react';

/* Stat tiles: one or two directions each, with two of them wandering
   between corners on their own slow clocks */
const SHADOW_VARIANTS = ['shadow-corner-tl', 'shadow-wander-a', 'shadow-under', 'shadow-wander-b', 'shadow-corner-br'];

interface PoolStatsProps {
    mint: PublicKey;
}

export function PoolStats({ mint }: PoolStatsProps) {
    const { stats, loading } = usePoolStats(mint);
    // Bond desk vault: the AMM's AFHO vault (ATA of the amm_state PDA) — the
    // token stock the offer desk sells from and dex buybacks feed into. Live
    // via an onAccountChange subscription, so buyback fills tick it up.
    const { deployment } = useChainData();
    const ammProgram = useMemo(
        () => (deployment?.ammProgram ? new PublicKey(deployment.ammProgram) : AMM_PROGRAM_ID),
        [deployment?.ammProgram],
    );
    const ammStatePda = useMemo(() => deriveAmmStatePda(mint, ammProgram), [mint, ammProgram]);
    const { balance: vaultBalance } = useTokenBalance(mint, ammStatePda, 9, true);

    if (loading || !stats) {
        return <div className="pool-stats loading">Loading on-chain stats…</div>;
    }

    const availableSupply = stats.totalSupply - (vaultBalance ?? 0);
    const pctStaked = availableSupply > 0
        ? ((stats.totalStaked / availableSupply) * 100).toFixed(2)
        : '0.00';

    const fmt = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 2 });

    const STAT_ITEMS = [
        { label: 'Total Staked', value: fmt(Math.trunc(stats.totalStaked)) },
        { label: 'Staked / available', value: `${pctStaked}%` },
        {
            label: <>Frozen <Snowflake /></>,
            value: stats.frozen > 0
                ? `${fmt(Math.trunc(stats.frozen))} (${((stats.frozen / stats.totalStaked) * 100).toFixed(1)}%)`
                : '0',
        },
        { label: 'Stakers', value: stats.userCount.toString() },
        { label: 'Bond Desk Vault', value: vaultBalance !== null ? fmt(Math.trunc(vaultBalance)) : '—' },
        { label: 'Total Supply', value: `1B` },
    ];

    return (
        <div className="pool-stats">
            {STAT_ITEMS.map((item, index) => (
                <div
                    key={index}
                    className={`stat neon-shadow glass-pane ${SHADOW_VARIANTS[index % SHADOW_VARIANTS.length]} neon-glitch`}
                    style={{
                        '--glitch-delay': `${(index * 0.8).toFixed(2)}s`,
                        '--shadow-delay': `${(index * 0.7 + 0.3).toFixed(2)}s`,
                    } as React.CSSProperties}
                >
                    <span className="stat-value">{item.value}</span>
                    <span
                        className="stat-label text-glitch-light"
                        style={{ '--glitch-delay': `${(index * 0.9 + 0.2).toFixed(2)}s` } as React.CSSProperties}
                    >
                        {item.label}
                    </span>
                </div>
            ))}
        </div>
    );
};
