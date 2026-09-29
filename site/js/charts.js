// Hand-built SVG/canvas charts: grouped distribution (step lines) and scatter.
// Colors come from CSS custom properties (--s1..--s8), so light/dark mode is handled in CSS.
import { h, fmtNum, fmtInt } from "./util.js";

const SVGNS = "http://www.w3.org/2000/svg";
function s(tag, attrs = {}, ...kids) {
  const n = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) n.setAttribute(k, v);
  for (const k of kids) if (k != null) n.append(k instanceof Node ? k : document.createTextNode(String(k)));
  return n;
}
export const cssVar = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/** "Nice" tick values covering [lo, hi]. */
export function niceTicks(lo, hi, count = 6) {
  if (lo === hi) { lo -= 1; hi += 1; }
  const raw = (hi - lo) / count, mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(st => st >= raw) || 10 * mag;
  const start = Math.ceil(lo / step - 1e-9) * step, ticks = [];
  for (let v = start; v <= hi + step * 1e-9; v += step) ticks.push(+v.toFixed(10));
  return { ticks, step };
}

function legend(groups, kind = "line") {
  if (groups.length < 2) return null;
  return h("div", { class: "legend", role: "list" }, groups.map(g => h("span", { class: "key", role: "listitem" },
    kind === "line"
      ? h("span", { class: "swatch-line" + (g.dashed ? " dashed" : ""), style: { borderTopColor: `var(${g.color})` } })
      : h("span", { class: "swatch-dot", style: { background: `var(${g.color})` } }),
    `${g.label} (n=${fmtInt(g.n ?? g.values?.length ?? g.points?.length)})`)));
}

function tooltipEl(container) {
  const tip = h("div", { class: "tooltip", hidden: true, role: "status" });
  container.append(tip);
  return {
    show(x, y, head, rows) {
      tip.replaceChildren(h("div", { class: "t-head" }, head), ...rows.map(r => h("div", { class: "t-row" },
        h("span", { class: "t-key" + (r.dashed ? " dashed" : ""), style: { borderTopColor: `var(${r.color})` } }),
        h("b", {}, r.value), h("span", { class: "muted" }, r.label))));
      tip.hidden = false;
      const cw = container.clientWidth, tw = tip.offsetWidth;
      tip.style.left = `${Math.min(Math.max(0, x + 14), cw - tw)}px`;
      tip.style.top = `${Math.max(0, y - tip.offsetHeight - 10)}px`;
    },
    hide() { tip.hidden = true; },
  };
}

function axes(svg, { W, H, M, x, y, xt, yt, xLabel, yLabel, xFmt = fmtNum, yFmt = fmtNum }) {
  const g = s("g", { class: "axis" });
  for (const t of yt) {
    g.append(s("line", { class: "gridline", x1: M.l, x2: W - M.r, y1: y(t), y2: y(t) }));
    g.append(s("text", { x: M.l - 6, y: y(t) + 4, "text-anchor": "end" }, yFmt(t)));
  }
  g.append(s("line", { x1: M.l, x2: W - M.r, y1: H - M.b, y2: H - M.b }));
  for (const t of xt) {
    g.append(s("line", { x1: x(t), x2: x(t), y1: H - M.b, y2: H - M.b + 4 }));
    g.append(s("text", { x: x(t), y: H - M.b + 17, "text-anchor": "middle" }, xFmt(t)));
  }
  if (xLabel) g.append(s("text", { class: "axis-title", x: (M.l + W - M.r) / 2, y: H - 4, "text-anchor": "middle" }, xLabel));
  if (yLabel) g.append(s("text", { class: "axis-title", x: 12, y: M.t - 8 }, yLabel));
  svg.append(g);
}

/**
 * Distribution of one measure per group, drawn as step lines of "% of group" so groups of
 * different size compare fairly. groups: [{label, color: "--s1", dashed, values: number[]}]
 */
export function histogram(groups, { xLabel = "", unit = "" } = {}) {
  groups = groups.filter(g => g.values.length);
  const wrap = h("div", { class: "viz" });
  if (!groups.length) return h("div", { class: "empty" }, "No values for this measure in the current selection.");
  const all = groups.flatMap(g => g.values).sort((a, b) => a - b);
  // Trim extreme 0.2% tails for the domain so one outlier doesn't flatten the chart.
  const lo = all[Math.floor(all.length * .002)], hi = all[Math.ceil(all.length * .998) - 1];
  let { step } = niceTicks(lo, hi, 28);
  if (all.every(Number.isInteger)) step = Math.max(1, Math.round(step));
  const b0 = Math.floor(lo / step) * step, nb = Math.max(1, Math.ceil((hi - b0) / step + 1e-9));
  const bins = Array.from({ length: nb }, (_, i) => b0 + i * step);
  for (const g of groups) {
    g.n = g.values.length;
    g.counts = new Array(nb).fill(0);
    for (const v of g.values) {
      const i = Math.min(nb - 1, Math.max(0, Math.floor((v - b0) / step)));
      g.counts[i]++;
    }
    g.pct = g.counts.map(c => (100 * c) / g.n);
  }
  const W = 760, H = 340, M = { t: 26, r: 16, b: 42, l: 46 };
  const maxY = Math.max(...groups.flatMap(g => g.pct)) * 1.08 || 1;
  const x = v => M.l + ((v - b0) / (nb * step)) * (W - M.l - M.r);
  const y = v => H - M.b - (v / maxY) * (H - M.t - M.b);
  const svg = s("svg", { viewBox: `0 0 ${W} ${H}`, role: "img",
    "aria-label": `Distribution of ${xLabel} by group, as percent of each group` });
  axes(svg, { W, H, M, x, y, xt: niceTicks(b0, b0 + nb * step, 8).ticks.filter(t => t >= b0 && t <= b0 + nb * step),
    yt: niceTicks(0, maxY, 5).ticks, xLabel: xLabel + (unit ? ` (${unit})` : ""), yLabel: "% of group",
    yFmt: v => `${fmtNum(v, 1)}%` });
  for (const g of groups) {
    let d = `M${x(b0)},${y(0)}`;
    g.pct.forEach((p, i) => { d += `V${y(p)}H${x(b0 + (i + 1) * step)}`; });
    d += `V${y(0)}`;
    svg.append(s("path", { d, fill: "none", stroke: `var(${g.color})`, "stroke-width": 2,
      "stroke-dasharray": g.dashed ? "5 3" : null, "stroke-linejoin": "round" }));
  }
  const hair = s("line", { class: "hair", y1: M.t, y2: H - M.b, visibility: "hidden" });
  svg.append(hair);
  const hit = s("rect", { x: M.l, y: M.t, width: W - M.l - M.r, height: H - M.t - M.b, fill: "transparent", tabindex: 0 });
  svg.append(hit);
  wrap.append(legend(groups) || "", svg);
  const tip = tooltipEl(wrap);
  const at = i => {
    const cx = x(b0 + (i + .5) * step);
    hair.setAttribute("x1", cx); hair.setAttribute("x2", cx); hair.setAttribute("visibility", "visible");
    const r = svg.getBoundingClientRect(), scale = r.width / W;
    tip.show(cx * scale, M.t * scale + 20, `${fmtNum(b0 + i * step)} – ${fmtNum(b0 + (i + 1) * step)} ${unit}`,
      groups.map(g => ({ color: g.color, dashed: g.dashed, value: `${fmtNum(g.pct[i], 1)}%`, label: `${g.label} · ${fmtInt(g.counts[i])}` })));
  };
  let focusBin = 0;
  hit.addEventListener("pointermove", e => {
    const r = svg.getBoundingClientRect(), px = ((e.clientX - r.left) / r.width) * W;
    focusBin = Math.min(nb - 1, Math.max(0, Math.floor(((px - M.l) / (W - M.l - M.r)) * nb)));
    at(focusBin);
  });
  hit.addEventListener("pointerleave", () => { hair.setAttribute("visibility", "hidden"); tip.hide(); });
  hit.addEventListener("focus", () => at(focusBin));
  hit.addEventListener("blur", () => { hair.setAttribute("visibility", "hidden"); tip.hide(); });
  hit.addEventListener("keydown", e => {
    if (e.key === "ArrowRight") focusBin = Math.min(nb - 1, focusBin + 1);
    else if (e.key === "ArrowLeft") focusBin = Math.max(0, focusBin - 1);
    else return;
    e.preventDefault(); at(focusBin);
  });
  return wrap;
}

/**
 * Scatter of x vs y. More than three groups become small multiples (one panel per group),
 * because four or more overlaid hues are not reliably distinguishable.
 * groups: [{label, color, points: [[x, y, id], ...]}]
 */
export function scatter(groups, { xLabel, yLabel, xUnit = "", yUnit = "" }) {
  groups = groups.filter(g => g.points.length);
  if (!groups.length) return h("div", { class: "empty" }, "No people have both measures in the current selection.");
  const xs = groups.flatMap(g => g.points.map(p => p[0])), ys = groups.flatMap(g => g.points.map(p => p[1]));
  const ext = a => { let lo = Infinity, hi = -Infinity; for (const v of a) { if (v < lo) lo = v; if (v > hi) hi = v; } return [lo, hi]; };
  const [x0, x1] = ext(xs), [y0, y1] = ext(ys);
  const xt = niceTicks(x0, x1, 6), yt = niceTicks(y0, y1, 5);
  const dom = { x0: Math.min(x0, xt.ticks[0]), x1: Math.max(x1, xt.ticks.at(-1)), y0: Math.min(y0, yt.ticks[0]), y1: Math.max(y1, yt.ticks.at(-1)) };
  const facet = groups.length > 3;
  const panels = facet ? groups.map(g => [g]) : [groups];
  const out = h("div", {});
  if (!facet) out.append(legend(groups, "dot") || "");
  const grid = h("div", { class: facet ? "facets" : "" });
  for (const pg of panels) {
    const cell = h("div", {});
    if (facet) cell.append(h("p", { class: "facet-title" },
      h("span", { class: "swatch-dot", style: { width: "9px", height: "9px", borderRadius: "50%", background: `var(${pg[0].color})`, display: "inline-block" } }),
      `${pg[0].label} (n=${fmtInt(pg[0].points.length)})`));
    cell.append(scatterPanel(pg, dom, { xLabel, yLabel, xUnit, yUnit, compact: facet }));
    grid.append(cell);
  }
  out.append(grid);
  return out;
}

function scatterPanel(groups, dom, { xLabel, yLabel, xUnit, yUnit, compact }) {
  const W = compact ? 420 : 760, H = compact ? 300 : 420, M = { t: 24, r: 14, b: 42, l: 52 };
  const x = v => M.l + ((v - dom.x0) / (dom.x1 - dom.x0 || 1)) * (W - M.l - M.r);
  const y = v => H - M.b - ((v - dom.y0) / (dom.y1 - dom.y0 || 1)) * (H - M.t - M.b);
  const wrap = h("div", { class: "viz" });
  const svg = s("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": `Scatter plot of ${yLabel} against ${xLabel}` });
  axes(svg, { W, H, M, x, y, xt: niceTicks(dom.x0, dom.x1, compact ? 4 : 6).ticks, yt: niceTicks(dom.y0, dom.y1, 5).ticks,
    xLabel: xLabel + (xUnit ? ` (${xUnit})` : ""), yLabel: yLabel + (yUnit ? ` (${yUnit})` : "") });
  // Points go on a canvas (thousands of marks); axes and the hover ring stay in SVG.
  const canvas = h("canvas", { style: { position: "absolute", left: 0, top: 0, width: "100%", height: "100%", pointerEvents: "none" }, "aria-hidden": "true" });
  const ring = s("circle", { r: 6, fill: "none", stroke: "var(--text)", "stroke-width": 2, visibility: "hidden" });
  svg.append(ring);
  wrap.append(svg, canvas);
  const pts = groups.flatMap(g => g.points.map(p => ({ g, x: x(p[0]), y: y(p[1]), p })));
  const draw = () => {
    const r = svg.getBoundingClientRect();
    if (!r.width) return;
    const dpr = window.devicePixelRatio || 1, scale = r.width / W;
    canvas.width = Math.round(r.width * dpr); canvas.height = Math.round(r.height * dpr);
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr * scale, 0, 0, dpr * scale, 0, 0);
    ctx.globalAlpha = pts.length > 3000 ? .45 : .7;
    for (const g of groups) {
      ctx.fillStyle = cssVar(g.color);
      ctx.beginPath();
      for (const p of g.points) { const px = x(p[0]), py = y(p[1]); ctx.moveTo(px + 2.6, py); ctx.arc(px, py, 2.6, 0, Math.PI * 2); }
      ctx.fill();
    }
  };
  requestAnimationFrame(draw);
  const ro = new ResizeObserver(draw); ro.observe(svg);
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", draw);
  new MutationObserver(draw).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  const tip = tooltipEl(wrap);
  svg.addEventListener("pointermove", e => {
    const r = svg.getBoundingClientRect(), scale = r.width / W;
    const px = (e.clientX - r.left) / scale, py = (e.clientY - r.top) / scale;
    let best = null, bd = (24 / scale) ** 2; // nearest point within ~24 screen px
    for (const p of pts) { const d = (p.x - px) ** 2 + (p.y - py) ** 2; if (d < bd) { bd = d; best = p; } }
    if (!best) { ring.setAttribute("visibility", "hidden"); tip.hide(); return; }
    ring.setAttribute("cx", best.x); ring.setAttribute("cy", best.y); ring.setAttribute("visibility", "visible");
    tip.show(best.x * scale, best.y * scale, `${best.g.label} · subject ${best.p[2]}`, [
      { color: best.g.color, value: `${fmtNum(best.p[0])} ${xUnit}`, label: xLabel },
      { color: best.g.color, value: `${fmtNum(best.p[1])} ${yUnit}`, label: yLabel }]);
  });
  svg.addEventListener("pointerleave", () => { ring.setAttribute("visibility", "hidden"); tip.hide(); });
  return wrap;
}


/**
 * Horizontal dot plot: one row per item, a dot at the mean and a thin line for mean +/- 1 SD.
 * Bars would have to start at zero and hide the differences, so this uses dots.
 * rows: [{label, sub, mean, sd, n, color: "--s1", group?, extra?: [[k, v]]}]
 */
export function dotplot(rows, { unit = "", measure = "", minSd = false } = {}) {
  if (!rows.length) return h("div", { class: "empty" }, "Nothing to plot for this selection.");
  const rowH = 26, W = 760, M = { t: 14, r: 24, b: 40, l: 250 };
  const H = M.t + M.b + rows.length * rowH;
  const lo = Math.min(...rows.map(r => r.mean - (r.sd || 0))), hi = Math.max(...rows.map(r => r.mean + (r.sd || 0)));
  const pad = (hi - lo) * .04 || 1;
  const { ticks } = niceTicks(lo - pad, hi + pad, 6);
  const x0 = Math.min(lo - pad, ticks[0]), x1 = Math.max(hi + pad, ticks.at(-1));
  const x = v => M.l + ((v - x0) / (x1 - x0)) * (W - M.l - M.r);
  const y = i => M.t + i * rowH + rowH / 2;
  const wrap = h("div", { class: "viz" });
  const svg = s("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": `${measure} by group: mean and one standard deviation` });
  const g = s("g", { class: "axis" });
  for (const t of ticks) {
    g.append(s("line", { class: "gridline", x1: x(t), x2: x(t), y1: M.t, y2: H - M.b }));
    g.append(s("text", { x: x(t), y: H - M.b + 16, "text-anchor": "middle" }, fmtNum(t)));
  }
  g.append(s("text", { class: "axis-title", x: (M.l + W - M.r) / 2, y: H - 4, "text-anchor": "middle" }, `${measure}${unit ? ` (${unit})` : ""}, mean ± 1 SD`));
  svg.append(g);
  const trunc = (t, n) => (t.length > n ? t.slice(0, n - 1) + "…" : t);
  rows.forEach((r, i) => {
    const cy = y(i);
    const row = s("g", { tabindex: 0, class: "dot-row", "aria-label": `${r.label}: mean ${fmtNum(r.mean)} ${unit}, n ${fmtInt(r.n)}` });
    row.append(s("rect", { x: 0, y: cy - rowH / 2, width: W, height: rowH, fill: "transparent" }));
    row.append(s("text", { x: M.l - 8, y: cy + 4, "text-anchor": "end", fill: "var(--text)", "font-size": 12 }, trunc(r.label, 34)));
    if (r.sd) row.append(s("line", { x1: x(r.mean - r.sd), x2: x(r.mean + r.sd), y1: cy, y2: cy, stroke: `var(${r.color})`, "stroke-width": 2, "stroke-linecap": "round", opacity: .55 }));
    row.append(s("circle", { cx: x(r.mean), cy, r: 5, fill: `var(${r.color})`, stroke: "var(--surface)", "stroke-width": 2 }));
    row.append(s("text", { x: Math.min(W - 4, x(r.mean + (r.sd || 0)) + 8), y: cy + 4, fill: "var(--text-2)", "font-size": 11 }, fmtNum(r.mean, 1)));
    svg.append(row);
    r._el = row; r._cy = cy;
  });
  wrap.append(svg);
  const tip = tooltipEl(wrap);
  const show = r => {
    const box = svg.getBoundingClientRect(), k = box.width / W;
    tip.show(Math.min(x(r.mean), W - 200) * k, r._cy * k, r.label, [
      { color: r.color, value: `${fmtNum(r.mean, 1)} ${unit}`, label: "mean" },
      ...(r.sd ? [{ color: r.color, value: `${fmtNum(r.sd, 1)} ${unit}`, label: "SD" }] : []),
      { color: r.color, value: fmtInt(r.n), label: "people" },
      ...(r.extra || []).map(([k2, v]) => ({ color: r.color, value: v, label: k2 }))]);
  };
  rows.forEach(r => {
    r._el.addEventListener("pointerenter", () => show(r));
    r._el.addEventListener("focus", () => show(r));
    r._el.addEventListener("pointerleave", () => tip.hide());
    r._el.addEventListener("blur", () => tip.hide());
  });
  return wrap;
}
