import { FeaturePage, FeatureCard, FeatureCta } from '../components/FeaturePage';
import { MultiplierCurve } from '../components/charts';

/* /locking — the Locking Rewards page. Sells the staking mechanic: log-ramp
 * multiplier to 3x, two revenue taps (bond proceeds + exit penalties), and
 * the market-state cost of impatience. */

export default function Locking() {
    return (
        <FeaturePage
            eyebrow="Locking Rewards"
            headline="Impatience is a fee. Patience is a yield."
            lede="Lock AFHO and your weight in every reward drop grows the longer you stay, from 1x the moment you lock toward a 3x cap. Paid out of bond sales and the penalties of everyone who couldn't wait."
            title="Locking Rewards | After Hours"
            description="Lock AFHO for a multiplier that ramps toward 3x, paid from bond sale proceeds and early-exit penalties. Wall St hours apply to stakers too."
        >
            <div className="feature-chart-row">
                <div className="feature-chart glass-pane">
                    <h3>The multiplier ramp</h3>
                    <MultiplierCurve />
                    <p className="chart-note">
                        The on-chain formula, not an illustration: weight = amount ×
                        multiplier, ramping toward a 3x cap; about half the range
                        lands in the first 60 days.
                    </p>
                </div>
            </div>

            <div className="feature-grid">
                <FeatureCard title="A log curve, not a cliff">
                    <p>
                        The multiplier starts at 1x on day zero and ramps toward a
                        3x cap: roughly 2x by day 60, about 2.7x at a year. Early
                        lockers gain fast; nobody gains infinitely.
                    </p>
                </FeatureCard>
                <FeatureCard title="Two taps feed the pool">
                    <p>
                        Every bond sale routes 10% to stakers and 10% to the dip
                        reserve; the other 80% goes to buybacks. On top of that,
                        penalties paid by impatient unlockers stream to the pool.
                    </p>
                </FeatureCard>
                <FeatureCard title="Wall St hours apply to you too">
                    <p>
                        Reward claims only run while the NYSE is open. And the
                        later you exit, the more it costs: a small penalty after
                        hours, a medium one overnight, severe during halts.
                    </p>
                </FeatureCard>
                <FeatureCard title="Same contract as everyone">
                    <p>
                        No VIP wallets. The developer&rsquo;s own holdings stake
                        through this exact contract, at these exact terms. See
                        the Authority page.
                    </p>
                </FeatureCard>
            </div>

            <FeatureCta
                href="/"
                label="Stake AFHO"
                note="Connect your wallet on the homepage; the stake form appears there."
                internal
            />
        </FeaturePage>
    );
}
