#!/usr/bin/env node
// Fetches each Hermit's latest YouTube uploads from YouTube's public RSS feeds
// (no API key needed) and writes site/data.json for the static page to render.
//
//   node scripts/build.mjs
//
// Env vars (all optional):
//   VIDEOS_PER_HERMIT   how many videos to keep per Hermit (default 3)
//   INCLUDE_SHORTS      "1" to keep YouTube Shorts (default: skip them)
//   PREVIOUS_DATA_URL   URL of the currently deployed data.json; used as a
//                       fallback for any Hermit whose feed fails this run

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PER_HERMIT = Number(process.env.VIDEOS_PER_HERMIT || 3);
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

// Channel IDs to try for a Hermit, best guess first: a pinned channelId, then each
// handle in hermits.json, then a YouTube channel search for their exact name.
async function* channelCandidates(hermit, previous, diag) {
  const seen = new Set();
  const fresh = (c) => c.id && !seen.has(c.id) && seen.add(c.id);
  if (hermit.channelId) {
    const c = { id: hermit.channelId, handle: hermit.handles[0], avatar: null, source: "pinned" };
    for (const handle of hermit.handles.slice(0, 1)) {
      try {
        const res = await get(channelPageUrl(handle), { tries: 2 });
        const page = res.ok ? parseChannelPage(await res.text()) : {};
        if (page.id === c.id) c.avatar = page.avatar;
      } catch {}
    }
    if (fresh(c)) yield c;
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

async function buildHermit(hermit, previous) {
  const diag = [];
  let best = null;
  for await (const c of channelCandidates(hermit, previous, diag)) {
    try {
      const res = await get(`https://www.youtube.com/feeds/videos.xml?channel_id=${c.id}`);
      if (!res.ok) { diag.push(`feed ${c.id}:${res.status}`); continue; }
      const { entries } = parseFeed(await res.text());
      diag.push(`${c.source}→${c.id}:${entries.length}`);
      if (!best || entries.length > best.entries.length) best = { ch: c, entries };
      // A real Hermit channel has a full feed; a near-empty one is usually the wrong channel.
      if (entries.length >= 3) break;
    } catch (e) {
      diag.push(`feed ${c.id}:${e.message}`);
    }
  }
  if (!best || !best.entries.length) throw new Error(`no videos found [${diag.join(" ")}]`);
  const { ch, entries } = best;
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
  const videos = [];
  const shorts = [];
  for (const e of entries) {
    if (videos.length >= PER_HERMIT) break;
    if (!INCLUDE_SHORTS && (await isShort(e.id))) {
      shorts.push(e);
      continue;
    }
    videos.push(toVideo(e, false));
  }
  // If a Hermit has mostly been posting Shorts lately, fill the empty slots with them
  // rather than showing a half-empty card.
  for (const e of shorts) {
    if (videos.length >= PER_HERMIT) break;
    videos.push(toVideo(e, true));
  }
  videos.sort((a, b) => new Date(b.published) - new Date(a.published));
  base.feedEntries = entries.length;
  base.shortsSkipped = shorts.length;
  return { ...base, videos };
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

async function loadPrevious() {
  const sources = [];
  if (process.env.PREVIOUS_DATA_URL) sources.push(process.env.PREVIOUS_DATA_URL);
  for (const src of sources) {
    try {
      const res = await fetch(src, { headers: { "cache-control": "no-cache" } });
      if (res.ok) return await res.json();
    } catch {}
  }
  try {
    return JSON.parse(await readFile(path.join(ROOT, "site", "data.json"), "utf8"));
  } catch {
    return null;
  }
}

export async function main() {
  const hermits = JSON.parse(await readFile(path.join(ROOT, "hermits.json"), "utf8"));
  const previous = await loadPrevious();
  const prevByName = new Map((previous?.hermits || []).map((h) => [h.name, h]));

  let failures = 0;
  const attempt = async (h) => {
    const r = await buildHermit(h, prevByName.get(h.name));
    console.log(`✓ ${h.name.padEnd(18)} @${r.handle} ${r.channelId}  ${r.videos.length} videos (feed ${r.feedEntries}, shorts ${r.shortsSkipped})  [${r.diag}]`);
    delete r.diag;
    return r;
  };
  const results = await pool(hermits, 3, async (h) => {
    const prev = prevByName.get(h.name);
    try {
      return await attempt(h);
    } catch (first) {
      // One slower retry, after the rest of the pool has had a go.
      await sleep(4000);
      try {
        return await attempt(h);
      } catch {}
      const e = first;
      failures++;
      console.warn(`✗ ${h.name.padEnd(18)} ${e.message}${prev ? "  (kept previous data)" : ""}`);
      return prev ? { ...prev, stale: true } : { name: h.name, handle: h.handles[0], channelUrl: channelPageUrl(h.handles[0]), videos: [], error: true };
    }
  });

  await mkdir(path.join(ROOT, "site"), { recursive: true });
  const data = { generatedAt: new Date().toISOString(), hermits: results };
  await writeFile(path.join(ROOT, "site", "data.json"), JSON.stringify(data, null, 2));
  console.log(`\nWrote site/data.json — ${results.length - failures}/${results.length} Hermits refreshed.`);

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
