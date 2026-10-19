// Stateful fuzz of the Sandbox against a stub viewport: random add / remove / move / rotate / param / duplicate / lock / hide / attach / template / fromJSON / undo / redo,
// with invariants after every step and an undo-then-redo identity check. Seeded, so a failure replays.
// node --import ./tests/human3d/register.mjs --test tests/human3d/sandbox.adversarial.fuzz3.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { CATALOG } from "../../site/js/human/catalog.js";
import { createSandbox, TEMPLATES } from "../../site/js/human/sandbox.js";
import { createStore } from "../../site/js/human/state.js";
import { syntheticBody } from "../../site/js/human/synthetic.js";
import { buildRig } from "../../site/js/human/rig.js";

function stub() {
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(35, 4 / 3, 0.05, 120);
  camera.position.set(0, 1.8, 4.5); camera.lookAt(0, 0.6, 0.8); camera.updateMatrixWorld();
  const handlers = new Map();
  return { scene, camera, container: new EventTarget(), controls: { enabled: true }, active: true, theme: { accent: new THREE.Color(0x2a78d6) }, gizmo: null, gizmoDragging: false,
    add(o) { scene.add(o); }, remove(o) { scene.remove(o); }, requestRender() {}, on(e, f) { (handlers.get(e) ?? handlers.set(e, new Set()).get(e)).add(f); return () => handlers.get(e).delete(f); },
    ray() { return new THREE.Raycaster(); }, attachGizmo(o) { this.gizmo = { object: o }; }, detachGizmo() { this.gizmo = null; }, setGizmoOptions() {}, setCursor() {}, addLabelSource() { return () => {}; }, removeLabelSource() {}, frame() {} };
}
const rng = (seed) => () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
const canon = (sb) => JSON.stringify(sb.toJSON().objects);

function check(sb, tag) {
  const ids = [...sb.objects.keys()];
  assert.equal(new Set(ids).size, ids.length, `${tag}: duplicate ids`);
  assert.equal(sb.root.children.length, ids.length, `${tag}: root children ${sb.root.children.length} vs ${ids.length}`);
  for (const o of sb.objects.values()) {
    assert.equal(o.group.parent, sb.root, `${tag}: ${o.id} not in root`);
    assert.ok(o.position.every(Number.isFinite) && Number.isFinite(o.yaw), `${tag}: NaN in ${o.id}`);
    assert.ok(o.position[1] >= 0, `${tag}: below floor ${o.position}`);
    if (!o.attachedTo) {
      assert.ok(Math.abs(o.group.position.x - o.position[0]) < 1e-9 && Math.abs(o.group.position.y - o.position[1]) < 1e-9 && Math.abs(o.group.position.z - o.position[2]) < 1e-9, `${tag}: group position out of step for ${o.id}`);
      assert.ok(Math.abs(THREE.MathUtils.euclideanModulo(o.group.rotation.y - o.yaw * Math.PI / 180 + Math.PI, 2 * Math.PI) - Math.PI) < 1e-6, `${tag}: group yaw out of step for ${o.id}`);
    }
    assert.ok(o.model && o.model.parent === o.group, `${tag}: no model`);
    assert.ok(o.group.children.filter((c) => c.userData.noPick).length <= 2, `${tag}: outline lines accumulate on ${o.id}`);
  }
  if (sb.selected) assert.ok(sb.objects.has(sb.selected), `${tag}: selected object gone`);
  if (sb.viewport.gizmo) assert.equal(sb.viewport.gizmo.object.userData.sandboxId, sb.selected, `${tag}: gizmo on a non-selected object`);
}

test("sandbox state-machine fuzz: invariants and undo/redo identity", () => {
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    const R = rng(seed), vp = stub(), store = createStore(), rig = buildRig(syntheticBody(1.75, "male"), { skeleton: false });
    const ctx = { state: store.state, viewport: vp, on: store.on, emit: (e, d) => store.emit(e, d), select: (s) => store.select(s), getRig: () => rig, toast() {}, units: "mm" };
    const sb = createSandbox({ viewport: vp, ctx, scheduler: () => () => {} });
    const types = CATALOG.map((t) => t.type), pickId = () => { const ids = [...sb.objects.keys()]; return ids.length ? ids[Math.floor(R() * ids.length)] : null; };
    const log = [];
    for (let step = 0; step < 260; step++) {
      const id = pickId(), r = R(), tag = `seed ${seed} step ${step}`;
      let op;
      try {
        if (r < 0.14) { const t = types[Math.floor(R() * types.length)]; op = `add ${t}`; sb.add(t, { select: R() < 0.5 }); }
        else if (r < 0.2 && id) { op = `remove ${id}`; sb.remove(id); }
        else if (r < 0.3 && id) { op = `move ${id}`; sb.move(id, { x: (R() - 0.5) * 6, z: (R() - 0.5) * 6, ...(R() < 0.3 ? { y: R() * 2 - 0.5 } : {}) }); }
        else if (r < 0.36 && id) { op = `rotate ${id}`; sb.rotate(id, (R() - 0.5) * 900); }
        else if (r < 0.46 && id) { const o = sb.objects.get(id), ps = CATALOG.find((t) => t.type === o.type).params, p = ps[Math.floor(R() * ps.length)]; op = `param ${id} ${p.key}`; sb.setParam(id, p.key, p.kind === "number" ? p.min + R() * (p.max - p.min) * 1.2 - 0.1 * (p.max - p.min) : p.kind === "bool" ? R() < 0.5 : p.options[Math.floor(R() * p.options.length)].value); }
        else if (r < 0.5 && id) { op = `dup ${id}`; sb.duplicate(id, { select: true }); }
        else if (r < 0.54 && id) { op = `lock ${id}`; sb.setLocked(id, R() < 0.5); }
        else if (r < 0.58 && id) { op = `hide ${id}`; sb.setVisible(id, R() < 0.5); }
        else if (r < 0.62 && id) { op = `select ${id}`; sb.select(id); }
        else if (r < 0.64) { op = "select null"; sb.select(null); }
        else if (r < 0.67 && id) { op = `attach ${id}`; sb.attach(id, { kind: "joint", id: "wrist_L" }, [R() * 0.2, 0, 0], { local: R() < 0.5, orient: R() < 0.5 }); }
        else if (r < 0.69 && id) { op = `detach ${id}`; sb.detach(id); }
        else if (r < 0.71) { const t = TEMPLATES[Math.floor(R() * TEMPLATES.length)]; op = `template ${t.id}`; sb.applyTemplate(t.id, { merge: R() < 0.5 }); }
        else if (r < 0.73) { op = "fromJSON(toJSON)"; const f = sb.toSceneFile(); sb.fromJSON(JSON.stringify(f)); }
        else if (r < 0.75) { op = "clear"; sb.clear(); }
        else if (r < 0.77 && id) { op = `drop ${id}`; sb.dropToSurface(id); }
        else if (r < 0.79 && id) { op = `nudge ${id}`; sb.nudge(id, (R() - 0.5) * 0.1, (R() - 0.5) * 0.1); }
        else if (r < 0.81) { op = "gizmo mode"; sb.setGizmoMode(["translate", "rotate", "scale", "none"][Math.floor(R() * 4)]); }
        else if (r < 0.9) { op = "undo"; sb.undo(); }
        else if (r < 0.95) { op = "redo"; sb.redo(); }
        else { op = "snap"; sb.setSnap({ gridMm: [0, 5, 10, 25, 50, 100][Math.floor(R() * 6)], angleDeg: [0, 5, 15, 45, 90][Math.floor(R() * 5)] }); }
      } catch (e) { assert.fail(`${tag} op "${op}" threw: ${e.stack}`); }
      log.push(op);
      check(sb, `${tag} after ${op}`);
      // undo then redo must land on exactly the same scene
      if (sb.canUndo && step % 7 === 0) {
        const S = canon(sb), sel = sb.selected;
        sb.undo(); check(sb, `${tag} undo`); const ok = sb.redo(); check(sb, `${tag} redo`);
        assert.ok(ok, `${tag}: redo not possible after undo`);
        assert.equal(canon(sb), S, `${tag}: undo then redo changed the scene (after ${log.slice(-4).join(", ")})`);
      }
    }
    // unwind the whole history: it ends in the empty start state and every state on the way is valid
    let n = 0; while (sb.undo()) { check(sb, `seed ${seed} unwind ${n++}`); if (n > 400) assert.fail("unwind does not end"); }
    sb.dispose();
    assert.equal(vp.scene.children.length, 0, "scene not empty after dispose");
  }
});
