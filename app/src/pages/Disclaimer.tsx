import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Helmet } from 'react-helmet-async';
import { SiteNav } from '../components/SiteNav';
import './Litepaper.css';

/* /disclaimer — plain-language disclaimer for the Interface and the Protocol.
 * Content is inline JSX (single source of truth). Styling reuses the
 * litepaper document classes so the page reads like the rest of the docs. */

export default function Disclaimer() {
    const [mounted, setMounted] = useState(false);
    useEffect(() => {
        setMounted(true);
    }, []);

    return (
        <div className={`litepaper-shell${mounted ? ' mounted' : ''}`}>
            <Helmet>
                <title>Disclaimer | AFHO</title>
                <meta
                    name="description"
                    content="AFHO interface and protocol disclaimer: terms, risks and legal notices for the After Hours protocol."
                />
            </Helmet>
            <SiteNav />
            <div className="fx-backdrop" aria-hidden="true">
                <div className="fx-blob fx-blob--1" />
                <div className="fx-blob fx-blob--2" />
            </div>
            <article className="litepaper glass-pane">
                <h1 className="litepaper-h1">Disclaimer</h1>

                <p className="litepaper-p">
                    This website-hosted user interface (the "Interface") is an open source
                    frontend portal to the After Hours protocol, a decentralized and
                    community-driven collection of blockchain-enabled smart contracts and
                    tools deployed on the Solana network (the "Protocol"). The Protocol runs
                    by itself. Offer sales, staking, buybacks, and market state updates are
                    executed by permissionless programs, not by this website. Because the
                    Protocol is open source and permissionless, any person or entity can
                    access it directly on chain or build their own interface to it.
                </p>

                <p className="litepaper-p">
                    THIS INTERFACE AND THE PROTOCOL ARE PROVIDED "AS IS", AT YOUR OWN RISK,
                    AND WITHOUT WARRANTIES OF ANY KIND. No developer, deployer, or other
                    party involved in creating, deploying, or maintaining this Interface or
                    the Protocol provides, owns, or controls the Protocol or any transaction
                    conducted through it. By using or accessing this Interface or the
                    Protocol, you agree that no developer or entity involved in creating,
                    deploying, or maintaining this Interface or the Protocol will be liable
                    for any claims or damages whatsoever associated with your use, inability
                    to use, or your interaction with other users of the Interface or the
                    Protocol, including any direct, indirect, incidental, special,
                    exemplary, punitive, or consequential damages, or loss of profits,
                    digital assets, tokens, or anything else of value.
                </p>

                <p className="litepaper-p">
                    The Protocol is experimental software. Smart contracts can contain bugs
                    or behave in unexpected ways, and transactions on a blockchain cannot be
                    reversed. AFHO is a volatile digital asset. Its price depends on
                    on-chain liquidity and market activity that nobody controls. Bond
                    sales, staking rewards, buybacks, and dip purchases are features of the
                    Protocol's programs, not promises of returns. Never spend money you
                    cannot afford to lose.
                </p>

                <p className="litepaper-p">
                    After Hours is a theme, not an affiliation. The Protocol and this
                    Interface are not affiliated with, endorsed by, or connected to the New
                    York Stock Exchange, any exchange, or any market data provider. Market
                    hours drive the Protocol's state, but nothing here is an exchange or a
                    securities market. Nothing in this Interface, the documentation, or any
                    community channel is financial, legal, or tax advice.
                </p>

                <p className="litepaper-p">
                    The Protocol is not available to residents of Belarus, the Central
                    African Republic, The Democratic Republic of Congo, the Democratic
                    People's Republic of Korea, the Crimea, Donetsk People's Republic, and
                    Luhansk People's Republic regions of Ukraine, Cuba, Iran, Libya,
                    Somalia, Sudan, South Sudan, Syria, the USA, Yemen, Zimbabwe, and any
                    other jurisdiction in which accessing or using the Protocol is
                    prohibited (the "Prohibited Jurisdictions").
                </p>

                <p className="litepaper-p">
                    By using or accessing this Interface or the Protocol, you represent that
                    you are not located in, incorporated or established in, or a citizen or
                    resident of the Prohibited Jurisdictions. You also represent that you
                    are not subject to sanctions or otherwise designated on any list of
                    prohibited or restricted parties, including but not limited to the
                    lists maintained by the United States' Department of Treasury's Office
                    of Foreign Assets Control, the United Nations Security Council, the
                    European Union or its Member States, or any other government authority.
                </p>
            </article>
            <footer className="litepaper-footer">
                <Link to="/" className="litepaper-back">← Back to the desk</Link>
            </footer>
        </div>
    );
}
