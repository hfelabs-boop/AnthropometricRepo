// The state store, the profile -> rig build pipeline and the unit helpers of the Digital human shell (state.js, ui.js). No DOM, no WebGL.
// Run: node --import ./tests/human3d/register.mjs --test tests/human3d/shell-state.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import {
  createStore, createPipeline, loadDefaultProfile, withTimeout, loadPrefs, savePrefs, prefsDisplay, impliedXray, normaliseSelection, sameSelection, DEFAULT_DISPLAY, DISPLAY_KEYS, LENGTH_UNITS,
} from "../../site/js/human/state.js";
import { toUnit, fromUnit, fmtLength, unitDigits } from "../../site/js/human/ui.js";

const quiet = (fn) => async (...a) => { const e = console.error; console.error = () => {}; try { return await fn(...a); } finally { console.error = e; } };
const tick = () => new Promise((r) => setTimeout(r, 0));
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };

// ------------------------------------------------------------------------------------------------------------------ store
test("store: defaults, events, unsubscribe", () => {
  const s = createStore();
  assert.equal(s.state.units, "mm");
  assert.deepEqual(s.state.display, DEFAULT_DISPLAY);
  assert.equal(s.state.rig, null);
  assert.equal(s.state.selection, null);
  const seen = [];
  const off = s.on("units", (u) => seen.push(u));
  s.setUnits("cm");
  s.setUnits("cm"); // no change, no event
  s.setUnits("in");
  off();
  s.setUnits("mm");
  assert.deepEqual(seen, ["cm", "in"]);
  assert.throws(() => s.setUnits("ft"), /units must be one of/);
  assert.throws(() => s.on("x", null), TypeError);
  assert.deepEqual(LENGTH_UNITS, ["mm", "cm", "in"]);
});

test("store: a throwing handler does not stop the others or the emitter", quiet(() => {
  const s = createStore(), seen = [];
  s.on("pose", () => { throw new Error("boom"); });
  s.on("pose", (d) => seen.push(d));
  assert.doesNotThrow(() => s.emit("pose", 1));
  assert.deepEqual(seen, [1]);
}));

test("store: display toggles validate keys and values and only emit on change", () => {
  const s = createStore();
  let n = 0, last = null;
  s.on("display", (d) => { n++; last = d; });
  assert.equal(s.setDisplay({ skeleton: true }), true);
  assert.equal(s.setDisplay({ skeleton: true }), false);
  assert.equal(n, 1);
  assert.equal(last.skeleton, true);
  assert.notEqual(last, s.state.display, "listeners get a copy, not the live object");
  assert.throws(() => s.setDisplay({ wireframe: true }), /unknown display option/);
  assert.throws(() => s.setDisplay({ skin: "yes" }), TypeError);
  assert.equal(s.state.display.skin, true, "a rejected call changes nothing");
  assert.equal(DISPLAY_KEYS.length, 8);
});

test("store: selection model", () => {
  const s = createStore(), seen = [];
  s.on("selection", (x) => seen.push(x));
  assert.equal(s.select({ kind: "joint", id: "elbow_L" }), true);
  assert.equal(s.select({ kind: "joint", id: "elbow_L" }), false, "same selection: no event");
  assert.equal(s.select({ kind: "object", id: 7 }), true, "numeric ids are normalised to strings");
  assert.deepEqual(s.state.selection, { kind: "object", id: "7" });
  assert.equal(s.select(null), true);
  assert.equal(s.select(undefined), false, "clearing twice is not a change");
  assert.deepEqual(seen, [{ kind: "joint", id: "elbow_L" }, { kind: "object", id: "7" }, null]);
  for (const bad of [{ kind: "bone", id: "x" }, { kind: "joint" }, { kind: "joint", id: "" }, "joint", 5, { id: "x" }, { kind: "joint", id: {} }]) {
    assert.throws(() => s.select(bad), TypeError, JSON.stringify(bad));
  }
  assert.deepEqual(normaliseSelection({ kind: "handle", id: "hand_L", extra: 1 }), { kind: "handle", id: "hand_L" }, "extra fields are dropped");
  assert.equal(sameSelection(null, null), true);
  assert.equal(sameSelection({ kind: "joint", id: "a" }, null), false);
  assert.equal(sameSelection({ kind: "joint", id: "a" }, { kind: "landmark", id: "a" }), false);
});

test("store: notices are replaced by id, dismissed and announced", () => {
  const s = createStore();
  let n = 0;
  s.on("notices", () => n++);
  const id = s.addNotice({ level: "warn", text: "first" });
  s.addNotice({ id: "fit", level: "warn", text: "a" });
  s.addNotice({ id: "fit", level: "error", text: "b" });
  assert.equal(s.state.notices.length, 2);
  assert.deepEqual(s.state.notices.find((x) => x.id === "fit"), { id: "fit", level: "error", text: "b" });
  assert.equal(s.dismissNotice("fit"), true);
  assert.equal(s.dismissNotice("fit"), false);
  assert.equal(s.dismissNotice(id), true);
  assert.equal(s.state.notices.length, 0);
  assert.equal(n, 5);
  assert.equal(s.addNotice({ text: 42 }) && s.state.notices[0].text, "42", "text is always a string");
});

test("preferences: only valid values are taken, storage may be missing or throw", () => {
  const mem = new Map();
  const storage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) };
  assert.deepEqual(loadPrefs(storage), {});
  const s = createStore();
  s.setUnits("in"); s.setDisplay({ joints: true, labels: true });
  s.state.qualityChoice = "low";
  assert.equal(savePrefs(s.state, storage), true);
  const p = loadPrefs(storage);
  assert.equal(p.units, "in"); assert.equal(p.quality, "low"); assert.equal(p.display.joints, true);
  const s2 = createStore({ prefs: p });
  assert.equal(s2.state.units, "in"); assert.equal(s2.state.display.labels, true); assert.equal(s2.state.display.skin, true);
  mem.set("hm-prefs", JSON.stringify({ units: "furlong", quality: "ultra", display: { skin: "no", joints: true, hax: true } }));
  assert.deepEqual(loadPrefs(storage), { display: { joints: true } });
  mem.set("hm-prefs", "{not json");
  assert.deepEqual(loadPrefs(storage), {});
  mem.set("hm-prefs", "null");
  assert.deepEqual(loadPrefs(storage), {});
  const bad = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("quota"); } };
  assert.deepEqual(loadPrefs(bad), {});
  assert.equal(savePrefs(s.state, bad), false);
  assert.deepEqual(loadPrefs(undefined), {}, "no localStorage at all (Node)");
  // a browser with blocked site data throws from the localStorage getter itself
  Object.defineProperty(globalThis, "localStorage", { configurable: true, get() { throw new DOMException("denied", "SecurityError"); } });
  try {
    assert.deepEqual(loadPrefs(), {});
    assert.equal(savePrefs(s.state), false);
  } finally { delete globalThis.localStorage; }
});

// ------------------------------------------------------------------------------------------------------------------ pipeline
function rigOf(name) { return { name, disposed: 0, dispose() { this.disposed++; } }; }
function harness(over = {}) {
  const store = createStore();
  const calls = [];
  const timers = [];
  const deps = {
    fit: async (p) => { calls.push(["fit", p.id]); return { body: p.id }; },
    synthetic: async (p) => { calls.push(["synthetic", p.id]); return { body: "generic", for: p.id }; },
    buildRig: async (b) => { calls.push(["rig", b.body]); return rigOf(b.body); },
    swap: async (rig, prev, body) => { calls.push(["swap", rig.name, prev?.name ?? null, body.body]); },
    ...over,
  };
  const pipe = createPipeline(store, deps, { debounceMs: 50, setTimeoutFn: (f, ms) => { const t = { f, ms, cancelled: false }; timers.push(t); return t; }, clearTimeoutFn: (t) => { t.cancelled = true; } });
  const fire = () => { const live = timers.filter((t) => !t.cancelled); timers.length = 0; for (const t of live) t.f(); };
  return { store, calls, deps, pipe, timers, fire };
}

test("pipeline: profile -> fit -> rig -> swap, events in order, previous rig disposed after the swap", async () => {
  const { store, calls, pipe } = harness();
  const events = [];
  for (const e of ["profile", "body", "rig", "busy"]) store.on(e, (d) => events.push([e, e === "busy" ? d : d?.name ?? d?.id ?? d?.body]));
  const r1 = await pipe.setProfile({ id: "A" }, { immediate: true });
  assert.equal(r1.ok, true); assert.equal(r1.fallback, false);
  assert.deepEqual(calls, [["fit", "A"], ["rig", "A"], ["swap", "A", null, "A"]]);
  assert.equal(store.state.rig.name, "A");
  assert.deepEqual(events.map((e) => e[0]), ["profile", "busy", "body", "rig", "busy"]);
  assert.deepEqual(events.filter((e) => e[0] === "busy").map((e) => e[1]), [true, false]);
  const first = store.state.rig;
  const r2 = await pipe.setProfile({ id: "B" }, { immediate: true });
  assert.equal(r2.ok, true);
  assert.equal(first.disposed, 1, "previous rig disposed");
  assert.equal(store.state.rig.disposed, 0);
  assert.deepEqual(calls.at(-1), ["swap", "B", "A", "B"], "swap gets the previous rig so it can remove it from the viewport");
  assert.equal(store.state.profile.id, "B");
});

test("pipeline: rapid profile changes are debounced into one build of the last profile", async () => {
  const { store, calls, pipe, fire, timers } = harness();
  const ps = ["a", "b", "c", "d"].map((id) => pipe.setProfile({ id }));
  assert.equal(store.state.profile.id, "d", "the state follows immediately");
  assert.equal(timers.filter((t) => !t.cancelled).length, 1, "one pending timer");
  assert.equal(timers.find((t) => !t.cancelled).ms, 50);
  assert.equal(calls.length, 0, "nothing built yet");
  assert.equal(pipe.pending, true);
  fire();
  const results = await Promise.all(ps);
  assert.ok(results.every((r) => r.ok && r.rig === results[0].rig), "every caller is answered by the single build");
  assert.deepEqual(calls.filter((c) => c[0] === "fit"), [["fit", "d"]]);
  assert.equal(pipe.pending, false);
});

test("pipeline: a newer request wins; the stale build is thrown away and its rig disposed", async () => {
  const slow = deferred();
  const log = [];
  const { store, calls, pipe } = harness({
    buildRig: async (b) => { log.push(b.body); if (b.body === "slow") await slow.promise; return rigOf(b.body); },
  });
  const pSlow = pipe.setProfile({ id: "slow" }, { immediate: true });
  await tick();
  const pFast = pipe.setProfile({ id: "fast" }, { immediate: true });
  const fast = await pFast;
  assert.equal(fast.ok, true);
  assert.equal(store.state.rig.name, "fast");
  slow.resolve();
  const s = await pSlow; // answered by the build that finally won
  await tick(); await tick(); // give a (wrongly) surviving slow build the chance to land
  assert.equal(s.ok, true); assert.equal(s.rig.name, "fast");
  assert.equal(store.state.rig.name, "fast", "the late slow rig did not replace the newer one");
  assert.equal(calls.filter((c) => c[0] === "swap").length, 1, "the stale build never reached the viewport");
  assert.deepEqual(log, ["slow", "fast"]);
  assert.equal(store.state.busy, false);
});

test("pipeline: stale rigs are disposed", async () => {
  const slow = deferred(), made = [];
  const { store, pipe } = harness({ buildRig: async (b) => { const r = rigOf(b.body); made.push(r); if (b.body === "slow") await slow.promise; return r; } });
  const pSlow = pipe.setProfile({ id: "slow" }, { immediate: true });
  await tick();
  await pipe.setProfile({ id: "fast" }, { immediate: true });
  slow.resolve();
  await pSlow;
  await tick();
  const slowRig = made.find((r) => r.name === "slow");
  assert.equal(slowRig.disposed, 1, "the stale rig was disposed, not leaked");
  assert.equal(made.find((r) => r.name === "fast").disposed, 0);
  assert.equal(store.state.rig.name, "fast");
});

test("pipeline: a fit failure falls back to the synthetic body with the documented notice", async () => {
  const { store, pipe, calls } = harness({ fit: async () => { throw new Error("no stature in this profile"); } });
  const r = await pipe.setProfile({ id: "X" }, { immediate: true });
  assert.equal(r.ok, true); assert.equal(r.fallback, true);
  assert.equal(store.state.rig.name, "generic");
  assert.deepEqual(store.state.notices.map((n) => [n.id, n.level, n.text]), [["fit", "warn", "Could not fit the profile (no stature in this profile). Showing a generic body."]]);
  assert.ok(calls.some((c) => c[0] === "synthetic"));
  // the next good profile clears the notice
  const { store: s2, pipe: p2 } = harness({ fit: async (p) => { if (p.id === "bad") throw new Error("x"); return { body: p.id }; } });
  await p2.setProfile({ id: "bad" }, { immediate: true });
  assert.equal(s2.state.notices.length, 1);
  await p2.setProfile({ id: "good" }, { immediate: true });
  assert.equal(s2.state.notices.length, 0, "the warning goes away when the fit works again");
});

test("pipeline: a long or odd error message is flattened and truncated", async () => {
  const { store, pipe } = harness({ fit: async () => { throw new Error("line one\n   line two " + "x".repeat(500)); } });
  await pipe.setProfile({ id: "X" }, { immediate: true });
  const t = store.state.notices[0].text;
  assert.ok(!t.includes("\n") && t.length < 320, t.length);
  const { store: s2, pipe: p2 } = harness({ fit: async () => { throw "just a string"; } });
  await p2.setProfile({ id: "X" }, { immediate: true });
  assert.match(s2.state.notices[0].text, /\(just a string\)/);
  const { store: s3, pipe: p3 } = harness({ fit: async () => { throw undefined; } });
  await p3.setProfile({ id: "X" }, { immediate: true });
  assert.match(s3.state.notices[0].text, /\(unknown error\)/);
});

test("pipeline: when the fitted body breaks the rig, retry once with the generic body", async () => {
  const { store, pipe } = harness({ buildRig: async (b) => { if (b.body !== "generic") throw new Error("bad joint offsets"); return rigOf("generic"); } });
  const r = await pipe.setProfile({ id: "X" }, { immediate: true });
  assert.equal(r.ok, true); assert.equal(r.fallback, true);
  assert.equal(store.state.rig.name, "generic");
  assert.match(store.state.notices[0].text, /Could not build the model from this profile \(bad joint offsets\)\. Showing a generic body\./);
});

test("pipeline: when nothing can be built the previous rig stays and an error notice explains", async () => {
  const { store, pipe } = harness();
  await pipe.setProfile({ id: "A" }, { immediate: true });
  const keep = store.state.rig;
  const broken = harness({ fit: async () => { throw new Error("f"); }, synthetic: async () => { throw new Error("no generic body"); } });
  broken.store.state.rig = keep;
  const r = await broken.pipe.setProfile({ id: "B" }, { immediate: true });
  assert.equal(r.ok, false);
  assert.equal(broken.store.state.rig, keep, "the old rig is untouched");
  assert.equal(keep.disposed, 0);
  assert.ok(broken.store.state.notices.some((n) => n.level === "error" && /could not be built \(no generic body\)/.test(n.text)));
  assert.equal(broken.store.state.busy, false, "busy is reset");
  const r2 = await harness({ buildRig: async () => { throw new Error("rig exploded"); }, synthetic: async () => ({ body: "generic" }) }).pipe.setProfile({ id: "C" }, { immediate: true });
  assert.equal(r2.ok, false);
});

test("pipeline: a swap that throws disposes the new rig and reports", async () => {
  const made = [];
  const { store, pipe } = harness({ buildRig: async () => { const r = rigOf("r"); made.push(r); return r; }, swap: async () => { throw new Error("viewport is gone"); } });
  const r = await pipe.setProfile({ id: "A" }, { immediate: true });
  assert.equal(r.ok, false);
  assert.equal(made[0].disposed, 1);
  assert.equal(store.state.rig, null);
  assert.match(store.state.notices.at(-1).text, /could not be shown \(viewport is gone\)/);
});

test("pipeline: a failed build is ONE error with a Retry action (the fit warning would only repeat it), and Retry works", async () => {
  let broken = true;
  const { store, pipe } = harness({
    fit: async () => { throw new Error("no stature in this profile"); },
    synthetic: async () => { if (broken) throw new Error("the generic body (synthetic.js) is not available."); return { body: "generic" }; },
  });
  const r = await pipe.setProfile({ id: "X" }, { immediate: true });
  assert.equal(r.ok, false);
  assert.deepEqual(store.state.notices.map((n) => [n.id, n.level, n.action]), [["build", "error", "retry"]], "no leftover 'Could not fit' warning next to the error");
  assert.equal(store.state.notices[0].text, "The 3D model could not be built (the generic body (synthetic.js) is not available).", "no '.).' in the message");
  broken = false; // the module is available again; the shell's Retry button calls rebuild()
  const r2 = await pipe.rebuild();
  assert.equal(r2.ok, true);
  assert.equal(store.state.rig.name, "generic");
  assert.deepEqual(store.state.notices.map((n) => n.id), ["fit"], "the error is gone, the generic-body warning stays");
  // the same for a rig that cannot be built from either body
  const h2 = harness({ buildRig: async () => { throw new Error("rig.js is not available"); } });
  await h2.pipe.setProfile({ id: "Y" }, { immediate: true });
  assert.deepEqual(h2.store.state.notices.map((n) => [n.id, n.action]), [["build", "retry"]]);
});

test("pipeline: state.body and state.rig change together, only after the swap succeeded", async () => {
  const seen = [];
  let fail = false;
  const { store, pipe } = harness({ swap: async () => { if (fail) throw new Error("no viewport"); } });
  store.on("body", (b) => seen.push(["body", b.body, store.state.rig?.name ?? null]));
  store.on("rig", (r) => seen.push(["rig", r.name, store.state.body.body]));
  await pipe.setProfile({ id: "A" }, { immediate: true });
  fail = true;
  const r = await pipe.setProfile({ id: "B" }, { immediate: true });
  assert.equal(r.ok, false);
  assert.equal(store.state.body.body, "A", "the failed swap left the body the previous rig was built from");
  assert.equal(store.state.rig.name, "A");
  assert.deepEqual(seen, [["body", "A", null], ["rig", "A", "A"]], "'body' is emitted right before 'rig' and not at all for the failed build");
  assert.equal(store.state.notices.at(-1).action, "retry");
});

test("notices: an action is kept, replaced with the notice and left out when empty", () => {
  const s = createStore();
  s.addNotice({ id: "a", text: "x", action: "retry" });
  s.addNotice({ id: "b", text: "y" });
  assert.equal(s.state.notices[0].action, "retry");
  assert.equal("action" in s.state.notices[1], false);
  s.addNotice({ id: "a", text: "x2" });
  assert.equal("action" in s.state.notices[0], false, "replacing a notice replaces its action too");
});

test("default profile: the notice does not end in '.).' when the underlying message ends in a full stop", async () => {
  const anthro = { loadIndex: async () => { throw new Error("Could not reach api/v1/index.json: Failed to fetch."); }, manualProfile: (o) => ({ id: "manual", ...o }) };
  const { notice } = await loadDefaultProfile(anthro);
  assert.match(notice, /\(Could not reach api\/v1\/index\.json: Failed to fetch\)\. Starting from/);
});

test("pipeline: invalid profiles are refused, dispose stops everything", async () => {
  const { store, pipe, calls, fire } = harness();
  for (const bad of [null, undefined, 5, "x"]) assert.deepEqual(await pipe.setProfile(bad), { ok: false });
  assert.equal(store.state.profile, null);
  assert.deepEqual(await pipe.rebuild(), { ok: false }, "nothing to rebuild without a profile");
  const p = pipe.setProfile({ id: "A" });
  pipe.dispose();
  const r = await p;
  assert.equal(r.ok, false);
  fire();
  await tick();
  assert.equal(calls.length, 0, "the pending build never ran");
  assert.deepEqual(await pipe.setProfile({ id: "B" }), { ok: false }, "a disposed pipeline stays inert");
  // disposed while a build is in flight: result discarded, rig disposed
  const slow = deferred(), made = [];
  const h2 = harness({ buildRig: async () => { await slow.promise; const r = rigOf("late"); made.push(r); return r; } });
  const p2 = h2.pipe.setProfile({ id: "A" }, { immediate: true });
  await tick();
  h2.pipe.dispose();
  slow.resolve();
  await p2;
  await tick();
  assert.equal(h2.store.state.rig, null);
  assert.equal(made[0].disposed, 1);
});

test("pipeline: rebuild() re-runs the current profile (quality change)", async () => {
  const { store, pipe, calls } = harness();
  await pipe.setProfile({ id: "A" }, { immediate: true });
  store.state.quality = "low";
  const r = await pipe.rebuild();
  assert.equal(r.ok, true);
  assert.equal(calls.filter((c) => c[0] === "fit").length, 2);
});

// ------------------------------------------------------------------------------------------------------------------ default profile
test("default profile: United States / Army / men / P50 through anthro.js", async () => {
  const seen = {};
  const anthro = {
    loadIndex: async () => ({ populations: [{ country_id: "united-states", role_id: "navy", sex: "M" }, { country_id: "united-states", role_id: "army", sex: "F" }, { country_id: "united-states", role_id: "army", sex: "M", id: "the one" }] }),
    loadPopulation: async (e) => { seen.entry = e; return { pop: true }; },
    percentileProfile: (pop, o) => { seen.opts = o; return { label: "profile", pop }; },
    manualProfile: () => { throw new Error("should not be used"); },
  };
  const r = await loadDefaultProfile(anthro);
  assert.equal(r.notice, undefined);
  assert.equal(seen.entry.id, "the one");
  assert.equal(seen.opts.percentile, 50);
  assert.equal(r.profile.label, "profile");
});

test("default profile: falls back to a manual 1755 mm / 80 kg man and says so", async () => {
  let manual;
  const mk = (over) => ({ loadIndex: async () => ({ populations: [] }), loadPopulation: async () => ({}), percentileProfile: () => ({}), manualProfile: (o) => { manual = o; return { label: "manual" }; }, ...over });
  let r = await loadDefaultProfile(mk());
  assert.deepEqual(manual, { sex: "M", stature: 1755, mass: 80 });
  assert.match(r.notice, /^Could not load the population data \(the default population is not in the data index\)\. Starting from a generic man, 1755 mm tall and 80 kg/);
  r = await loadDefaultProfile(mk({ loadIndex: async () => { throw new Error("offline"); } }));
  assert.match(r.notice, /\(offline\)/);
  r = await loadDefaultProfile(mk({ loadIndex: async () => ({ populations: [{ country_id: "united-states", role_id: "army", sex: "M" }] }), percentileProfile: () => { throw new Error("no stature"); } }));
  assert.match(r.notice, /\(no stature\)/);
  assert.equal(r.profile.label, "manual");
});

test("default profile: a request that never answers falls back after the timeout instead of hanging (regression: empty stage forever)", async () => {
  let manual;
  const never = new Promise(() => {});
  const anthro = { loadIndex: () => never, loadPopulation: () => never, percentileProfile: () => ({}), manualProfile: (o) => { manual = o; return { label: "manual" }; } };
  const t0 = Date.now();
  const r = await loadDefaultProfile(anthro, { timeoutMs: 40 });
  assert.ok(Date.now() - t0 < 2000);
  assert.equal(r.profile.label, "manual");
  assert.match(r.notice, /\(the population data did not answer within 40 ms\)/);
  assert.deepEqual(manual, { sex: "M", stature: 1755, mass: 80 });
  // a slow but successful answer inside the limit is used
  const slow = { ...anthro, loadIndex: async () => { await new Promise((res) => setTimeout(res, 10)); return { populations: [{ country_id: "united-states", role_id: "army", sex: "M" }] }; }, loadPopulation: async () => ({}), percentileProfile: () => ({ label: "pop" }) };
  const ok = await loadDefaultProfile(slow, { timeoutMs: 1000 });
  assert.equal(ok.profile.label, "pop");
  assert.equal(ok.notice, undefined);
});

test("withTimeout: resolves, rejects with the original error, times out, and clears its timer", async () => {
  assert.equal(await withTimeout(Promise.resolve(5), 1000, "x"), 5);
  await assert.rejects(withTimeout(Promise.reject(new Error("boom")), 1000, "x"), /boom/);
  await assert.rejects(withTimeout(new Promise(() => {}), 20, "the thing"), /^Error: the thing did not answer within 20 ms$/);
  let cleared = 0;
  await withTimeout(Promise.resolve(1), 1000, "x", { clearTimeoutFn: (t) => { cleared++; clearTimeout(t); } });
  assert.equal(cleared, 1);
  assert.equal(await withTimeout(7, 1000), 7, "a plain value is fine");
  await assert.rejects(withTimeout(new Promise(() => {}), 8000, "x", { setTimeoutFn: (f) => { queueMicrotask(f); return 0; } }), /within 8 seconds/);
});

// ------------------------------------------------------------------------------------------------------------------ units
test("units: conversion, formatting and rounding", () => {
  assert.equal(toUnit(1755, "mm"), 1755);
  assert.equal(toUnit(1755, "cm"), 175.5);
  assert.ok(Math.abs(toUnit(1755, "in") - 69.0944881889764) < 1e-12);
  for (const u of LENGTH_UNITS) for (const v of [0, 1, 17.55, 1755.25]) assert.ok(Math.abs(fromUnit(toUnit(v, u), u) - v) < 1e-9, `${u} ${v}`);
  assert.throws(() => toUnit(1, "ft"), /unknown length unit/);
  assert.throws(() => fromUnit(1, "yd"), /unknown length unit/);
  assert.equal(fmtLength(1755, "mm"), "1,755 mm");
  assert.equal(fmtLength(1755, "cm"), "175.5 cm");
  assert.equal(fmtLength(1755, "in"), "69.09 in");
  assert.equal(fmtLength(1755.4), "1,755 mm", "mm is the default");
  assert.equal(fmtLength(1755, "cm", { suffix: false }), "175.5");
  assert.equal(fmtLength(1755, "cm", { digits: 3 }), "175.500 cm");
  assert.equal(fmtLength(0, "mm"), "0 mm");
  assert.equal(fmtLength(-12.5, "cm"), "-1.3 cm", "negative lengths keep their sign");
  for (const bad of [null, undefined, NaN, Infinity]) assert.equal(fmtLength(bad), "—");
  assert.deepEqual(LENGTH_UNITS.map(unitDigits), [0, 1, 2]);
});

test("prefsDisplay: flags the shell switched on by itself are saved as they were, the user's choices as they are", () => {
  const display = { ...DEFAULT_DISPLAY, skeleton: true, joints: true, landmarks: true };
  assert.deepEqual(prefsDisplay(display, { skeleton: false, joints: false }), { ...DEFAULT_DISPLAY, landmarks: true });
  assert.deepEqual(prefsDisplay(display, { skeleton: false }), { ...DEFAULT_DISPLAY, joints: true, landmarks: true });
  assert.deepEqual(prefsDisplay(display, null), display);
  assert.deepEqual(prefsDisplay(display), display);
  assert.equal(display.skeleton, true, "the live display object is not modified");
  const mem = new Map(), storage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) };
  savePrefs({ units: "mm", qualityChoice: null, display: prefsDisplay(display, { skeleton: false, joints: false }) }, storage);
  assert.equal(loadPrefs(storage).display.skeleton, false);
});

test("impliedXray: bones or markers with the skin on need a see-through skin", () => {
  assert.equal(impliedXray({ skin: true, joints: true, skeleton: false }), true);
  assert.equal(impliedXray({ skin: true, joints: false, skeleton: true }), true);
  assert.equal(impliedXray({ skin: true, joints: false, skeleton: false }), false);
  assert.equal(impliedXray({ skin: false, joints: true, skeleton: true }), false, "no skin to see through");
  assert.equal(impliedXray({}), false);
});
