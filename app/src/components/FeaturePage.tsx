import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Helmet } from 'react-helmet-async';
import { GlitchText } from './GlitchText';
import { SiteNav } from './SiteNav';
import './FeaturePage.css';

/* Shared shell for the per-feature explainer pages (/oracle, /locking,
 * /authority). Same drifting backdrop + nav as the landing page so
 * navigation feels continuous; content blocks are composed by each page
 * from the .feature-* classes in FeaturePage.css.
 *
 * These pages exist to be SHARED — each one is the canonical link for one
 * mechanic (tweet it, pin it, drop it in TG). The Helmet title/description
 * double as the per-page meta; the static og:* tags in index.html cover
 * link previews since scrapers don't run the SPA. */

interface FeaturePageProps {
    eyebrow: string;
    headline: string;
    lede: string;
    title: string;
    description: string;
    children: ReactNode;
}

export function FeaturePage({
    eyebrow,
    headline,
    lede,
    title,
    description,
    children,
}: FeaturePageProps) {
    return (
        <div className="landing-page feature-page">
            <Helmet>
                <title>{title}</title>
                <meta name="description" content={description} />
            </Helmet>
            <div className="fx-backdrop" aria-hidden="true">
                <div className="fx-blob fx-blob--1" />
                <div className="fx-blob fx-blob--2" />
                <div className="fx-blob fx-blob--3" />
                <div className="fx-blob fx-blob--4" />
            </div>
            <SiteNav />
            <section className="landing-section feature-section">
                <div className="landing-section-inner">
                    <p className="feature-eyebrow">{eyebrow}</p>
                    <h1 className="feature-headline">
                        <GlitchText text={headline} split="word" step={0.3} />
                    </h1>
                    <p className="feature-lede">{lede}</p>
                    {children}
                </div>
            </section>
        </div>
    );
}

/* Small building blocks shared by the feature pages. */

export function FeatureCard({
    title,
    children,
    className = '',
}: {
    title: string;
    children: ReactNode;
    className?: string;
}) {
    return (
        <div className={`feature-card glass-pane ${className}`.trim()}>
            <h3>{title}</h3>
            <div className="feature-card-body">{children}</div>
        </div>
    );
}

export function FeatureSteps({
    caption,
    steps,
}: {
    caption: string;
    steps: string[];
}) {
    return (
        <div className="feature-steps glass-pane">
            <h3>{caption}</h3>
            <ol>
                {steps.map((step, i) => (
                    <li key={i}>
                        <span className="feature-step-num" aria-hidden="true">
                            {i + 1}
                        </span>
                        <span>{step}</span>
                    </li>
                ))}
            </ol>
        </div>
    );
}

export function FeatureCta({
    href,
    label,
    note,
    internal = false,
}: {
    href: string;
    label: string;
    note?: string;
    internal?: boolean;
}) {
    return (
        <div className="feature-cta">
            {internal ? (
                <Link className="feature-cta-button" to={href}>{label}</Link>
            ) : (
                <a className="feature-cta-button" href={href} target="_blank"
                    rel="noopener noreferrer">{label}</a>
            )}
            {note && <p className="feature-cta-note">{note}</p>}
        </div>
    );
}
