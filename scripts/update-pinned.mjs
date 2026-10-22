#!/usr/bin/env node
/**
 * Writes data/pinned.json with ALL public repositories of a GitHub account (the file name is kept
 * so the workflows and the README renderer keep working): name, description, language, stars,
 * topics and up to 5 images per repo (README images first, then screenshots found in the repo,
 * finally GitHub's social card). Pinned repos come first (pinned: true), then the rest by last push.
 *
 *   GH_TOKEN=<token> node scripts/update-pinned.mjs [data/pinned.json]
 *
 * Optional environment variables:
 *   EXCLUDE_REPOS   comma separated repo names to leave out (default: the profile repo <login> and <login>.github.io)
 *   INCLUDE_FORKS   "false" to skip forks (default: true)
 *   INCLUDE_ARCHIVED "false" to skip archived repos (default: true)
 *   MAX_REPOS       upper limit (default 40)
 *
 * Thumbnail override: add  "repo-name": "https://.../image.png"  (or a path inside this site,
 * e.g. "assets/thumbs/repo-name.png") to data/thumbnails.json - it is always used first.
 *
 * In GitHub Actions the built-in GITHUB_TOKEN is enough (see .github/workflows/update-pinned.yml).
 * Node 18+, no dependencies.
 */
import fs from 'node:fs';
import path from 'node:path';

const LOGIN = process.env.GH_LOGIN || 'Hadifard';
const TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
const API = (process.env.GH_API || 'https://api.github.com').replace(/\/$/, '');
const OUT = path.resolve(process.argv[2] || 'data/pinned.json');
const MAX_IMAGES = 5;
const MAX_REPOS = +(process.env.MAX_REPOS || 40);
const INCLUDE_FORKS = (process.env.INCLUDE_FORKS || 'true') !== 'false';
const INCLUDE_ARCHIVED = (process.env.INCLUDE_ARCHIVED || 'true') !== 'false';
const EXCLUDE = new Set((process.env.EXCLUDE_REPOS || `${LOGIN},${LOGIN}.github.io`).split(',').map(x => x.trim().toLowerCase()).filter(Boolean));
const THUMBS_FILE = path.join(path.dirname(OUT), 'thumbnails.json');

if (!TOKEN) { console.error('Set GH_TOKEN (or GITHUB_TOKEN).'); process.exit(1); }

const headers = { Authorization: `Bearer ${TOKEN}`, 'User-Agent': 'pinned-sync', Accept: 'application/vnd.github+json' };

async function rest(url, accept) {
  const r = await fetch(API + url, { headers: accept ? { ...headers, Accept: accept } : headers });
  if (!r.ok) return null;
  return accept && accept.includes('raw') ? r.text() : r.json();
}

const FIELDS = `name nameWithOwner description url homepageUrl stargazerCount pushedAt openGraphImageUrl isFork isArchived
      primaryLanguage{ name color } repositoryTopics(first:6){ nodes{ topic{ name } } } defaultBranchRef{ name }`;

async function gql(query, variables) {
  const r = await fetch(API + '/graphql', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ query, variables }) });
  const j = await r.json();
  if (!r.ok || j.errors) throw new Error('GraphQL failed: ' + JSON.stringify(j.errors || r.status));
  return j.data;
}

async function pinnedNames() {
  const d = await gql(`query($login:String!){ user(login:$login){ pinnedItems(first:6, types:REPOSITORY){ nodes{ ... on Repository { name } } } } }`, { login: LOGIN });
  return (d.user.pinnedItems.nodes || []).filter(Boolean).map(n => n.name);
}

async function publicRepos() {
  const out = []; let after = null;
  for (;;) {
    const d = await gql(`query($login:String!,$after:String){ user(login:$login){ repositories(first:100, after:$after, privacy:PUBLIC, ownerAffiliations:OWNER, orderBy:{field:PUSHED_AT, direction:DESC}){
      pageInfo{ hasNextPage endCursor } nodes{ ${FIELDS} } } } }`, { login: LOGIN, after });
    const c = d.user.repositories; out.push(...c.nodes.filter(Boolean));
    if (!c.pageInfo.hasNextPage || out.length >= 300) break; after = c.pageInfo.endCursor;
  }
  return out;
}

async function allRepos() {
  const pins = await pinnedNames();
  let list = (await publicRepos()).filter(r => !EXCLUDE.has(r.name.toLowerCase()) && (INCLUDE_FORKS || !r.isFork) && (INCLUDE_ARCHIVED || !r.isArchived));
  const rank = n => { const k = pins.indexOf(n); return k < 0 ? 1e6 : k; };
  list = list.map((r, i) => ({ r, i })).sort((a, b) => (rank(a.r.name) - rank(b.r.name)) || (a.i - b.i)).map(x => x.r);   // pinned first (in pin order), then latest push
  return list.slice(0, MAX_REPOS).map(r => ({ ...r, pinned: pins.includes(r.name) }));
}

const IMG_EXT = /\.(png|jpe?g|gif|webp)(\?.*)?$/i;
const BAD_HOST = /(shields\.io|badge|badgen|travis-ci|codecov|coveralls|img\.youtube|api\.star-history)/i;
const raw = (nwo, branch, p) => `https://raw.githubusercontent.com/${nwo}/${branch}/${p.split('/').map(encodeURIComponent).join('/')}`;

function readmeImages(md, nwo, branch) {
  const found = [];
  const re = [/!\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+["'][^"']*["'])?\s*\)/g, /<img[^>]+src=["']([^"']+)["']/gi];
  for (const rx of re) for (const m of md.matchAll(rx)) found.push(m[1]);
  const out = [];
  for (let u of found) {
    if (BAD_HOST.test(u)) continue;
    if (!/^https?:/i.test(u)) { if (!IMG_EXT.test(u)) continue; u = raw(nwo, branch, u.replace(/^\.?\//, '').replace(/^\//, '')); }
    else if (!IMG_EXT.test(u) && !/github\.com\/user-attachments\/assets\//.test(u) && !/user-images\.githubusercontent\.com/.test(u)) continue;
    if (/\.svg(\?|$)/i.test(u)) continue;
    if (!out.includes(u)) out.push(u);
  }
  return out;
}

function treeImages(tree, nwo, branch) {
  const GOOD = /(screenshot|screen|demo|preview|overview|result|output|figure|fig|docs?|images?|assets|media|gallery)/i;
  const SKIP = /(node_modules|vendor|favicon|icon|logo|badge|sprite|\.github\/|thumb|avatar)/i;
  return tree
    .filter(e => e.type === 'blob' && IMG_EXT.test(e.path) && !SKIP.test(e.path) && e.size > 15e3 && e.size < 8e6)
    .map(e => ({ e, score: (GOOD.test(e.path) ? 5 : 0) - e.path.split('/').length * 0.4 + Math.min(e.size / 4e5, 2) }))
    .sort((a, b) => b.score - a.score)
    .map(x => raw(nwo, branch, x.e.path));
}

async function imagesFor(repo) {
  const nwo = repo.nameWithOwner, branch = repo.defaultBranchRef?.name || 'main';
  const list = [];
  const push = u => { if (u && !list.includes(u) && list.length < MAX_IMAGES) list.push(u); };
  try { const md = await rest(`/repos/${nwo}/readme`, 'application/vnd.github.raw+json'); if (md) readmeImages(md, nwo, branch).forEach(push); } catch {}
  try { const t = await rest(`/repos/${nwo}/git/trees/${encodeURIComponent(branch)}?recursive=1`); if (t?.tree) treeImages(t.tree, nwo, branch).forEach(push); } catch {}
  push(repo.openGraphImageUrl || `https://opengraph.githubassets.com/1/${nwo}`);
  return list;
}

let thumbs = {};
try { thumbs = JSON.parse(fs.readFileSync(THUMBS_FILE, 'utf8')); } catch {}

const repos = [];
for (const r of await allRepos()) {
  const images = await imagesFor(r), ov = thumbs[r.name];
  if (typeof ov === 'string' && ov.trim() && !r.name.startsWith('_')) { const k = images.indexOf(ov); if (k >= 0) images.splice(k, 1); images.unshift(ov.trim()); }
  repos.push({
    name: r.name,
    description: r.description || '',
    url: r.url,
    homepage: r.homepageUrl || '',
    language: r.primaryLanguage?.name || '',
    languageColor: r.primaryLanguage?.color || '',
    stars: r.stargazerCount || 0,
    topics: (r.repositoryTopics?.nodes || []).map(n => n.topic.name),
    pinned: !!r.pinned,
    images: images.slice(0, MAX_IMAGES + 1),
  });
}
if (!repos.length) { console.warn('No repositories returned; leaving the file untouched.'); process.exit(0); }

let old = null; try { old = JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch {}
if (old && JSON.stringify(old.repos) === JSON.stringify(repos)) { console.log('Repositories unchanged.'); process.exit(0); }

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify({ login: LOGIN, generatedAt: new Date().toISOString(), repos }, null, 2) + '\n');
console.log(`Wrote ${repos.length} public repositories to ${OUT}:\n  - ` + repos.map(r => `${r.name} (${r.images.length} images)`).join('\n  - '));
