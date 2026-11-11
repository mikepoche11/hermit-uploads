(() => {
  const $ = (s) => document.querySelector(s);
  const grid = $("#grid"), fresh = $("#fresh"), q = $("#q");
  let hermits = [];
  let sort = localGet("sort") || "recent";

  function localGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
  function localSet(k, v) { try { localStorage.setItem(k, v); } catch {} }

  const esc = (s = "") => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  function ago(iso) {
    if (!iso) return "";
    const s = (Date.now() - new Date(iso).getTime()) / 1000;
    const units = [["year", 31536000], ["month", 2592000], ["week", 604800], ["day", 86400], ["hour", 3600], ["minute", 60]];
    for (const [u, n] of units) {
      const v = Math.floor(s / n);
      if (v >= 1) return `${v} ${u}${v > 1 ? "s" : ""} ago`;
    }
    return "just now";
  }
  const views = (n) => (n == null ? "" : n >= 1e6 ? `${(n / 1e6).toFixed(1).replace(/\.0$/, "")}M views` : n >= 1e3 ? `${Math.round(n / 1e3)}K views` : `${n} views`);
  const isNew = (iso) => iso && Date.now() - new Date(iso).getTime() < 24 * 3600 * 1000;
  const latest = (h) => (h.videos?.[0]?.published ? new Date(h.videos[0].published).getTime() : 0);

  function avatar(h, cls = "av") {
    const initial = esc((h.name || "?")[0].toUpperCase());
    if (!h.avatar) return `<span class="${cls}" aria-hidden="true">${initial}</span>`;
    return `<img class="${cls}" src="${esc(h.avatar)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.outerHTML='<span class=&quot;${cls}&quot; aria-hidden=&quot;true&quot;>${initial}</span>'" />`;
  }

  function thumb(v, eager) {
    const badge = isNew(v.published) ? '<span class="badge">NEW</span>' : v.short ? '<span class="badge short">SHORT</span>' : "";
    return `<div class="thumb">${badge}
      <img src="${esc(v.thumb)}" alt="" ${eager ? "" : 'loading="lazy"'} referrerpolicy="no-referrer"
        onerror="if(!this.dataset.f){this.dataset.f=1;this.src='https://i.ytimg.com/vi/${esc(v.id)}/mqdefault.jpg'}" /></div>`;
  }

  const link = (v, cls, inner) =>
    `<a class="${cls}" href="${esc(v.url)}" target="_blank" rel="noopener" title="${esc(v.title)}">${inner}</a>`;

  function card(h) {
    const [first, ...rest] = h.videos || [];
    const body = first
      ? link(first, "feature", `${thumb(first)}<h4>${esc(first.title)}</h4><div class="vmeta">${[ago(first.published), views(first.views)].filter(Boolean).join(" · ")}</div>`) +
        (rest.length ? `<div class="minor">${rest.map((v) => link(v, "", `${thumb(v)}<h4>${esc(v.title)}</h4><div class="vmeta">${ago(v.published)}</div>`)).join("")}</div>` : "")
      : `<p class="note">Couldn't load videos this time. They'll show up after the next refresh.</p>`;
    return `<article class="card">
      <div class="card-head">${avatar(h)}
        <div class="meta"><h3>${esc(h.name)}</h3><div class="when">${first ? "Last upload " + ago(first.published) : "&nbsp;"}</div></div>
        <a class="chan" href="${esc(h.channelUrl)}" target="_blank" rel="noopener" aria-label="${esc(h.name)} on YouTube">Channel ↗</a>
      </div>${body}</article>`;
  }

  function renderFresh() {
    const all = hermits.flatMap((h) => (h.videos || []).map((v) => ({ v, h })));
    all.sort((a, b) => new Date(b.v.published) - new Date(a.v.published));
    fresh.innerHTML = all.slice(0, 10).map(({ v, h }, i) =>
      link(v, "fresh-card", `${thumb(v, i < 4)}<div class="who">${avatar(h)}${esc(h.name)} · ${ago(v.published)}</div><h3>${esc(v.title)}</h3>`)).join("");
  }

  function renderGrid() {
    const term = q.value.trim().toLowerCase();
    const list = hermits
      .filter((h) => !term || h.name.toLowerCase().includes(term) || (h.handle || "").toLowerCase().includes(term))
      .sort(sort === "az" ? (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) : (a, b) => latest(b) - latest(a));
    grid.innerHTML = list.map(card).join("");
    $("#empty").hidden = list.length > 0;
    $("#count").textContent = term ? `${list.length} of ${hermits.length}` : `${hermits.length} Hermits`;
  }

  function skeleton() {
    const sk = '<div class="skel" style="aspect-ratio:16/9"></div>';
    fresh.innerHTML = Array(5).fill(`<div>${sk}<div class="skel" style="height:14px;margin-top:10px;width:70%"></div></div>`).join("");
    grid.innerHTML = Array(6).fill(`<div class="card"><div class="card-head"><div class="skel av" style="box-shadow:none"></div><div class="skel" style="height:16px;flex:1"></div></div>${sk}</div>`).join("");
  }

  document.querySelectorAll(".seg button").forEach((b) => {
    b.setAttribute("aria-pressed", String(b.dataset.sort === sort));
    b.addEventListener("click", () => {
      sort = b.dataset.sort; localSet("sort", sort);
      document.querySelectorAll(".seg button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
      renderGrid();
    });
  });
  q.addEventListener("input", renderGrid);

  skeleton();
  fetch("data.json", { cache: "no-cache" })
    .then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); })
    .then((data) => {
      hermits = data.hermits || [];
      $("#updated").textContent = data.generatedAt ? `Updated ${ago(data.generatedAt)}` : "";
      renderFresh();
      renderGrid();
    })
    .catch(() => {
      fresh.innerHTML = "";
      grid.innerHTML = `<p class="note">The video list hasn't been built yet. Run <code>node scripts/build.mjs</code> or wait for the next scheduled refresh.</p>`;
    });
})();
