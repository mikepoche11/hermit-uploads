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
      if (res.status >= 500 || (res.status === 404 && url.includes("/feeds/"))) {
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

async function resolveChannel(hermit, previous) {
  let found = { id: hermit.channelId || null, avatar: null, handle: hermit.handles[0] };
  for (const handle of hermit.handles) {
    try {
      const res = await get(`https://www.youtube.com/@${handle}`, { tries: 2 });
      if (!res.ok) continue;
      const page = parseChannelPage(await res.text());
      if (page.id && (!found.id || found.id === page.id)) {
        found = { id: page.id, avatar: page.avatar, handle };
        break;
      }
    } catch {
      /* try next handle */
    }
  }
  if (!found.id && previous?.channelId) found.id = previous.channelId;
  if (!found.avatar && previous?.avatar) found.avatar = previous.avatar;
  return found;
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
  const ch = await resolveChannel(hermit, previous);
  const base = {
    name: hermit.name,
    handle: ch.handle,
    channelId: ch.id,
    channelUrl: `https://www.youtube.com/@${ch.handle}`,
    avatar: ch.avatar,
  };
  if (!ch.id) throw new Error(`could not resolve channel for ${hermit.name} (tried @${hermit.handles.join(", @")})`);

  const res = await get(`https://www.youtube.com/feeds/videos.xml?channel_id=${ch.id}`);
  if (!res.ok) throw new Error(`feed ${res.status} for ${hermit.name}`);
  const { entries } = parseFeed(await res.text());

  const videos = [];
  for (const e of entries) {
    if (videos.length >= PER_HERMIT) break;
    if (!INCLUDE_SHORTS && (await isShort(e.id))) continue;
    videos.push({
      id: e.id,
      title: e.title,
      published: e.published,
      views: e.views,
      url: `https://www.youtube.com/watch?v=${e.id}`,
      thumb: `https://i.ytimg.com/vi/${e.id}/hqdefault.jpg`,
    });
  }
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
  const results = await pool(hermits, 4, async (h) => {
    const prev = prevByName.get(h.name);
    try {
      const r = await buildHermit(h, prev);
      console.log(`✓ ${h.name.padEnd(18)} @${r.handle}  ${r.videos.length} videos`);
      return r;
    } catch (e) {
      failures++;
      console.warn(`✗ ${h.name.padEnd(18)} ${e.message}${prev ? "  (kept previous data)" : ""}`);
      return prev ? { ...prev, stale: true } : { name: h.name, handle: h.handles[0], channelUrl: `https://www.youtube.com/@${h.handles[0]}`, videos: [], error: true };
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
