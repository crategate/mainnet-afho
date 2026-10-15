import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Helmet } from 'react-helmet-async';
import { SiteNav } from '../components/SiteNav';
import './Litepaper.css';

/* /litepaper — renders litepaper.md (imported raw by Vite) with a small,
 * dependency-free markdown subset renderer: #/##/### headings, paragraphs,
 * - lists, > blockquotes, |tables|, **bold** and `code`. Content stays the
 * single source of truth in the repo's litepaper.md. */

import litepaperRaw from '../../../litepaper.md?raw';
import LitepaperCharts from './LitepaperCharts';

/* ── tiny inline formatter: **bold**, `code` ── */
function inline(text: string, keyBase: string): ReactNode[] {
    const out: ReactNode[] = [];
    // Split on **bold** and `code` without nesting the two.
    const re = /(\*\*[^*]+\*\*|`[^`]+`)/g;
    const parts = text.split(re);
    parts.forEach((part, i) => {
        if (!part) return;
        const key = `${keyBase}-${i}`;
        if (part.startsWith('**') && part.endsWith('**')) {
            out.push(<strong key={key}>{part.slice(2, -2)}</strong>);
        } else if (part.startsWith('`') && part.endsWith('`')) {
            out.push(<code key={key}>{part.slice(1, -1)}</code>);
        } else {
            out.push(<span key={key}>{part}</span>);
        }
    });
    return out;
}

type Block =
    | { kind: 'h1' | 'h2' | 'h3'; text: string }
    | { kind: 'p'; text: string }
    | { kind: 'quote'; text: string }
    | { kind: 'list'; items: { text: string; children: string[] }[] }
    | { kind: 'table'; head: string[]; rows: string[][] }
    | { kind: 'charts' }
    | { kind: 'hr' };

function parse(md: string): Block[] {
    const lines = md.split('\n');
    const blocks: Block[] = [];
    let para: string[] = [];
    let list: { text: string; children: string[] }[] | null = null;

    const flushPara = () => {
        if (para.length) {
            blocks.push({ kind: 'p', text: para.join(' ').trim() });
            para = [];
        }
    };
    const flushList = () => {
        if (list && list.length) blocks.push({ kind: 'list', items: list });
        list = null;
    };

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trim();

        if (!trimmed) {
            flushPara();
            flushList();
            continue;
        }
        if (trimmed === '---') {
            flushPara();
            flushList();
            blocks.push({ kind: 'hr' });
            continue;
        }
        if (trimmed.startsWith('### ')) {
            flushPara();
            flushList();
            blocks.push({ kind: 'h3', text: trimmed.slice(4) });
            continue;
        }
        if (trimmed.startsWith('## ')) {
            flushPara();
            flushList();
            blocks.push({ kind: 'h2', text: trimmed.slice(3) });
            continue;
        }
        if (trimmed.startsWith('# ')) {
            flushPara();
            flushList();
            blocks.push({ kind: 'h1', text: trimmed.slice(2) });
            continue;
        }
        if (trimmed.startsWith('> ')) {
            flushPara();
            flushList();
            blocks.push({ kind: 'quote', text: trimmed.slice(2) });
            continue;
        }
        // Nested bullet (indented "- " under the previous item).
        if (list && /^\s{2,}[-*] /.test(line)) {
            list[list.length - 1].children.push(trimmed.slice(2));
            continue;
        }
        if (/^[-*] /.test(trimmed)) {
            flushPara();
            list ??= [];
            list.push({ text: trimmed.slice(2), children: [] });
            continue;
        }
        // Chart block marker: renders the key-numbers charts (LitepaperCharts).
        if (trimmed === '{{charts}}') {
            flushPara();
            flushList();
            blocks.push({ kind: 'charts' });
            continue;
        }
        // Table row? (| … | … |) — collect the whole table greedily.
        if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
            flushPara();
            flushList();
            const rows: string[][] = [];
            while (i < lines.length) {
                const t = lines[i].trim();
                if (!(t.startsWith('|') && t.endsWith('|'))) break;
                // Skip the |---|---| separator row.
                if (!/^\|[\s:|-]+\|$/.test(t)) {
                    rows.push(t.slice(1, -1).split('|').map((c) => c.trim()));
                }
                i++;
            }
            i--; // the for-loop advances again
            const head = rows.shift() ?? [];
            blocks.push({ kind: 'table', head, rows });
            continue;
        }
        // Continuation line of a list item (indented under "- ").
        if (list && /^\s{2,}\S/.test(line)) {
            list[list.length - 1].text += ` ${trimmed}`;
            continue;
        }
        flushList();
        para.push(trimmed);
    }
    flushPara();
    flushList();
    return blocks;
}

function renderBlock(block: Block, i: number): ReactNode {
    switch (block.kind) {
        case 'h1':
            return <h1 key={i} className="litepaper-h1">{inline(block.text, `h1-${i}`)}</h1>;
        case 'h2':
            return <h2 key={i} className="litepaper-h2">{inline(block.text, `h2-${i}`)}</h2>;
        case 'h3':
            return <h3 key={i} className="litepaper-h3">{inline(block.text, `h3-${i}`)}</h3>;
        case 'p':
            return <p key={i} className="litepaper-p">{inline(block.text, `p-${i}`)}</p>;
        case 'quote':
            return <blockquote key={i} className="litepaper-quote">{inline(block.text, `q-${i}`)}</blockquote>;
        case 'list':
            return (
                <ul key={i} className="litepaper-list">
                    {block.items.map((item, j) => (
                        <li key={j}>
                            {inline(item.text, `li-${i}-${j}`)}
                            {item.children.length > 0 && (
                                <ul className="litepaper-sublist">
                                    {item.children.map((c, k) => (
                                        <li key={k}>{inline(c, `li-${i}-${j}-${k}`)}</li>
                                    ))}
                                </ul>
                            )}
                        </li>
                    ))}
                </ul>
            );
        case 'table':
            return (
                <div key={i} className="litepaper-table-wrap">
                    <table className="litepaper-table">
                        <thead>
                            <tr>{block.head.map((h, j) => <th key={j}>{inline(h, `th-${i}-${j}`)}</th>)}</tr>
                        </thead>
                        <tbody>
                            {block.rows.map((r, j) => (
                                <tr key={j}>{r.map((c, k) => <td key={k}>{inline(c, `td-${i}-${j}-${k}`)}</td>)}</tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            );
        case 'charts':
            return <LitepaperCharts key={i} />;
        case 'hr':
            return <hr key={i} className="litepaper-hr" />;
    }
}

export default function Litepaper() {
    const blocks = useMemo(() => parse(litepaperRaw), []);
    const [mounted, setMounted] = useState(false);
    useEffect(() => {
        setMounted(true);
    }, []);

    return (
        <div className={`litepaper-shell${mounted ? ' mounted' : ''}`}>
            <Helmet>
                <title>Litepaper | AFHO</title>
                <meta
                    name="description"
                    content="AFHO litepaper: a token tuned to market hours. Buybacks while Wall St trades, an after-hours bond desk, and staking incentives driven by the NYSE clock."
                />
            </Helmet>
            <SiteNav />
            <div className="fx-backdrop" aria-hidden="true">
                <div className="fx-blob fx-blob--1" />
                <div className="fx-blob fx-blob--2" />
            </div>
            <article className="litepaper glass-pane">
                {blocks.map(renderBlock)}
            </article>
            <footer className="litepaper-footer">
                <Link to="/" className="litepaper-back">← Back to the desk</Link>
            </footer>
        </div>
    );
}
