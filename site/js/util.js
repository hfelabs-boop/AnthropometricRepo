// Small DOM, formatting, statistics and export helpers shared by every view.

/** Create an element. Children may be nodes or strings (strings become text nodes, never HTML). */
export function h(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "style" && typeof v === "object") Object.assign(node.style, v);
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
    else if (k === "dataset") Object.assign(node.dataset, v);
    else if (v === true) node.setAttribute(k, "");
    else node.setAttribute(k, v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function debounce(fn, ms = 150) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

const nf = new Intl.NumberFormat("en-US");
export function fmtInt(n) { return n == null ? "—" : nf.format(Math.round(n)); }
/** Format a measurement: integers stay integers, others get `digits` decimals. */
export function fmtNum(v, digits = 1) {
  if (v == null || Number.isNaN(v)) return "—";
  if (typeof v !== "number") return String(v);
  if (Number.isInteger(v) && Math.abs(v) >= 100) return nf.format(v);
  return v.toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: Number.isInteger(v) ? 0 : Math.min(digits, 1) });
}

/** Fixed decimals with thousands separators, for columns of statistics that should line up. */
export function fmtFixed(v, digits = 1) {
  if (v == null || Number.isNaN(v)) return "—";
  return v.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/** Quantile of a sorted numeric array (linear interpolation, R type 7). */
export function quantile(sorted, p) {
  if (!sorted.length) return null;
  const i = (sorted.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

export function describe(values) {
  const v = values.filter(x => x != null && !Number.isNaN(x)).sort((a, b) => a - b);
  const n = v.length;
  if (!n) return { n: 0 };
  const mean = v.reduce((a, b) => a + b, 0) / n;
  const sd = n > 1 ? Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : null;
  return { n, mean, sd, min: v[0], p5: quantile(v, .05), p25: quantile(v, .25), p50: quantile(v, .5),
           p75: quantile(v, .75), p95: quantile(v, .95), max: v[n - 1] };
}

/** Compare for sorting mixed values; nulls always last. */
export function compare(a, b, dir = 1) {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  if (typeof a === "number" && typeof b === "number") return (a - b) * dir;
  return String(a).localeCompare(String(b), "en", { numeric: true }) * dir;
}

export function toCSV(columns, rows) {
  const cell = v => {
    if (v == null) return "";
    const s = String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [columns.map(cell).join(","), ...rows.map(r => r.map(cell).join(","))].join("\n") + "\n";
}

export function download(filename, content, type = "text/csv;charset=utf-8") {
  const blob = content instanceof Blob ? content : new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = h("a", { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function toast(msg) {
  const t = h("div", { class: "notice", role: "status", style: {
    position: "fixed", bottom: "20px", left: "50%", transform: "translateX(-50%)", zIndex: 60,
    background: "var(--text)", color: "var(--surface)", border: "0", boxShadow: "var(--shadow)" } }, msg);
  document.body.append(t);
  setTimeout(() => t.remove(), 2200);
}

/** Read/write view state in the URL hash: #/view?key=value&... */
export function readHash() {
  const [path, qs = ""] = location.hash.replace(/^#\/?/, "").split("?");
  return { view: path || "catalog", params: new URLSearchParams(qs) };
}
export function writeHash(view, params, replace = true) {
  const qs = params.toString();
  const url = `#/${view}${qs ? "?" + qs : ""}`;
  if (url === location.hash) return;
  if (replace) history.replaceState(null, "", url);
  else location.hash = url;
}

/** A small sortable, paginated table. `rows` are arrays aligned with `columns`. */
export function dataTable({ columns, rows, numeric = new Set(), pageSize = 50, sort = null, labels = {}, wrap = new Set(),
                            cellRender = null, onSort = null }) {
  const state = { sort: sort || { col: -1, dir: 1 }, page: 0 };
  const root = h("div");
  function render() {
    let data = rows;
    if (state.sort.col >= 0) {
      const c = state.sort.col, d = state.sort.dir;
      data = [...rows].sort((a, b) => compare(a[c], b[c], d));
    }
    const pages = Math.max(1, Math.ceil(data.length / pageSize));
    state.page = Math.min(state.page, pages - 1);
    const slice = data.slice(state.page * pageSize, (state.page + 1) * pageSize);
    const head = h("tr", {}, columns.map((c, i) => {
      const arrow = state.sort.col === i ? (state.sort.dir > 0 ? "▲" : "▼") : "↕";
      return h("th", {
        class: "sortable" + (numeric.has(c) ? " num" : ""), scope: "col", tabindex: 0,
        "aria-sort": state.sort.col === i ? (state.sort.dir > 0 ? "ascending" : "descending") : "none",
        onclick: () => toggle(i), onkeydown: e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(i); } },
      }, labels[c] || c, h("span", { class: "arrow", "aria-hidden": "true" }, arrow));
    }));
    const body = slice.map(r => h("tr", {}, r.map((v, i) => {
      const c = columns[i];
      const content = cellRender ? cellRender(c, v, r) : (typeof v === "number" ? fmtNum(v, 2) : (v ?? "—"));
      return h("td", { class: (numeric.has(c) || typeof v === "number" ? "num" : "") + (wrap.has(c) ? " wrap" : "") }, content);
    })));
    const table = h("div", { class: "table-wrap" }, h("table", { class: "data" }, h("thead", {}, head), h("tbody", {}, body)));
    const pager = h("div", { class: "pager" },
      `${fmtInt(data.length)} row${data.length === 1 ? "" : "s"}` + (pages > 1 ? ` · page ${state.page + 1} of ${pages}` : ""),
      pages > 1 ? [
        h("button", { class: "btn small", type: "button", disabled: state.page === 0, onclick: () => { state.page = 0; render(); } }, "«"),
        h("button", { class: "btn small", type: "button", disabled: state.page === 0, onclick: () => { state.page--; render(); } }, "‹ Prev"),
        h("button", { class: "btn small", type: "button", disabled: state.page >= pages - 1, onclick: () => { state.page++; render(); } }, "Next ›"),
        h("button", { class: "btn small", type: "button", disabled: state.page >= pages - 1, onclick: () => { state.page = pages - 1; render(); } }, "»"),
      ] : null);
    root.replaceChildren(table, pager);
  }
  function toggle(i) {
    state.sort = state.sort.col === i ? { col: i, dir: -state.sort.dir } : { col: i, dir: numeric.has(columns[i]) ? -1 : 1 };
    state.page = 0;
    onSort?.(state.sort);
    render();
  }
  render();
  return root;
}

// ---- distribution of a group from its mean / SD / reported percentiles -------------------------------
const Z95 = 1.6448536269514722;
const erf = x => { const t = 1 / (1 + .3275911 * Math.abs(x)), y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - .284496736) * t + .254829592) * t * Math.exp(-x * x); return x >= 0 ? y : -y; };
const Phi = z => .5 * (1 + erf(z / Math.SQRT2));

/** Quantile function of a row linear in z through (p5, p50, p95); rows without percentiles are normal (mean ± 1.645 SD). */
export function rowDist(r) {
  const m = r.mean, sd = r.sd, a = r.p5, b = r.p50, c = r.p95;
  if (a != null && c != null && a < c) {
    const rep = b != null && b >= a && b <= c;
    const mid = Math.min(Math.max(rep ? b : m != null && m >= a && m <= c ? m : (a + c) / 2, a + 1e-9), c - 1e-9);
    return { a, m: mid, c, reported: rep };
  }
  return m != null && sd ? { a: m - Z95 * sd, m, c: m + Z95 * sd, reported: false } : null;
}

/** [p5, p50, p95] of the n-weighted mixture of the groups, or null if no group has a usable distribution. */
export function mixPercentiles(rows, weight = r => r.n_total ?? r.n ?? 0) {
  const ds = rows.map(r => ({ d: rowDist(r), w: weight(r) })).filter(x => x.d && x.w > 0);
  if (!ds.length) return null;
  if (ds.length === 1) return [ds[0].d.a, ds[0].d.m, ds[0].d.c];
  const W = ds.reduce((t, x) => t + x.w, 0);
  const cdf = x => ds.reduce((t, { d, w }) => t + w * Phi(x < d.m ? -Z95 * (d.m - x) / (d.m - d.a) : Z95 * (x - d.m) / (d.c - d.m)), 0) / W;
  const lo0 = Math.min(...ds.map(x => x.d.a - 3 * (x.d.m - x.d.a))), hi0 = Math.max(...ds.map(x => x.d.c + 3 * (x.d.c - x.d.m)));
  return [.05, .5, .95].map(p => { let lo = lo0, hi = hi0; for (let i = 0; i < 60; i++) { const x = (lo + hi) / 2; if (cdf(x) < p) lo = x; else hi = x; } return (lo + hi) / 2; });
}
