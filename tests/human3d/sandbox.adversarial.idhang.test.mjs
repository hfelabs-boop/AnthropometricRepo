// A scene file whose object id is a huge number ("o" + 20 digits) makes newId() spin forever: seq++ no longer changes a double above 2^53.
// node --import ./tests/human3d/register.mjs --test tests/human3d/sandbox.adversarial.idhang.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";

const code = `
import * as THREE from "three";
import { createSandbox } from "/home/user/AnthropometricRepo/site/js/human/sandbox.js";
import { parentPort } from "node:worker_threads";
const vp = { scene: new THREE.Scene(), add() {}, remove() {}, requestRender() {}, on() { return () => {}; }, container: null };
const sb = createSandbox({ viewport: vp, ctx: { state: {}, on: () => () => {}, emit() {}, select() {}, getRig: () => null, toast() {} }, scheduler: () => () => {} });
const r = sb.fromJSON({ version: 1, objects: [{ type: "box", id: "o99999999999999999999" }, { type: "box" }, { type: "box" }] });
parentPort.postMessage({ ok: r.ok, ids: [...sb.objects.keys()] });
`;
test("DEFECT: a huge numeric object id in a scene file hangs the page on the next id allocation", async () => {
  const w = new Worker(code, { eval: true, execArgv: ["--import", "/home/user/AnthropometricRepo/tests/human3d/register.mjs"] });
  const res = await Promise.race([new Promise((r) => { w.once("message", r); w.once("error", (e) => r({ error: String(e) })); }), new Promise((r) => setTimeout(() => r({ hang: true }), 5000))]);
  await w.terminate();
  assert.ok(!res.hang, "loading the scene never finished (infinite loop in newId)");
  assert.ok(res.ok, JSON.stringify(res));
});

const code2 = `
import * as THREE from "three";
import { createMeasure } from "/home/user/AnthropometricRepo/site/js/human/measure.js";
import { parentPort } from "node:worker_threads";
const vp = { scene: new THREE.Scene(), add() {}, remove() {}, requestRender() {}, on() { return () => {}; }, container: null };
const ms = createMeasure({ viewport: vp, ctx: { state: {}, on: () => () => {}, emit() {}, getRig: () => null, units: "mm" }, scheduler: () => {} });
const w = (x) => ({ kind: "world", p: [x, 0, 0] });
const r = ms.fromJSON([{ kind: "distance", id: "m99999999999999999999", a: w(0), b: w(1) }, { kind: "distance", a: w(0), b: w(2) }, { kind: "distance", a: w(0), b: w(3) }]);
parentPort.postMessage({ ok: r.ok, ids: ms.items.map((i) => i.id) });
`;
test("DEFECT: a huge numeric measurement id in a scene file hangs the page the same way", async () => {
  const w = new Worker(code2, { eval: true, execArgv: ["--import", "/home/user/AnthropometricRepo/tests/human3d/register.mjs"] });
  const res = await Promise.race([new Promise((r) => { w.once("message", r); w.once("error", (e) => r({ error: String(e) })); }), new Promise((r) => setTimeout(() => r({ hang: true }), 5000))]);
  await w.terminate();
  assert.ok(!res.hang, "loading the measurements never finished (infinite loop in nextId)");
  assert.ok(res.ok, JSON.stringify(res));
});
