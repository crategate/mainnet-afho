import { useWallet } from '@solana/wallet-adapter-react';
import { HeroSection } from '../components/landing/HeroSection';
import { StakingSection } from '../components/landing/StakingSection';
import { StatsSection } from '../components/landing/StatsSection';
import { ExplainerSection } from '../components/landing/ExplainerSection';
import { BuiltWithSection } from '../components/landing/BuiltWithSection';
import { SiteFooter } from '../components/landing/SiteFooter';
import type { ResolvedDeployment } from '../config';

interface LandingPageProps {
    deployment: ResolvedDeployment;
}

export default function LandingPage({ deployment }: LandingPageProps) {
    const { connected } = useWallet();

    return (
        <div className="landing-page">
            <div className="fx-backdrop" aria-hidden="true">
                <div className="fx-blob fx-blob--1" />
                <div className="fx-blob fx-blob--2" />
                <div className="fx-blob fx-blob--3" />
                <div className="fx-blob fx-blob--4" />
            </div>
            <HeroSection deployment={deployment} />
            {/* The staking slot earns its keep either way: connected
                visitors get their Active Positions; disconnected visitors
                get the Built With strip here instead (it repeats at the
                bottom only when connected, so it never shows twice). */}
            {connected ? (
                <StakingSection mint={deployment.mintKey} marketStatusPda={deployment.marketStatusKey} />
            ) : (
                <BuiltWithSection />
            )}
            <StatsSection mint={deployment.mintKey} />
            <ExplainerSection />
            {connected && <BuiltWithSection />}
            <SiteFooter mint={deployment.mintKey} />
        </div>
    );
}
