# Hermit Uploads

An unofficial fan page that shows every current Hermitcraft member with their three newest YouTube videos. Every thumbnail links straight to the video on YouTube.

## How it works

- `hermits.json` is the roster: each Hermit's display name and YouTube handle(s). Add, remove or fix members here.
- `scripts/build.mjs` reads each channel's public RSS feed (`youtube.com/feeds/videos.xml`, no API key needed), skips Shorts, and writes `site/data.json`.
- `site/` is a plain static page (HTML, CSS, JS, no framework) that renders `data.json`.
- `.github/workflows/deploy.yml` runs the build every hour and publishes `site/` to GitHub Pages, so the page stays current on its own.

Browsers can't read YouTube's RSS feeds directly (no CORS), which is why the fetch happens in the scheduled build instead of in the page.

## Hosting on GitHub Pages (free)

1. Create a new GitHub repository and push this folder to its `main` branch.
2. In the repo, open **Settings → Pages** and set **Source** to **GitHub Actions**.
3. Open the **Actions** tab and run **Refresh videos and deploy** once (or just push). The site appears at `https://<your-username>.github.io/<repo-name>/`.

After that it refreshes hourly. GitHub pauses scheduled workflows on repos with no activity for 60 days; if that happens, click **Enable workflow** in the Actions tab.

## Running locally

```bash
node scripts/build.mjs          # needs Node 18+, fetches videos into site/data.json
python3 -m http.server -d site  # then open http://localhost:8000
```

Options: `VIDEOS_PER_HERMIT=5`, `INCLUDE_SHORTS=1`.

## Fixing a Hermit that shows "Couldn't load videos"

The build log prints a ✓ or ✗ per Hermit. A ✗ usually means the handle in `hermits.json` is wrong. Find the right one on their YouTube channel (the `@name` in the URL) and update `handles`, or add `"channelId": "UC..."` to skip the lookup entirely.
