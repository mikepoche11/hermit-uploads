# Fresh Uploads

An unofficial page that shows the newest YouTube videos from a hand-picked set of channels, sorted into categories (Hermitcraft, RC & drones, Makers, and more). Every thumbnail links straight to the video on YouTube.

## How it works

- `categories.json` lists each category (`id`, `name`, `accent` color) and its channels (`name`, `channelId`, optional `handles`). Add, move or remove channels here.
- `scripts/build.mjs` reads each channel's public RSS feed (`youtube.com/feeds/videos.xml`, no API key needed), skips Shorts, and writes `site/data/index.json` plus one `site/data/<category>.json` per category.
- `site/` is a plain static page (HTML, CSS, JS, no framework). The home page shows the newest videos across everything and a tile per category; `#<category-id>` opens a category.
- `.github/workflows/deploy.yml` runs the build every hour and publishes `site/` to GitHub Pages.

Browsers can't read YouTube's RSS feeds directly (no CORS), which is why the fetch happens in the scheduled build instead of in the page.

## Adding a channel

Add `{"name": "Channel name", "channelId": "UC..."}` to a category's `channels`. The channel ID is in the channel's URL (`youtube.com/channel/UC...`) or in a Google Takeout `subscriptions.csv`. If you only know a handle, use `{"name": "...", "handles": ["handle"]}` and the build finds the channel (a legacy link like `youtube.com/somename` goes in as `"/somename"`).

## Title-filtered categories

A category with `"titleFilter": "Final Life"` only shows videos whose title contains that text (any case). Because the feed only holds each channel's 15 newest uploads, the build keeps matches from earlier runs and backfills from the channel's uploads playlist page; those backfilled dates are approximate until the video appears in the feed. `"temporary": true` is just a reminder; to retire such a category, delete its block from `categories.json`.

## Running locally

```bash
node scripts/build.mjs          # needs Node 18+, fetches videos into site/data/
python3 -m http.server -d site  # then open http://localhost:8000
```

Options: `VIDEOS_PER_CHANNEL=5`, `INCLUDE_SHORTS=1`.

## Hosting

GitHub Pages, with **Settings → Pages → Source** set to **GitHub Actions**. GitHub pauses scheduled workflows on repos with no activity for 60 days; if that happens, click **Enable workflow** in the Actions tab.
