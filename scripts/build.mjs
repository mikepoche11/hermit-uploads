#!/usr/bin/env node
// Fetches every channel's latest YouTube uploads from YouTube's public RSS feeds
// (no API key needed) and writes one data file per category for the static site:
//   site/data/index.json      category list + newest videos across everything
//   site/data/<category>.json channels and their latest videos
//
//   node scripts/build.mjs
//
// Env vars (all optional):
//   VIDEOS_PER_CHANNEL  how many videos to keep per channel (default 3)
//   INCLUDE_SHORTS      "1" to keep YouTube Shorts (default: skip them)
//   PREVIOUS_BASE_URL   URL of the currently deployed site; its data files are a
//                       fallback for any channel whose feed fails this run, and a
//                       cache for avatars and Shorts checks

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PER_CHANNEL = Number(process.env.VIDEOS_PER_CHANNEL || process.env.VIDEOS_PER_CHANNEL || 3);
const INCLUDE_SHORTS = process.env.INCLUDE_SHORTS === "1";
const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(url, { tries = 3, ...opts } = {}) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, {
        ...opts,
        headers: { "user-agent": UA, "accept-language": "en-US,en;q=0.9", cookie: "CONSENT=YES+1", ...(opts.headers || {}) },
      });
      // YouTube's feed endpoint occasionally 404s/500s for a valid channel; retry those.
      if (res.status >= 500 || res.status === 429 || (res.status === 404 && url.includes("/feeds/"))) {
        lastErr = new Error(`${res.status} for ${url}`);
      } else {
        return res;
      }
    } catch (e) {
      lastErr = e;
    }
    await sleep(800 * (i + 1));
  }
  throw lastErr;
}

const decode = (s = "") =>
  s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, "&");

const tag = (xml, name) => {
  const m = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`));
  return m ? decode(m[1].trim()) : "";
};
const attr = (xml, name, a) => {
  const m = xml.match(new RegExp(`<${name}\\s[^>]*\\b${a}="([^"]*)"`));
  return m ? decode(m[1]) : "";
};

export function parseFeed(xml) {
  const channelTitle = tag(xml.split("<entry>")[0], "title");
  const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(([, e]) => ({
    id: tag(e, "yt:videoId"),
    title: tag(e, "title"),
    published: tag(e, "published"),
    views: Number(attr(e, "media:statistics", "views")) || null,
  }));
  return { channelTitle, entries: entries.filter((e) => e.id) };
}

export function parseChannelPage(html) {
  const id =
    html.match(/<meta itemprop="(?:identifier|channelId)" content="(UC[\w-]{22})"/)?.[1] ||
    html.match(/<link rel="canonical" href="https:\/\/www\.youtube\.com\/channel\/(UC[\w-]{22})"/)?.[1] ||
    html.match(/"externalId":"(UC[\w-]{22})"/)?.[1] ||
    html.match(/"channelId":"(UC[\w-]{22})"/)?.[1] ||
    null;
  const avatar = decode(html.match(/<meta property="og:image" content="([^"]+)"/)?.[1] || "") || null;
  return { id, avatar };
}

// A handle is "@name" style by default; one starting with "/" is a legacy channel path
// such as "/mcskizzleman" or "/c/name" (youtube.com/<path>).
const channelPageUrl = (handle) =>
  handle.startsWith("/") ? `https://www.youtube.com${handle}` : `https://www.youtube.com/@${handle}`;

const norm = (s = "") => s.toLowerCase().replace(/[^a-z0-9]/g, "");

// Channel IDs to try for a channel, best guess first: a pinned channelId, then each
// handle in categories.json, then a YouTube channel search for their exact name.
async function* channelCandidates(hermit, previous, diag) {
  const seen = new Set();
  const fresh = (c) => c.id && !seen.has(c.id) && seen.add(c.id);
  if (hermit.channelId) {
    const c = { id: hermit.channelId, handle: hermit.handles[0], avatar: null, source: "pinned" };
    if (previous?.channelId === c.id && previous.avatar) c.avatar = previous.avatar;
    for (const handle of c.avatar ? [] : hermit.handles.slice(0, 1)) {
      try {
        const res = await get(channelPageUrl(handle), { tries: 2 });
        const page = res.ok ? parseChannelPage(await res.text()) : {};
        if (page.id === c.id) c.avatar = page.avatar;
      } catch {}
    }
    if (fresh(c)) yield c;
    // Channels taken straight from a subscription list are exact: never guess another.
    if (hermit.pinnedOnly) return;
  }
  for (const handle of hermit.handles) {
    try {
      const res = await get(channelPageUrl(handle), { tries: 3 });
      if (!res.ok) { diag.push(`@${handle}:${res.status}`); continue; }
      const page = parseChannelPage(await res.text());
      if (!page.id) { diag.push(`@${handle}:no-id`); continue; }
      const c = { ...page, handle, source: `@${handle}` };
      if (fresh(c)) yield c;
    } catch (e) {
      diag.push(`@${handle}:${e.message}`);
    }
  }
  try {
    const res = await get(`https://www.youtube.com/results?search_query=${encodeURIComponent(hermit.name)}&sp=EgIQAg%253D%253D`, { tries: 2 });
    const html = res.ok ? await res.text() : "";
    const hits = [...html.matchAll(/"channelRenderer":\{"channelId":"(UC[\w-]{22})","title":\{"simpleText":"([^"]+)"[\s\S]{0,4000}?"canonicalBaseUrl":"\/@([^"]+)"/g)];
    diag.push(`search:${res.status}/${hits.length}`);
    for (const [, id, title, handle] of hits) {
      if (norm(title) !== norm(hermit.name) && norm(handle) !== norm(hermit.name)) continue;
      const c = { id, handle: decodeURIComponent(handle), avatar: null, source: "search" };
      if (fresh(c)) yield c;
    }
  } catch (e) {
    diag.push(`search:${e.message}`);
  }
  if (previous?.channelId) {
    const c = { id: previous.channelId, handle: previous.handle, avatar: previous.avatar, source: "previous" };
    if (fresh(c)) yield c;
  }
}

async function isShort(videoId) {
  try {
    const res = await get(`https://www.youtube.com/shorts/${videoId}`, { method: "HEAD", redirect: "manual", tries: 1 });
    return res.status === 200;
  } catch {
    return false;
  }
}

async function buildHermit(hermit, previous, filter) {
  const diag = [];
  let best = null;
  for await (const c of channelCandidates(hermit, previous, diag)) {
    try {
      const res = await get(`https://www.youtube.com/feeds/videos.xml?channel_id=${c.id}`);
      if (!res.ok) { diag.push(`feed ${c.id}:${res.status}`); continue; }
      const { entries, channelTitle: parseFeedTitle } = parseFeed(await res.text());
      diag.push(`${c.source}→${c.id}:${entries.length}`);
      if (!best || entries.length > best.entries.length) best = { ch: c, entries, title: parseFeedTitle };
      // A real Hermit channel has a full feed; a near-empty one is usually the wrong channel.
      if (entries.length >= 3) break;
    } catch (e) {
      diag.push(`feed ${c.id}:${e.message}`);
    }
  }
  if (!best || !best.entries.length) throw new Error(`no videos found [${diag.join(" ")}]`);
  const { ch, entries } = best;
  if (filter) diag.push(`feed title "${best.title}"`);
  const base = {
    name: hermit.name,
    handle: ch.handle,
    channelId: ch.id,
    channelUrl: channelPageUrl(ch.handle),
    avatar: ch.avatar || (previous?.channelId === ch.id ? previous.avatar : null),
    source: ch.source,
    diag: diag.join(" "),
  };

  const toVideo = (e, short) => ({
    id: e.id,
    title: e.title,
    published: e.published,
    views: e.views,
    short,
    url: short ? `https://www.youtube.com/shorts/${e.id}` : `https://www.youtube.com/watch?v=${e.id}`,
    thumb: `https://i.ytimg.com/vi/${e.id}/hqdefault.jpg`,
  });
  // Shorts checks are cached between runs: known Shorts and known regular videos
  // from the last deploy skip the network check.
  const knownShorts = new Set(previous?.shortIds || []);
  const knownLong = new Set((previous?.videos || []).filter((v) => !v.short).map((v) => v.id));
  const shortCheck = async (id) => (knownShorts.has(id) ? true : knownLong.has(id) ? false : isShort(id));
  if (filter) return { ...base, ...(await filteredVideos(ch.id, entries, previous, filter, toVideo, shortCheck)) };
  const videos = [];
  const shorts = [];
  for (const e of entries) {
    if (videos.length >= PER_CHANNEL) break;
    if (!INCLUDE_SHORTS && (await shortCheck(e.id))) {
      shorts.push(e);
      continue;
    }
    videos.push(toVideo(e, false));
  }
  // If a Hermit has mostly been posting Shorts lately, fill the empty slots with them
  // rather than showing a half-empty card.
  for (const e of shorts) {
    if (videos.length >= PER_CHANNEL) break;
    videos.push(toVideo(e, true));
  }
  videos.sort((a, b) => new Date(b.published) - new Date(a.published));
  base.feedEntries = entries.length;
  base.shortsSkipped = shorts.length;
  base.shortIds = shorts.map((e) => e.id);
  return { ...base, videos };
}

// --- Title-filtered categories (e.g. a Life Series season: only "Final Life" videos) ---
// The RSS feed only holds a channel's 15 newest uploads, so matches are kept from run to
// run (via the last deploy's data) and backfilled from the channel's uploads playlist page,
// which lists about 100 videos. Playlist dates are relative ("2 weeks ago"), so those are
// approximate until the video shows up in the feed with its exact date.
const UNIT_SECONDS = { second: 1, minute: 60, hour: 3600, day: 86400, week: 604800, month: 2592000, year: 31536000 };

export function parsePlaylistPage(html, now = Date.now()) {
  const out = [];
  const ago = (chunk) => {
    const rel = chunk.slice(0, 8000).match(/"(?:text|content)":"[^"]*?(\d+) (second|minute|hour|day|week|month|year)s? ago"/);
    return rel ? new Date(now - Number(rel[1]) * UNIT_SECONDS[rel[2]] * 1000).toISOString() : null;
  };
  const unq = (t) => { try { return JSON.parse(`"${t}"`); } catch { return t; } };
  // Older page layout
  for (const chunk of html.split('"playlistVideoRenderer":').slice(1)) {
    const id = chunk.match(/^\{"videoId":"([\w-]{11})"/)?.[1];
    const title = chunk.match(/"title":\{"runs":\[\{"text":"((?:[^"\\]|\\.)*)"/)?.[1];
    if (id && title) out.push({ id, title: unq(title), published: ago(chunk), approx: true });
  }
  // Newer page layout
  for (const chunk of html.split('"lockupViewModel":').slice(1)) {
    const id = chunk.slice(0, 3000).match(/"contentId":"([\w-]{11})"/)?.[1];
    const title = chunk.match(/"title":\{"content":"((?:[^"\\]|\\.)*)"/)?.[1];
    if (id && title && !out.some((e) => e.id === id)) out.push({ id, title: unq(title), published: ago(chunk), approx: true });
  }
  return out;
}

async function filteredVideos(channelId, entries, previous, filter, toVideo, shortCheck) {
  const needle = filter.toLowerCase();
  const match = (t = "") => t.toLowerCase().includes(needle);
  const found = new Map();
  for (const v of previous?.videos || []) if (match(v.title)) found.set(v.id, v);
  let listed = "playlist failed";
  try {
    const res = await get(`https://www.youtube.com/playlist?list=UU${channelId.slice(2)}`, { tries: 2 });
    if (res.ok) {
      const html = await res.text();
      const page = parsePlaylistPage(html);
      listed = `playlist ${page.length} videos, ${page.filter((e) => match(e.title)).length} matching`;
      if (!page.length) listed += ` (page ${html.length}b, ${(html.match(/"videoId":"/g) || []).length} videoIds, keys: ${[...new Set(html.match(/"[a-zA-Z]+(?:Renderer|ViewModel)":/g) || [])].slice(0, 12).join(" ")})`;
      for (const e of page) {
        if (!match(e.title) || !e.published) continue;
        const old = found.get(e.id);
        if (!old) found.set(e.id, { ...toVideo({ ...e, views: null }, false), approx: true });
        else if (old.title !== e.title) found.set(e.id, { ...old, title: e.title });
      }
    }
  } catch {}
  for (const e of entries) if (match(e.title)) found.set(e.id, toVideo(e, false));
  console.log(`  [${filter}] ${channelId} ${previous?.name || ""}: feed ${entries.filter((e) => match(e.title)).length}/${entries.length} matching, ${listed}, ${found.size} kept`);
  const videos = [];
  for (const v of found.values()) if (INCLUDE_SHORTS || !(await shortCheck(v.id))) videos.push(v);
  videos.sort((a, b) => new Date(b.published) - new Date(a.published));
  return { videos: videos.slice(0, 40), feedEntries: entries.length, shortsSkipped: found.size - videos.length, shortIds: previous?.shortIds || [] };
}

async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
      }
    }),
  );
  return out;
}

async function loadJson(url, file) {
  if (url) {
    try {
      const res = await fetch(url, { headers: { "cache-control": "no-cache" } });
      if (res.ok) return await res.json();
    } catch {}
  }
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }
}

const DATA_DIR = path.join(ROOT, "site", "data");
// A channel in a title-filtered category keeps its own cache, separate from its normal one.
const prevKey = (channelId, filter) => (filter ? `${filter}|${channelId}` : channelId);

export async function main() {
  const categories = JSON.parse(await readFile(path.join(ROOT, "categories.json"), "utf8"));
  const base = (process.env.PREVIOUS_BASE_URL || "").replace(/\/?$/, "/");

  // Last deploy's data, keyed by channel id, for fallbacks and caches.
  const prevById = new Map();
  await pool(categories, 6, async (cat) => {
    const prev = await loadJson(process.env.PREVIOUS_BASE_URL ? `${base}data/${cat.id}.json` : null, path.join(DATA_DIR, `${cat.id}.json`));
    for (const ch of prev?.channels || []) if (ch.channelId) prevById.set(prevKey(ch.channelId, cat.titleFilter), ch);
  });

  const jobs = categories.flatMap((cat) =>
    cat.channels.map((ch) => ({
      cat: cat.id,
      filter: cat.titleFilter || null,
      ch: ch.handles?.length ? ch : { ...ch, handles: [`/channel/${ch.channelId}`], pinnedOnly: true },
    })),
  );

  let failures = 0;
  const attempt = async (ch, filter) => {
    const r = await buildHermit(ch, prevById.get(prevKey(ch.channelId, filter)), filter);
    if (filter) console.log(`  [${filter}] ${ch.name} → ${r.channelId}: ${r.diag}`);
    delete r.diag;
    delete r.source;
    return r;
  };
  const results = await pool(jobs, 6, async ({ cat, ch, filter }) => {
    const prev = prevById.get(prevKey(ch.channelId, filter));
    try {
      return await attempt(ch, filter);
    } catch (first) {
      await sleep(3000);
      try {
        return await attempt(ch, filter);
      } catch {}
      failures++;
      console.warn(`✗ [${cat}] ${ch.name}: ${first.message}${prev ? "  (kept previous data)" : ""}`);
      return prev
        ? { ...prev, name: ch.name, stale: true }
        : { name: ch.name, handle: ch.handles[0], channelId: ch.channelId, channelUrl: channelPageUrl(ch.handles[0]), videos: [], error: true };
    }
  });

  const generatedAt = new Date().toISOString();
  await mkdir(DATA_DIR, { recursive: true });
  const index = { generatedAt, categories: [], fresh: [] };
  let i = 0;
  for (const cat of categories) {
    const channels = results.slice(i, i + cat.channels.length);
    i += cat.channels.length;
    await writeFile(path.join(DATA_DIR, `${cat.id}.json`), JSON.stringify({ generatedAt, id: cat.id, name: cat.name, accent: cat.accent, titleFilter: cat.titleFilter || null, channels }));
    const vids = channels
      .flatMap((c) => (c.videos || []).map((v) => ({ ...v, channel: c.name, avatar: c.avatar || null, category: cat.id })))
      .sort((a, b) => new Date(b.published) - new Date(a.published));
    index.categories.push({ id: cat.id, name: cat.name, accent: cat.accent, titleFilter: cat.titleFilter || null, count: channels.length, latest: vids.slice(0, 4) });
    index.fresh.push(...vids.slice(0, 12));
    const bad = channels.filter((c) => c.error || c.stale).length;
    console.log(`${bad ? "!" : "✓"} ${cat.name.padEnd(24)} ${channels.length - bad}/${channels.length} channels refreshed`);
  }
  // A video can sit in two categories (a Hermit's Life Series episode); list it once.
  const seenFresh = new Set();
  index.fresh = index.fresh.filter((v) => !seenFresh.has(v.id) && seenFresh.add(v.id));
  index.fresh.sort((a, b) => new Date(b.published) - new Date(a.published));
  index.fresh = index.fresh.slice(0, 16);
  await writeFile(path.join(DATA_DIR, "index.json"), JSON.stringify(index));
  console.log(`\nWrote site/data/ — ${results.length - failures}/${results.length} channels refreshed.`);

  // Fail the build only if nothing at all came back (e.g. YouTube blocked the runner),
  // so a partial outage still deploys whatever did refresh.
  if (failures === results.length) process.exit(1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
