// State store and build pipeline of the Digital human tab. Pure: no DOM, no three.js (tested in Node, tests/human3d/shell-state.test.mjs).
//
// The store is a plain object (`state`, readable by panels; changed only through the functions the shell hands out) plus on/emit.
// Events: profile, body, rig, pose, posture, selection, display, units, theme, quality, busy, notices.
// The pipeline turns a profile into a rig: fitBody -> buildRig -> swap into the viewport. Rapid profile changes are debounced and a
// newer request always wins (a finished but stale build is thrown away and disposed). Errors never leave the tab blank: a failed fit
// falls back to a synthetic body with a visible notice, a failed rig keeps the previous one.

export const LENGTH_UNITS = Object.freeze(["mm", "cm", "in"]);
export const DISPLAY_KEYS = Object.freeze(["skin", "skeleton", "joints", "labels", "landmarks", "com", "xray", "grid", "strain", "sight"]);
export const DEFAULT_DISPLAY = Object.freeze({ skin: true, skeleton: false, joints: false, labels: false, landmarks: false, com: false, xray: false, grid: true, strain: false, sight: false });
export const SELECTION_KINDS = Object.freeze(["joint", "object", "landmark", "handle"]);

/** Selection {kind, id} or null; anything else (unknown kind, empty id) is rejected with a TypeError. */
export function normaliseSelection(sel) {
  if (sel == null) return null;
  if (typeof sel !== "object" || !SELECTION_KINDS.includes(sel.kind) || (typeof sel.id !== "string" && typeof sel.id !== "number") || String(sel.id) === "") {
    throw new TypeError(`A selection is { kind: ${SELECTION_KINDS.join(" | ")}, id } or null.`);
  }
  return { kind: sel.kind, id: String(sel.id) };
}
export const sameSelection = (a, b) => (a == null && b == null) || (!!a && !!b && a.kind === b.kind && a.id === b.id);

// ---------------------------------------------------------------------------------------------------------------------
// preferences (units, display toggles, quality): localStorage is optional and can throw (private mode, blocked site data)
const PREFS_KEY = "hm-prefs";
/** The skins the figure can wear: the realistic scanned-and-rigged body (realskin.js, the default) or the procedural mannequin (body.js). */
export const SKIN_STYLES = Object.freeze(["realistic", "mannequin"]);

export function loadPrefs(storage) {
  const out = {};
  try {
    storage ??= globalThis.localStorage; // the getter itself throws when site data is blocked, so it is read inside the try
    const raw = JSON.parse(storage?.getItem(PREFS_KEY) ?? "null");
    if (!raw || typeof raw !== "object") return out;
    if (LENGTH_UNITS.includes(raw.units)) out.units = raw.units;
    if (raw.quality === "low" || raw.quality === "high") out.quality = raw.quality;
    if (SKIN_STYLES.includes(raw.skinStyle)) out.skinStyle = raw.skinStyle;
    if (raw.display && typeof raw.display === "object") {
      out.display = {};
      for (const k of DISPLAY_KEYS) if (typeof raw.display[k] === "boolean") out.display[k] = raw.display[k];
    }
  } catch { /* no storage or corrupt JSON: defaults */ }
  return out;
}
/**
 * The display flags worth remembering: what the user chose. `auto` maps a flag to the value it had before the shell switched it on by
 * itself (bones and markers when no skin could be built) and that the user has not touched since; those flags are saved as they were,
 * so a fallback of one session does not become the default of the next.
 */
export const prefsDisplay = (display, auto) => ({ ...display, ...(auto ?? {}) });
/**
 * Joint markers and bones are depth-tested, so an opaque skin hides them (and they cannot be hovered or clicked). While either is shown
 * with the skin the shell therefore renders the skin see-through, as if X-ray were on. `d` = { skin, skeleton, joints } as drawn.
 */
export const impliedXray = (d) => !!d.skin && !!(d.skeleton || d.joints);
export function savePrefs(state, storage) {
  try {
    storage ??= globalThis.localStorage;
    storage?.setItem(PREFS_KEY, JSON.stringify({ units: state.units, quality: state.qualityChoice ?? undefined, skinStyle: state.skinStyle, display: state.display }));
    return true;
  } catch { return false; }
}

// ---------------------------------------------------------------------------------------------------------------------
export function createStore(initial = {}) {
  const prefs = initial.prefs ?? {};
  const state = {
    profile: null, body: null, rig: null, selection: null,
    units: prefs.units ?? "mm",
    display: { ...DEFAULT_DISPLAY, ...(prefs.display ?? {}) },
    posture: { id: null, name: "Neutral standing" },
    theme: { dark: false },
    quality: prefs.quality ?? "high", qualityChoice: prefs.quality ?? null,
    skinStyle: prefs.skinStyle ?? "realistic",
    busy: false, notices: [],
  };
  const handlers = new Map();
  let noticeSeq = 0;

  function on(evt, fn) {
    if (typeof fn !== "function") throw new TypeError("on(event, fn): fn must be a function");
    if (!handlers.has(evt)) handlers.set(evt, new Set());
    handlers.get(evt).add(fn);
    return () => handlers.get(evt)?.delete(fn);
  }
  function emit(evt, data) {
    for (const fn of [...(handlers.get(evt) ?? [])]) {
      try { fn(data); } catch (e) { console.error(`Digital human: "${evt}" handler failed:`, e); }
    }
  }
  /** Replace-or-add a notice (same id replaces); returns its id. level: info | warn | error. `action` (optional, a name such as "retry") asks the shell for a button. */
  function addNotice({ id, level = "info", text, action }) {
    id = id ?? `n${++noticeSeq}`;
    const n = { id, level, text: String(text) };
    if (action) n.action = String(action);
    const i = state.notices.findIndex((x) => x.id === id);
    if (i >= 0) state.notices[i] = n; else state.notices.push(n);
    emit("notices", state.notices);
    return id;
  }
  function dismissNotice(id) {
    const i = state.notices.findIndex((x) => x.id === id);
    if (i < 0) return false;
    state.notices.splice(i, 1);
    emit("notices", state.notices);
    return true;
  }
  function setBusy(v) {
    v = !!v;
    if (state.busy === v) return;
    state.busy = v;
    emit("busy", v);
  }
  function setUnits(u) {
    if (!LENGTH_UNITS.includes(u)) throw new RangeError(`units must be one of ${LENGTH_UNITS.join(", ")}`);
    if (state.units === u) return;
    state.units = u;
    emit("units", u);
  }
  function setDisplay(partial) {
    let changed = false;
    for (const [k, v] of Object.entries(partial ?? {})) {
      if (!DISPLAY_KEYS.includes(k)) throw new RangeError(`unknown display option "${k}"`);
      if (typeof v !== "boolean") throw new TypeError(`display.${k} must be true or false`);
      if (state.display[k] !== v) { state.display[k] = v; changed = true; }
    }
    if (changed) emit("display", { ...state.display });
    return changed;
  }
  function select(sel) {
    const s = normaliseSelection(sel);
    if (sameSelection(state.selection, s)) return false;
    state.selection = s;
    emit("selection", s);
    return true;
  }
  return { state, on, emit, addNotice, dismissNotice, setBusy, setUnits, setDisplay, select };
}

// ---------------------------------------------------------------------------------------------------------------------
// no trailing full stop: the message is quoted inside "(...)." sentences
const msgOf = (e) => String(e?.message ?? e ?? "unknown error").replace(/\s+/g, " ").replace(/[.\s]+$/, "").slice(0, 200);

/**
 * profile -> body -> rig. deps: { fit(profile, {quality}), synthetic(profile), buildRig(body, {quality}), swap(rig, previousRig, body) }.
 * `swap` puts the new rig into the viewport (and removes the previous one from it); the pipeline disposes the previous rig afterwards.
 * Every call returns a promise that settles when the build that finally answers it (this one or a newer one) is done:
 * { ok, fallback, rig?, superseded? }; it never rejects.
 */
export function createPipeline(store, deps, { debounceMs = 150, setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout } = {}) {
  const { state } = store;
  let gen = 0, timer = null, disposed = false, running = 0;
  let waiters = [];
  const settle = (res) => { const w = waiters; waiters = []; for (const f of w) f(res); };

  /** Nothing could be built: one error with a Retry button (the "could not fit" warning would only repeat it). */
  function fail(e) {
    store.dismissNotice("fit");
    store.addNotice({ id: "build", level: "error", action: "retry", text: `The 3D model could not be built (${msgOf(e)}).` });
  }

  async function build() {
    const my = ++gen, profile = state.profile;
    running++;
    store.setBusy(true);
    const stale = () => disposed || my !== gen || timer != null; // a pending debounced request will answer instead
    try {
      let body, fallback = false;
      try {
        body = await deps.fit(profile, { quality: state.quality });
        if (!stale()) store.dismissNotice("fit");
      } catch (e) {
        if (stale()) return { ok: false, superseded: true };
        fallback = true;
        store.addNotice({ id: "fit", level: "warn", text: `Could not fit the profile (${msgOf(e)}). Showing a generic body.` });
        try { body = await deps.synthetic(profile); } catch (e2) {
          fail(e2);
          return { ok: false, fallback };
        }
      }
      if (stale()) return { ok: false, superseded: true };
      let rig;
      try {
        rig = await deps.buildRig(body, { quality: state.quality });
      } catch (e) {
        if (stale()) return { ok: false, superseded: true };
        if (fallback) { fail(e); return { ok: false, fallback }; }
        // the fitted body broke the rig: retry once with the synthetic body so the tab is never empty
        fallback = true;
        store.addNotice({ id: "fit", level: "warn", text: `Could not build the model from this profile (${msgOf(e)}). Showing a generic body.` });
        try { body = await deps.synthetic(profile); rig = await deps.buildRig(body, { quality: state.quality }); } catch (e2) {
          fail(e2);
          return { ok: false, fallback };
        }
      }
      if (stale()) { try { rig?.dispose?.(); } catch { /* nothing to free */ } return { ok: false, superseded: true }; }
      store.dismissNotice("build");
      const previous = state.rig;
      try { await deps.swap(rig, previous, body); } catch (e) {
        try { rig?.dispose?.(); } catch { /* ignore */ }
        store.addNotice({ id: "build", level: "error", action: "retry", text: `The 3D model could not be shown (${msgOf(e)}).` });
        return { ok: false, fallback };
      }
      // state.body changes only now: when the swap fails, body and rig still belong together (the previous figure is still on the stage)
      state.body = body;
      store.emit("body", body);
      state.rig = rig;
      store.emit("rig", rig);
      try { previous?.dispose?.(); } catch (e) { console.error("Digital human: disposing the previous rig failed:", e); }
      return { ok: true, fallback, rig };
    } finally {
      running--;
      if (!stale()) store.setBusy(false);
    }
  }

  function run() {
    timer = null;
    build().then((res) => { if (!res.superseded) settle(res); });
  }

  return {
    /** Set the profile now (state + 'profile' event) and build after `debounceMs` of quiet (immediately with { immediate: true }). */
    setProfile(profile, { immediate = false } = {}) {
      if (!profile || typeof profile !== "object") return Promise.resolve({ ok: false });
      state.profile = profile;
      store.emit("profile", profile);
      return this.rebuild({ immediate });
    },
    /** Rebuild from the current profile (e.g. after a quality change). */
    rebuild({ immediate = true } = {}) {
      if (disposed || !state.profile) return Promise.resolve({ ok: false });
      const p = new Promise((res) => waiters.push(res));
      if (timer != null) clearTimeoutFn(timer);
      if (immediate) run(); else timer = setTimeoutFn(run, debounceMs);
      return p;
    },
    get pending() { return timer != null || running > 0; },
    dispose() {
      disposed = true;
      if (timer != null) clearTimeoutFn(timer);
      timer = null;
      settle({ ok: false, superseded: true });
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------------
/** Settle with `promise`, or reject with Error(`${what} did not answer within N seconds`) after `ms`. The late answer is ignored. */
export function withTimeout(promise, ms, what = "the request", { setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout } = {}) {
  let t;
  const timer = new Promise((_, reject) => { t = setTimeoutFn(() => reject(new Error(`${what} did not answer within ${ms >= 1000 ? `${Math.round(ms / 100) / 10} seconds` : `${Math.round(ms)} ms`}`)), ms); });
  return Promise.race([Promise.resolve(promise), timer]).finally(() => clearTimeoutFn(t));
}

/**
 * The profile the tab opens with: United States / Army / men / P50 through anthro.js (injected, so this stays testable), or a manual
 * 1755 mm, 80 kg man when the population data cannot be loaded or does not arrive within `timeoutMs` (a stalled connection, a captive
 * portal). Returns { profile, notice? }; never throws.
 */
export async function loadDefaultProfile(anthro, { country = "united-states", role = "army", sex = "M", percentile = 50, timeoutMs = 8000 } = {}) {
  try {
    return await withTimeout((async () => {
      const index = await anthro.loadIndex();
      const entry = index.populations.find((p) => p.country_id === country && p.role_id === role && p.sex === sex);
      if (!entry) throw new Error("the default population is not in the data index");
      const pop = await anthro.loadPopulation(entry);
      return { profile: anthro.percentileProfile(pop, { percentile }) };
    })(), timeoutMs, "the population data");
  } catch (e) {
    return {
      profile: anthro.manualProfile({ sex: "M", stature: 1755, mass: 80 }),
      notice: `Could not load the population data (${msgOf(e)}). Starting from a generic man, 1755 mm tall and 80 kg; pick another profile in the Profile tab.`,
    };
  }
}
