#!/usr/bin/env node
// Market-status image review — the "propose → adjust → approve" flow.
//
//   npm run review:images          (or: node tools/state-image-review.mjs)
//   → http://localhost:5177
//
// For every image in public/state-images/: shows how the tile actually
// crops it (hero ~2:1 and /oracle ~3:2 cover previews) with the current
// focal point. Click a preview to move the focal point (the subject the
// crop follows), Approve to keep, Reject to bench the file (renamed to
// *.rejected — the vite manifest ignores it; delete the suffix to undo,
// or use Restore). Every action writes public/state-images/focal.json,
// which the app build reads — the site picks changes up on next build
// (dev server hot-reloads it).
//
// Auto-proposals (energy-centroid focal + luma) come from the seed pass;
// Reset returns to them.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../public/state-images');
const PORT = Number(process.env.PORT || 5177);
const IMG_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.avif', '.gif']);

const sh = (cmd, ...args) => execFileSync(cmd, args, { encoding: 'utf8' }).trim();

function readFocal() {
    try {
        return JSON.parse(fs.readFileSync(path.join(ROOT, 'focal.json'), 'utf8')).focal ?? {};
    } catch {
        return {};
    }
}

function writeFocal(focal) {
    fs.writeFileSync(path.join(ROOT, 'focal.json'), JSON.stringify({ focal }, null, 1) + '\n');
}

function scan() {
    const pools = {};
    const walk = (dir, rel) => {
        for (const name of fs.readdirSync(dir).sort()) {
            if (name.startsWith('.') || name === 'focal.json' || name === 'README.md') continue;
            const p = path.join(dir, name);
            const r = rel ? `${rel}/${name}` : name;
            if (fs.statSync(p).isDirectory()) walk(p, r);
            else {
                const rejected = name.endsWith('.rejected');
                const baseExt = path.extname(rejected ? name.slice(0, -'.rejected'.length) : name).toLowerCase();
                if (!IMG_EXTS.has(baseExt)) continue;
                const [w, h] = sh('identify', '-format', '%w %h', p).split(' ').map(Number);
                const kb = Math.round(fs.statSync(p).size / 1024);
                (pools[rel] ??= []).push({ rel: r, w, h, kb, rejected });
            }
        }
    };
    walk(ROOT, '');
    return pools;
}

const MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.avif': 'image/avif', '.gif': 'image/gif' };

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>state-images review</title><style>
body{background:#0b0b0e;color:#ddd;font:14px/1.5 ui-monospace,monospace;margin:0;padding:24px}
h1{font-size:18px;color:#0ef}h2{font-size:13px;letter-spacing:.2em;text-transform:uppercase;color:#0ef;margin:32px 0 8px;border-bottom:1px solid #222;padding-bottom:6px}
.card{display:flex;gap:16px;padding:12px;border:1px solid #222;border-radius:10px;margin-bottom:10px;background:#101014;flex-wrap:wrap}
.card.approved{border-color:#14532d}.card.rejected{opacity:.45;border-color:#7f1d1d}
.pre{width:300px;height:150px;background-size:cover;border-radius:8px;cursor:crosshair;position:relative;border:1px solid #333;outline:none}
.pre.wide{height:150px}.pre.tall{height:200px;width:300px}
.meta{min-width:220px}
.fn{color:#fff;word-break:break-all}
.badge{display:inline-block;padding:1px 7px;border-radius:99px;font-size:11px;margin:2px 4px 2px 0;border:1px solid #333;color:#aaa}
.badge.warn{color:#fbbf24;border-color:#92400e}.badge.ok{color:#34d399;border-color:#14532d}
.focal{color:#0ef}
button{background:#18181d;color:#ddd;border:1px solid #333;border-radius:6px;padding:4px 12px;cursor:pointer;font:inherit;margin-right:6px;margin-top:8px}
button:hover{border-color:#0ef;color:#fff}
button.approve{border-color:#14532d;color:#34d399}button.reject{border-color:#7f1d1d;color:#f87171}
.hint{color:#666;font-size:12px}
</style></head><body>
<h1>state-images review — click a preview to set the focal point</h1>
<p class="hint">Left = hero tile crop (2:1), right = /oracle crop (3:2). Focal writes focal.json immediately; Approve marks curation done; Reject benches the file (*.rejected, restorable). Rebuild the app to ship changes.</p>
<div id="app">loading…</div>
<script>
let DATA;
async function load(){ DATA = await (await fetch('/api/state')).json(); render(); }
async function api(ep, body){ await fetch(ep,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}); load(); }
function fmt(f){ return f ? Math.round(f.x)+'%, '+Math.round(f.y)+'%' : '—'; }
function render(){
  const el = document.getElementById('app'); el.innerHTML = '';
  for (const [pool, imgs] of Object.entries(DATA.pools)) {
    const sec = document.createElement('div');
    sec.innerHTML = '<h2>'+pool+' ('+imgs.length+')</h2>';
    for (const im of imgs) {
      const f = DATA.focal[im.rel] || {};
      const card = document.createElement('div');
      card.className = 'card ' + (f.approved ? 'approved' : '') + (im.rejected ? 'rejected' : '');
      const pos = (f.x!==undefined ? f.x+'% '+(f.y??50)+'%' : '50% 42%');
      const badges = [
        im.w+'x'+im.h, im.kb+'KB',
        im.w<900?'<span class="badge warn">small</span>':'',
        im.kb>400?'<span class="badge warn">heavy</span>':'',
        f.approved?'<span class="badge ok">approved</span>':'',
        im.rejected?'<span class="badge warn">rejected</span>':'',
      ].join(' ');
      card.innerHTML =
        '<div class="pre wide" style="background-image:url(/img/'+im.rel+');background-position:'+pos+'"></div>'+
        '<div class="pre tall" style="width:264px;background-image:url(/img/'+im.rel+');background-position:'+pos+'"></div>'+
        '<div class="meta"><div class="fn">'+im.rel.split('/').pop()+'</div><div>'+badges+'</div>'+
        '<div>focal <span class="focal">'+fmt(f)+'</span>'+(f.auto&&f.x!==undefined?' <span class="hint">(auto '+Math.round(f.auto.x)+'%, '+Math.round(f.auto.y)+'%)</span>':'')+'</div>'+
        '<button class="approve" onclick="api(\\'/api/focal\\',{rel:\\''+im.rel+'\\',approved:true})">Approve</button>'+
        (im.rejected
          ? '<button onclick="api(\\'/api/restore\\',{rel:\\''+im.rel+'\\'})">Restore</button>'
          : '<button class="reject" onclick="api(\\'/api/reject\\',{rel:\\''+im.rel+'\\'})">Reject</button>')+
        (f.auto?'<button onclick="api(\\'/api/focal\\',{rel:\\''+im.rel+'\\',x:f.auto.x,y:f.auto.y})">Reset auto</button>':'')+
        '</div>';
      card.querySelectorAll('.pre').forEach((p) => p.addEventListener('click', (e) => {
        const r = p.getBoundingClientRect();
        const x = Math.round((e.clientX - r.left) / r.width * 100);
        const y = Math.round((e.clientY - r.top) / r.height * 100);
        api('/api/focal', { rel: im.rel, x, y });
      }));
      sec.appendChild(card);
    }
    el.appendChild(sec);
  }
}
load();
</script></body></html>`;

http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (req.method === 'GET' && url.pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(PAGE);
    } else if (req.method === 'GET' && url.pathname.startsWith('/img/')) {
        const p = path.join(ROOT, path.normalize(url.pathname.replace('/img/', '')));
        if (!p.startsWith(ROOT) || !fs.existsSync(p)) { res.writeHead(404); return res.end(); }
        const base = p.replace(/\\.rejected$/, '');
        res.writeHead(200, { 'Content-Type': MIME[path.extname(base).toLowerCase()] ?? 'application/octet-stream' });
        res.end(fs.readFileSync(p));
    } else if (req.method === 'GET' && url.pathname === '/api/state') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ pools: scan(), focal: readFocal() }));
    } else if (req.method === 'POST' && url.pathname === '/api/focal') {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
            const { rel, x, y, approved } = JSON.parse(body);
            const focal = readFocal();
            const cur = focal[rel] ?? {};
            focal[rel] = {
                x: x ?? cur.x,
                y: y ?? cur.y,
                // snapshot the first-ever values as the auto proposal (Reset target)
                auto: cur.auto ?? (cur.x !== undefined ? { x: cur.x, y: cur.y } : undefined),
                approved: approved ?? cur.approved ?? false,
            };
            writeFocal(focal);
            res.writeHead(200); res.end('ok');
        });
    } else if (req.method === 'POST' && url.pathname === '/api/reject') {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
            const { rel } = JSON.parse(body);
            const p = path.join(ROOT, rel);
            if (fs.existsSync(p)) fs.renameSync(p, p + '.rejected');
            res.writeHead(200); res.end('ok');
        });
    } else if (req.method === 'POST' && url.pathname === '/api/restore') {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
            const { rel } = JSON.parse(body);
            const p = path.join(ROOT, rel) + '.rejected';
            if (fs.existsSync(p)) fs.renameSync(p, path.join(ROOT, rel));
            res.writeHead(200); res.end('ok');
        });
    } else {
        res.writeHead(404); res.end();
    }
}).listen(PORT, () => {
    console.log(`state-image review → http://localhost:${PORT}  (Ctrl+C to exit)`);
});
