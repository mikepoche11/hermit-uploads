(() => {
  const $ = (s, el = document) => el.querySelector(s);
  const view = $("#view"), nav = $("#nav");
  let index = null;
  const cache = new Map();
  let sort = localGet("sort") || "recent";

  function localGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
  function localSet(k, v) { try { localStorage.setItem(k, v); } catch {} }

  const esc = (s = "") => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  function ago(iso) {
    if (!iso) return "";
    const s = (Date.now() - new Date(iso).getTime()) / 1000;
    for (const [u, n] of [["year", 31536000], ["month", 2592000], ["week", 604800], ["day", 86400], ["hour", 3600], ["minute", 60]]) {
      const v = Math.floor(s / n);
      if (v >= 1) return `${v} ${u}${v > 1 ? "s" : ""} ago`;
    }
    return "just now";
  }
  const views = (n) => (n == null ? "" : n >= 1e6 ? `${(n / 1e6).toFixed(1).replace(/\.0$/, "")}M views` : n >= 1e3 ? `${Math.round(n / 1e3)}K views` : `${n} views`);
  const isNew = (iso) => iso && Date.now() - new Date(iso).getTime() < 24 * 3600 * 1000;
  const latest = (c) => (c.videos?.[0]?.published ? new Date(c.videos[0].published).getTime() : 0);

  function avatar(name, src, cls = "av") {
    const initial = esc((name || "?").trim()[0]?.toUpperCase() || "?");
    if (!src) return `<span class="${cls}" aria-hidden="true">${initial}</span>`;
    return `<img class="${cls}" src="${esc(src)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.outerHTML='<span class=&quot;${cls}&quot; aria-hidden=&quot;true&quot;>${initial}</span>'" />`;
  }
  function thumb(v, eager) {
    const badge = isNew(v.published) ? '<span class="badge">NEW</span>' : v.short ? '<span class="badge short">SHORT</span>' : "";
    return `<div class="thumb">${badge}<img src="${esc(v.thumb)}" alt="" ${eager ? "" : 'loading="lazy"'} referrerpolicy="no-referrer"
      onerror="if(!this.dataset.f){this.dataset.f=1;this.src='https://i.ytimg.com/vi/${esc(v.id)}/mqdefault.jpg'}" /></div>`;
  }
  const link = (v, cls, inner) => `<a class="${cls}" href="${esc(v.url)}" target="_blank" rel="noopener" title="${esc(v.title)}">${inner}</a>`;
  const catById = (id) => index?.categories.find((c) => c.id === id);

  function freshCard(v, i, showCat) {
    const cat = showCat && catById(v.category);
    return link(v, "fresh-card", `${thumb(v, i < 4)}<div class="who">${avatar(v.channel, v.avatar)}<span>${esc(v.channel)} · ${ago(v.published)}</span></div><h3>${esc(v.title)}</h3>${cat ? `<span class="tag" style="--c:${esc(cat.accent)}">${esc(cat.name)}</span>` : ""}`);
  }

  function channelCard(c) {
    const [first, ...rest] = c.videos || [];
    const body = first
      ? link(first, "feature", `${thumb(first)}<h4>${esc(first.title)}</h4><div class="vmeta">${[ago(first.published), views(first.views)].filter(Boolean).join(" · ")}</div>`) +
        (rest.length ? `<div class="minor">${rest.map((v) => link(v, "", `${thumb(v)}<h4>${esc(v.title)}</h4><div class="vmeta">${ago(v.published)}</div>`)).join("")}</div>` : "")
      : `<p class="note">No videos to show right now. They'll appear after the next refresh.</p>`;
    return `<article class="card">
      <div class="card-head">${avatar(c.name, c.avatar)}
        <div class="meta"><h3>${esc(c.name)}</h3><div class="when">${first ? "Last upload " + ago(first.published) : "&nbsp;"}</div></div>
        <a class="chan" href="${esc(c.channelUrl)}" target="_blank" rel="noopener" aria-label="${esc(c.name)} on YouTube">Channel ↗</a>
      </div>${body}</article>`;
  }

  function renderNav(active) {
    nav.innerHTML = `<a href="#" class="pill${active ? "" : " on"}">All</a>` +
      index.categories.map((c) => `<a href="#${esc(c.id)}" class="pill${c.id === active ? " on" : ""}" style="--c:${esc(c.accent)}">${esc(c.name)}</a>`).join("");
    const on = $(".pill.on", nav);
    if (on) on.scrollIntoView({ block: "nearest", inline: "center" });
  }

  function setAccent(cat) {
    document.documentElement.style.setProperty("--cat", cat ? cat.accent : "#28a65b");
    document.body.dataset.cat = cat ? cat.id : "";
  }

  function renderHome() {
    setAccent(null);
    renderNav(null);
    document.title = "Fresh Uploads";
    const total = index.categories.reduce((n, c) => n + c.count, 0);
    view.innerHTML = `
      <section class="intro">
        <h1>What's new</h1>
        <p class="muted">The latest from ${total} channels in ${index.categories.length} categories · updated ${ago(index.generatedAt)}</p>
      </section>
      <section aria-labelledby="fresh-h">
        <div class="section-head"><h2 id="fresh-h">Fresh across everything</h2></div>
        <div class="fresh-row">${index.fresh.map((v, i) => freshCard(v, i, true)).join("")}</div>
      </section>
      <section aria-labelledby="cats-h">
        <div class="section-head"><h2 id="cats-h">Categories</h2></div>
        <div class="tiles">${index.categories.map(tile).join("")}</div>
      </section>`;
  }

  function tile(c) {
    const imgs = c.latest.slice(0, 4);
    const mosaic = imgs.map((v) => `<img src="${esc(v.thumb)}" alt="" loading="lazy" referrerpolicy="no-referrer" />`).join("") +
      Array(Math.max(0, 4 - imgs.length)).fill("<span></span>").join("");
    return `<a class="tile" href="#${esc(c.id)}" style="--c:${esc(c.accent)}">
      <div class="mosaic">${mosaic}</div>
      <div class="tile-body"><h3>${esc(c.name)}</h3>
      <span class="muted">${c.count} channel${c.count === 1 ? "" : "s"}${c.latest[0] ? " · newest " + ago(c.latest[0].published) : ""}</span></div></a>`;
  }

  async function loadCat(id) {
    if (!cache.has(id)) {
      const r = await fetch(`data/${encodeURIComponent(id)}.json`, { cache: "no-cache" });
      if (!r.ok) throw new Error(r.status);
      cache.set(id, await r.json());
    }
    return cache.get(id);
  }

  async function renderCategory(id) {
    const meta = catById(id);
    if (!meta) { location.hash = ""; return; }
    setAccent(meta);
    renderNav(id);
    document.title = `${meta.name} · Fresh Uploads`;
    view.innerHTML = `<section class="intro"><h1>${esc(meta.name)}</h1><p class="muted">${meta.count} channels · loading…</p></section>${skeleton()}`;
    let data;
    try { data = await loadCat(id); } catch {
      view.innerHTML = `<p class="note">Couldn't load ${esc(meta.name)}. Try refreshing the page.</p>`;
      return;
    }
    if (location.hash.slice(1) !== id) return; // navigated away while loading
    const vids = data.channels.flatMap((c) => (c.videos || []).map((v) => ({ ...v, channel: c.name, avatar: c.avatar })))
      .sort((a, b) => new Date(b.published) - new Date(a.published)).slice(0, 10);
    view.innerHTML = `
      <section class="intro cat-intro">
        <div><h1>${esc(meta.name)}</h1><p class="muted">${data.channels.length} channels · updated ${ago(data.generatedAt)}</p></div>
        <div class="controls">
          <label class="search">
            <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
            <input id="q" type="search" placeholder="Find a channel" autocomplete="off" aria-label="Filter channels by name" />
          </label>
          <div class="seg" role="group" aria-label="Sort channels">
            <button data-sort="recent" aria-pressed="${sort === "recent"}">Newest</button>
            <button data-sort="az" aria-pressed="${sort === "az"}">A–Z</button>
          </div>
        </div>
      </section>
      <section aria-labelledby="fresh-h">
        <div class="section-head"><h2 id="fresh-h">Newest in ${esc(meta.name)}</h2></div>
        <div class="fresh-row">${vids.map((v, i) => freshCard(v, i, false)).join("")}</div>
      </section>
      <section aria-labelledby="all-h">
        <div class="section-head"><h2 id="all-h">All channels</h2><span id="count" class="muted"></span></div>
        <div id="grid" class="grid"></div>
        <p id="empty" class="empty" hidden>No channel matches that name.</p>
      </section>`;
    const q = $("#q");
    const draw = () => {
      const term = q.value.trim().toLowerCase();
      const list = data.channels
        .filter((c) => !term || c.name.toLowerCase().includes(term))
        .sort(sort === "az" ? (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) : (a, b) => latest(b) - latest(a));
      $("#grid").innerHTML = list.map(channelCard).join("");
      $("#empty").hidden = list.length > 0;
      $("#count").textContent = term ? `${list.length} of ${data.channels.length}` : "";
    };
    q.addEventListener("input", draw);
    view.querySelectorAll(".seg button").forEach((b) => b.addEventListener("click", () => {
      sort = b.dataset.sort; localSet("sort", sort);
      view.querySelectorAll(".seg button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
      draw();
    }));
    draw();
  }

  function skeleton() {
    const sk = '<div class="skel" style="aspect-ratio:16/9"></div>';
    return `<div class="grid">${Array(6).fill(`<div class="card"><div class="card-head"><div class="skel av" style="box-shadow:none"></div><div class="skel" style="height:16px;flex:1"></div></div>${sk}</div>`).join("")}</div>`;
  }

  function route() {
    const id = decodeURIComponent(location.hash.slice(1));
    window.scrollTo(0, 0);
    if (!id) renderHome(); else renderCategory(id);
  }

  view.innerHTML = skeleton();
  fetch("data/index.json", { cache: "no-cache" })
    .then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); })
    .then((d) => { index = d; window.addEventListener("hashchange", route); route(); })
    .catch(() => {
      view.innerHTML = `<p class="note">The video lists haven't been built yet. Run <code>node scripts/build.mjs</code> or wait for the next hourly refresh.</p>`;
    });
})();
