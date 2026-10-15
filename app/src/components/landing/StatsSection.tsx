import { PoolStats } from '../PoolStats';
import { SupplyStakeChart } from './SupplyStakeChart';
import { PublicKey } from '@solana/web3.js';

interface StatsSectionProps {
    mint: PublicKey;
}

export function StatsSection({ mint }: StatsSectionProps) {
    return (
        <section className="stats-section">
            <div className="landing-section-inner">
                <PoolStats mint={mint} />
                <SupplyStakeChart />
            </div>
        </section>
    );
}
