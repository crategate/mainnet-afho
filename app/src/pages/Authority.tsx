import { FeaturePage, FeatureCta } from '../components/FeaturePage';

/* /authority — the Authority page. The trust page: which keys are burned,
 * which are multisig, what the programs can and can't do, and the developer
 * holdings disclosure. Doubles as the transparency page screeners keep
 * asking for. */

const ROWS: { key: string; value: JSX.Element }[] = [
    {
        key: 'Mint authority',
        value: (
            <>
                <strong>Burned.</strong> Revoked in the same transaction that
                created the token. Supply is fixed. Nobody, including us,
                can print AFHO.
            </>
        ),
    },
    {
        key: 'Metadata',
        value: (
            <>
                <strong>Frozen.</strong> Update authority nulled at creation.
                Name, symbol and URI can&rsquo;t be rewritten by anyone.
            </>
        ),
    },
    {
        key: 'Pool liquidity',
        value: (
            <>
                <strong>Burned.</strong> The launch pool&rsquo;s LP tokens are
                destroyed at launch. Liquidity can&rsquo;t be pulled and the
                pool can&rsquo;t be drained by its creators.
            </>
        ),
    },
    {
        key: 'Program authority',
        value: (
            <>
                <strong>Multisig.</strong> The programs&rsquo; signing and
                upgrade authorities live on a Squads multisig, not a single
                key. Rotations are on-chain transactions anyone can audit.
            </>
        ),
    },
    {
        key: 'The crank',
        value: (
            <>
                <strong>Permissionless.</strong> Anyone can crank the oracle
                and claim the posted bounty. A keeper bot does it on schedule;
                it has no special keys.
            </>
        ),
    },
    {
        key: 'The treasury',
        value: (
            <>
                <strong>Program-controlled.</strong> 20% of supply seeds the
                pool; the rest sits in program vaults that only the mechanics
                (bonds, buybacks, rewards) can move. There is no
                discretionary team wallet of size.
            </>
        ),
    },
    {
        key: 'The developer',
        value: (
            <>
                <strong>Disclosed.</strong> A publicly announced buy-in (see
                the pinned post on X), held in ordinary wallets and staked
                through the same locking contract as everyone else. No silent
                treasury, no shadow allocation.
            </>
        ),
    },
];

export default function Authority() {
    return (
        <FeaturePage
            eyebrow="Authority"
            headline="Who holds the keys, and which ones got burned."
            lede="AFHO's authority surface, spelled out: what's destroyed, what's multisig, and how rotations happen. Every claim below is a transaction you can check."
            title="Authority | After Hours"
            description="AFHO's keys: mint authority burned, metadata frozen, LP burned at launch, programs on a Squads multisig, developer holdings disclosed."
        >
            {/* The program-authority badge up top: the same boxed Squads
                lockup the homepage Built With strip carries, sized up and
                centered. It fronts-loads the multisig claim the Program
                authority row makes below. */}
            <div className="authority-squads">
                <a
                    className="built-with-tile neon-glitch glass-pane authority-squads-tile"
                    href="https://docs.squads.so/"
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label="Squads documentation"
                    style={{ '--glitch-delay': '1.2s' } as React.CSSProperties}
                >
                    <img
                        src="/Logo White.svg"
                        alt="Squads logo"
                        className="built-with-logo authority-squads-logo"
                        loading="lazy"
                    />
                </a>
            </div>

            <div className="feature-rows">
                {ROWS.map((row) => (
                    <div className="feature-row" key={row.key}>
                        <div className="feature-row-key">{row.key}</div>
                        <div className="feature-row-value">{row.value}</div>
                    </div>
                ))}
            </div>

            <FeatureCta
                href="/disclaimer"
                label="Read the disclaimer"
                note="AFHO is an experiment, not financial advice."
                internal
            />
        </FeaturePage>
    );
}
