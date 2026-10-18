// Small DOM helpers shared by the shell and the panels of the Digital human tab (sliders, sections, badges, tab lists, toolbars).
// The unit helpers at the top are pure (tested in Node); everything else builds elements with h() from ../util.js.
// Styles: site/human.css (prefix hm-) on top of the site's tokens and classes (.btn, .seg, .tag, .notice, .panel, .input).
import { h, fmtNum } from "../util.js";

// ---------------------------------------------------------------------------------------------------------------------
// lengths: the model is in metres, the data and the UI in millimetres; the user picks what is displayed
const MM_PER = { mm: 1, cm: 10, in: 25.4 };
export const UNIT_LABEL = { mm: "mm", cm: "cm", in: "in" };

/** Millimetres -> value in `unit` (mm, cm, in). */
export function toUnit(mm, unit = "mm") {
  if (!(unit in MM_PER)) throw new RangeError(`unknown length unit "${unit}"`);
  return mm / MM_PER[unit];
}
/** Value in `unit` -> millimetres. */
export function fromUnit(v, unit = "mm") {
  if (!(unit in MM_PER)) throw new RangeError(`unknown length unit "${unit}"`);
  return v * MM_PER[unit];
}
/** Decimals worth showing for a length in `unit`: whole millimetres, tenths of a centimetre, hundredths of an inch. */
export const unitDigits = (unit) => (unit === "mm" ? 0 : unit === "cm" ? 1 : 2);
/** "1,755 mm", "175.5 cm", "69.09 in"; "—" for a missing value. `digits` overrides unitDigits. */
export function fmtLength(mm, unit = "mm", { digits, suffix = true } = {}) {
  if (mm == null || !Number.isFinite(mm)) return "—";
  const d = digits ?? unitDigits(unit);
  const v = toUnit(mm, unit);
  const s = v.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
  return suffix ? `${s} ${UNIT_LABEL[unit]}` : s;
}

// ---------------------------------------------------------------------------------------------------------------------
// icons (inline SVG, currentColor, decorative: the button carries the accessible name)
const ICONS = {
  camera: "M4 8h3l1.5-2h7L17 8h3v11H4zM12 17a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z",
  fit: "M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5",
  help: "M9.5 9a2.5 2.5 0 1 1 3.6 2.2c-.7.4-1.1.9-1.1 1.8M12 17v.01",
  chevron: "M8 10l4 4 4-4",
  close: "M6 6l12 12M18 6L6 18",
  panel: "M15 6l-6 6 6 6",
};
export function icon(name, size = 16) {
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", size);
  svg.setAttribute("height", size);
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  const p = document.createElementNS(NS, "path");
  p.setAttribute("d", ICONS[name] ?? ICONS.help);
  svg.append(p);
  svg.classList.add("hm-icon");
  return svg;
}

// ---------------------------------------------------------------------------------------------------------------------
let uid = 0;
/** A unique id for aria-labelledby / for= pairs. */
export const nextId = (prefix = "hm") => `${prefix}-${++uid}`;

/** A pill button. toggle: true gives aria-pressed. Returns the element; `el.setPressed(bool)` updates a toggle. */
export function chipButton({ label, title, icon: ic, toggle = false, pressed = false, onClick, className = "", ariaLabel }) {
  const el = h("button", { type: "button", class: `hm-chip ${className}`.trim(), title, "aria-label": ariaLabel }, ic ? icon(ic) : null, label != null ? h("span", {}, label) : null);
  if (toggle) el.setAttribute("aria-pressed", pressed ? "true" : "false");
  el.setPressed = (v) => el.setAttribute("aria-pressed", v ? "true" : "false");
  if (onClick) el.addEventListener("click", (e) => onClick(e, el));
  return el;
}

/**
 * A group of buttons of which exactly one is pressed (the site's .seg look). options: [{ value, label, title }].
 * Returns { el, set(value), get() }; onChange(value) fires on user input only.
 */
export function segmented({ label, options, value, onChange, className = "" }) {
  let cur = value;
  const buttons = options.map((o) => h("button", { type: "button", "aria-pressed": o.value === cur ? "true" : "false", title: o.title, dataset: { value: o.value },
    onclick: () => { if (cur !== o.value) { set(o.value); onChange?.(o.value); } } }, o.label));
  const el = h("div", { class: `seg hm-seg ${className}`.trim(), role: "group", "aria-label": label }, buttons);
  function set(v) {
    cur = v;
    for (const b of buttons) b.setAttribute("aria-pressed", b.dataset.value === String(v) ? "true" : "false");
  }
  return { el, set, get: () => cur };
}

/**
 * Roving tab stop for a set of controls (toolbar, tab list): one control is in the tab order, the arrow keys move between them.
 * Returns { refresh(), setStop(el) }. `orientation`: "horizontal" (Left/Right) or "both" (also Up/Down). Home / End jump to the ends,
 * the arrows wrap around, disabled controls are skipped. `onMove(el)` is called after the arrow keys moved the focus.
 */
export function roving(container, { selector = "button:not([disabled])", orientation = "horizontal", onMove } = {}) {
  const all = () => [...container.querySelectorAll(selector)];
  function setStop(el) { for (const i of all()) i.tabIndex = i === el ? 0 : -1; }
  /** Call after enabling / disabling controls: the tab stop must never sit on a disabled one (the whole group would be skipped). */
  function refresh() {
    const list = all().filter((i) => !i.disabled);
    if (!list.length) return;
    setStop(list.find((i) => i.getAttribute("aria-selected") === "true") ?? list.find((i) => i.tabIndex === 0) ?? list[0]);
  }
  container.addEventListener("keydown", (e) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const list = all().filter((i) => !i.disabled);
    const i = list.indexOf(document.activeElement);
    if (i < 0) return;
    const fwd = e.key === "ArrowRight" || (orientation === "both" && e.key === "ArrowDown"), back = e.key === "ArrowLeft" || (orientation === "both" && e.key === "ArrowUp");
    let n = -1;
    if (fwd) n = (i + 1) % list.length;
    else if (back) n = (i - 1 + list.length) % list.length;
    else if (e.key === "Home") n = 0;
    else if (e.key === "End") n = list.length - 1;
    if (n < 0) return;
    e.preventDefault();
    setStop(list[n]);
    list[n].focus();
    onMove?.(list[n]);
  });
  container.addEventListener("focusin", (e) => { if (all().includes(e.target)) setStop(e.target); });
  refresh();
  return { refresh, setStop };
}

/**
 * A WAI-ARIA tab list (automatic activation: arrow keys select). tabs: [{ id, label }]. Returns { el, select(id, { focus }), selected, tabEl(id),
 * tabId(id), panelId(id) }; the tab panels are created by the caller with `id = panelId(id)` and `aria-labelledby = tabId(id)`.
 * onSelect(id, again) also fires when the already selected tab is chosen again (again = true), so that a caller can run its first show from select().
 */
export function tablist({ label, tabs, selected, onSelect, idPrefix = "hm-tab" }) {
  let cur = selected ?? tabs[0].id;
  const tabId = (id) => `${idPrefix}-${id}`, panelId = (id) => `${idPrefix}-panel-${id}`;
  const els = new Map(tabs.map((t) => [t.id, h("button", { type: "button", role: "tab", id: tabId(t.id), class: "hm-tab", "aria-selected": t.id === cur ? "true" : "false",
    "aria-controls": panelId(t.id), tabindex: t.id === cur ? "0" : "-1", dataset: { tab: t.id }, onclick: () => select(t.id) }, t.label)]));
  const el = h("div", { class: "hm-tabs", role: "tablist", "aria-label": label, "aria-orientation": "horizontal" }, [...els.values()]);
  const rv = roving(el, { selector: '[role="tab"]', onMove: (btn) => select(btn.dataset.tab, { focus: false }) });
  // scroll the strip itself, never the page: scrollIntoView() also scrolls every ancestor (on a phone it jumped the page 173 px down at load)
  function reveal(b) {
    if (el.scrollWidth <= el.clientWidth) return;
    const a = b.getBoundingClientRect(), c = el.getBoundingClientRect();
    if (a.left < c.left) el.scrollLeft -= c.left - a.left + 8; else if (a.right > c.right) el.scrollLeft += a.right - c.right + 8;
  }
  function select(id, { focus = false } = {}) {
    if (!els.has(id)) return;
    for (const [k, b] of els) { b.setAttribute("aria-selected", k === id ? "true" : "false"); b.tabIndex = k === id ? 0 : -1; }
    if (focus) els.get(id).focus();
    reveal(els.get(id));
    if (id !== cur) { cur = id; onSelect?.(id); } else if (onSelect) onSelect(id, true);
  }
  return { el, select, get selected() { return cur; }, tabEl: (id) => els.get(id), tabId, panelId, refresh: rv.refresh };
}

// ---------------------------------------------------------------------------------------------------------------------
/** A collapsible section (a <details>). `body` can be nodes or strings. Returns the <details> element. */
export function section(title, body, { open = true, className = "", count } = {}) {
  return h("details", { class: `hm-section ${className}`.trim(), open: open ? true : null },
    h("summary", {}, h("span", {}, title), count != null ? h("span", { class: "tag outline" }, String(count)) : null),
    h("div", { class: "hm-section-body" }, body));
}

/** A small status label. kind: good | warn | bad | outline | "" (neutral). */
export function badge(text, kind = "", title) {
  return h("span", { class: `tag ${kind}`.trim(), title }, text);
}

/** Muted placeholder text for an empty region. */
export function emptyState(text, hint) {
  return h("div", { class: "hm-empty" }, h("p", {}, text), hint ? h("p", { class: "small muted" }, hint) : null);
}

/** An inline notice (the site's .notice). level: info | warn | error. Pass onDismiss for a close button, `action` ({ label, onClick }) for a button. */
export function notice(text, { level = "info", onDismiss, id, action } = {}) {
  const el = h("div", { class: `notice hm-notice hm-notice-${level}`, role: level === "error" ? "alert" : "status", dataset: id == null ? undefined : { id } },
    h("span", { class: "hm-notice-text" }, text),
    action ? h("button", { type: "button", class: "btn hm-notice-act", onclick: () => action.onClick() }, action.label) : null,
    onDismiss ? h("button", { type: "button", class: "hm-notice-x", "aria-label": "Dismiss this message", title: "Dismiss", onclick: () => onDismiss() }, icon("close", 14)) : null);
  return el;
}

/**
 * A labelled range slider with a number field, for joint angles, dimensions, ... Returns { el, input, number, set(value, { silent }), get() }.
 * onInput(value) fires while dragging, onChange(value) when the value is committed (release, Enter, blur). Values are clamped to [min, max].
 */
export function sliderRow({ label, min, max, step = 1, value = 0, unit = "", digits, onInput, onChange, hint, format, disabled = false, id }) {
  const base = id ?? nextId("hm-sl");
  const dg = digits ?? (step >= 1 ? 0 : Math.min(3, Math.ceil(-Math.log10(step))));
  const clamp = (v) => Math.min(max, Math.max(min, v));
  const show = (v) => (format ? format(v) : fmtNum(Number(v.toFixed(dg)), dg));
  const input = h("input", { type: "range", class: "hm-range", id: base, min, max, step, value, disabled: disabled ? true : null, "aria-valuetext": `${show(value)} ${unit}`.trim() });
  const number = h("input", { type: "number", class: "input hm-num", id: `${base}-n`, min, max, step, value: Number(value.toFixed(dg)), disabled: disabled ? true : null, "aria-label": `${label} value${unit ? ` in ${unit}` : ""}`, inputmode: "decimal" });
  const el = h("div", { class: "hm-slider" },
    h("div", { class: "hm-slider-head" }, h("label", { for: base, class: "hm-slider-label" }, label), hint ? h("span", { class: "hm-slider-hint small muted" }, hint) : null),
    h("div", { class: "hm-slider-ctl" }, input, number, unit ? h("span", { class: "hm-unit", "aria-hidden": "true" }, unit) : null));
  let cur = value;
  function set(v, { silent = true } = {}) {
    v = clamp(Number(v));
    if (!Number.isFinite(v)) return;
    cur = v;
    input.value = String(v);
    if (document.activeElement !== number) number.value = String(Number(v.toFixed(dg)));
    input.setAttribute("aria-valuetext", `${show(v)} ${unit}`.trim());
    if (!silent) onChange?.(v);
  }
  input.addEventListener("input", () => { cur = Number(input.value); number.value = String(Number(cur.toFixed(dg))); input.setAttribute("aria-valuetext", `${show(cur)} ${unit}`.trim()); onInput?.(cur); });
  input.addEventListener("change", () => { cur = Number(input.value); onChange?.(cur); });
  number.addEventListener("change", () => {
    const v = Number(number.value);
    if (number.value === "" || !Number.isFinite(v)) { number.value = String(Number(cur.toFixed(dg))); return; } // keep the old value
    set(v);
    number.value = String(Number(cur.toFixed(dg))); // show the clamped value even though the field still has focus (Enter)
    onInput?.(cur);
    onChange?.(cur);
  });
  return { el, input, number, set, get: () => cur };
}

/**
 * Fill a panel container with the "coming soon" placeholder the stub panels use. `live` (optional) is a function returning a short string;
 * it is shown under the text and refreshed on the events named in `refreshOn` (proves that the registry hands each panel a working ctx).
 * Returns the panel lifecycle object ({ dispose }).
 */
export function comingSoon(container, { title, blurb, ctx, live, refreshOn = ["profile", "rig", "pose", "selection"], detail }) {
  const status = h("p", { class: "hm-live small", role: "status" });
  container.replaceChildren(h("div", { class: "hm-soon" },
    h("h2", { class: "hm-panel-title" }, title),
    h("p", { class: "muted" }, blurb),
    h("p", {}, badge("Coming soon", "outline")),
    live ? status : null,
    detail ? h("details", { class: "small muted" }, h("summary", {}, "Technical detail"), h("p", {}, detail)) : null));
  const offs = [];
  const refresh = () => { if (live) status.textContent = live(); };
  if (live && ctx) for (const evt of refreshOn) offs.push(ctx.on(evt, refresh));
  refresh();
  return { dispose() { for (const f of offs) f(); } };
}
