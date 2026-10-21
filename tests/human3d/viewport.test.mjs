// Logic of viewport.js that can run without WebGL: view presets, frame maths, click classification, label overlap reduction, projection,
// CSS colour parsing. (The renderer itself is covered by tests/human3d/test_viewer.py in a real browser.)
// Run: node --import ./tests/human3d/register.mjs --test tests/human3d/viewport.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import {
  VIEW_PRESETS, VIEW_ORDER, viewDirection, viewPosition, frameDistance, isClick, reduceLabelOverlap, placeLabels, isFiniteVec, projectPoint, parseCssColor, luminance, lightPreset, createViewport,
} from "../../site/js/human/viewport.js";

const near = (a, b, eps = 1e-9, msg) => assert.ok(Math.abs(a - b) <= eps, msg ?? `${a} != ${b}`);
const vnear = (v, [x, y, z], eps = 1e-9) => { near(v.x, x, eps, `x ${v.x}`); near(v.y, y, eps, `y ${v.y}`); near(v.z, z, eps, `z ${v.z}`); };

test("view presets: every name has a direction, the six keys are complete", () => {
  assert.deepEqual([...VIEW_ORDER].sort(), Object.keys(VIEW_PRESETS).sort());
  assert.equal(VIEW_ORDER.length, 6);
  for (const n of VIEW_ORDER) {
    assert.equal(typeof VIEW_PRESETS[n].label, "string");
    near(viewDirection(n).length(), 1, 1e-12, `${n} is a unit vector`);
  }
  assert.throws(() => viewDirection("side"), /unknown view/);
  assert.throws(() => { VIEW_PRESETS.front.azimuth = 5; }, TypeError); // frozen table (strict mode in modules)
});

test("view presets: the camera sits where the name says (+Z is the front, +X the figure's left)", () => {
  vnear(viewDirection("front"), [0, 0, 1]);
  vnear(viewDirection("back"), [0, 0, -1]);
  vnear(viewDirection("left"), [1, 0, 0]); // looking at the figure's left side from +X
  vnear(viewDirection("right"), [-1, 0, 0]);
  const top = viewDirection("top");
  assert.ok(top.y > 0.9999 && top.z > 0, "top is (almost) straight above, slightly in front so the up vector is defined");
  const iso = viewDirection("iso");
  assert.ok(iso.x > 0.2 && iso.y > 0.3 && iso.z > 0.2, "iso looks from front, left and above");
});

test("view presets: viewPosition keeps the distance and is relative to the target", () => {
  const t = new THREE.Vector3(0.3, 0.9, -0.2);
  for (const n of VIEW_ORDER) {
    const p = viewPosition(n, t, 3.7);
    near(p.distanceTo(t), 3.7, 1e-12);
    vnear(p.clone().sub(t).normalize(), viewDirection(n).toArray(), 1e-12);
  }
  // looking from the camera position at the target, the preset's own up is +Y: front view has the target straight ahead
  const cam = new THREE.PerspectiveCamera(35, 1, 0.1, 100);
  cam.position.copy(viewPosition("front", t, 4)); cam.lookAt(t); cam.updateMatrixWorld();
  const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
  vnear(fwd, [0, 0, -1], 1e-12);
});

function corners(center, half) {
  const out = [];
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) out.push(new THREE.Vector3(center.x + sx * half.x, center.y + sy * half.y, center.z + sz * half.z));
  return out;
}
function maxNdc(center, half, dir, dist, fov, aspect) {
  const cam = new THREE.PerspectiveCamera(fov, aspect, 0.05, 100);
  cam.position.copy(center).addScaledVector(dir.clone().normalize(), dist);
  cam.lookAt(center);
  cam.updateMatrixWorld(true); cam.updateProjectionMatrix();
  let m = 0;
  for (const c of corners(center, half)) {
    const v = c.clone().project(cam);
    m = Math.max(m, Math.abs(v.x), Math.abs(v.y));
  }
  return m;
}

test("frameDistance: every corner of the box is inside the frustum at margin 1, and the fit is exact", () => {
  const boxes = [[0.5, 0.9, 0.4], [1.2, 0.3, 0.3], [0.2, 1.0, 0.2], [2, 2, 2], [0.01, 0.01, 0.01]];
  const views = [...VIEW_ORDER.map((n) => viewDirection(n)), new THREE.Vector3(1, 2, 3), new THREE.Vector3(-0.3, 0.1, -1)];
  for (const half of boxes) for (const dir of views) for (const fov of [20, 35, 60]) for (const aspect of [0.5, 1, 1.78]) {
    const c = new THREE.Vector3(0.1, 0.9, -0.2);
    const d = frameDistance(new THREE.Vector3(...half), dir, fov, aspect, 1);
    const m = maxNdc(c, new THREE.Vector3(...half), dir, d, fov, aspect);
    assert.ok(m <= 1 + 1e-9, `fits: ${half} dir ${dir.toArray()} fov ${fov} aspect ${aspect}: max ${m}`);
    assert.ok(m > 1 - 1e-9, `tight: the nearest corner touches the edge, max ${m}`);
  }
});

test("frameDistance: margin scales the distance, a wider view needs less for a wide box, bad input stays finite", () => {
  const half = [1.2, 0.3, 0.3], dir = [0, 0, 1];
  const a = frameDistance(half, dir, 35, 1.0, 1), b = frameDistance(half, dir, 35, 2.0, 1);
  assert.ok(b < a, "a wider window needs a smaller distance for a wide box");
  near(frameDistance(half, dir, 35, 1.5, 1.25) / frameDistance(half, dir, 35, 1.5, 1), 1.25, 1e-12);
  assert.ok(Number.isFinite(frameDistance([0.5, 1, 0.5], [0, 1, 0], 35, 1.2, 1.1)), "straight down does not produce NaN");
  assert.ok(Number.isFinite(frameDistance([0.5, 1, 0.5], [0, 1, 0], 35, 0, 1.1)), "a zero-width view does not divide by zero");
  assert.ok(frameDistance({ x: 0.3, y: 0.9, z: 0.3 }, { x: 0, y: 0, z: 2 }, 35, 1, 1) > 0, "accepts {x,y,z} objects and normalises the direction");
});

test("isClick: within 4 px of the pointer-down (inclusive) at any speed, never otherwise", () => {
  const d = { x: 100, y: 100, t: 1000 };
  assert.equal(isClick(d, { x: 100, y: 100, t: 1100 }), true);
  assert.equal(isClick(d, { x: 104, y: 100, t: 1400 }), true, "4 px is inclusive");
  assert.equal(isClick(d, { x: 105, y: 100, t: 1100 }), false, "5 px is a drag");
  assert.equal(isClick(d, { x: 103, y: 104, t: 1100 }), false, "the distance is Euclidean (5 px)");
  // a slow press (tremor, switch device, long tap) is a deliberate selection: DESIGN 2.3b only excludes drags longer than 4 px
  assert.equal(isClick(d, { x: 100, y: 100, t: 1401 }), true, "a slow press is still a click");
  assert.equal(isClick(d, { x: 100, y: 100, t: 61000 }), true, "however slow");
  assert.equal(isClick(d, { x: 100, y: 100, t: 1401 }, { maxMs: 400 }), false, "a caller can still ask for a time limit");
  assert.equal(isClick(d, { x: 100, y: 100, t: 999 }), false, "time cannot run backwards");
  assert.equal(isClick(null, d), false);
  assert.equal(isClick(d, undefined), false);
  assert.equal(isClick(d, { x: 108, y: 100, t: 1100 }, { maxDist: 10 }), true, "thresholds are options");
  assert.equal(isClick(d, { x: 100, y: 100, t: 1900 }, { maxMs: 1000 }), true);
});

test("reduceLabelOverlap: separate labels all stay, overlapping ones are dropped in priority (list) order", () => {
  const r = (x, y, extra = {}) => ({ x, y, w: 60, h: 18, ax: x - 7, ay: y + 9, ...extra });
  assert.deepEqual(reduceLabelOverlap([]), []);
  assert.deepEqual(reduceLabelOverlap([r(10, 10), r(10, 100), r(200, 10)]), [true, true, true]);
  assert.deepEqual(reduceLabelOverlap([r(10, 10), r(30, 14)]), [true, false], "the second rectangle overlaps the first");
  assert.deepEqual(reduceLabelOverlap([r(30, 14), r(10, 10)]), [true, false], "whichever comes first wins");
  assert.deepEqual(reduceLabelOverlap([r(10, 10), r(10, 10), r(10, 10)]), [true, false, false]);
  // a dropped label does not block the ones after it
  assert.deepEqual(reduceLabelOverlap([r(10, 10), r(30, 14), r(100, 10)]), [true, false, true]);
});

test("reduceLabelOverlap: anchors closer than 12 px collide even when the rectangles do not; pad and minDist are options", () => {
  const a = { x: 10, y: 10, w: 30, h: 18, ax: 5, ay: 19 };
  const b = { x: 200, y: 200, w: 30, h: 18, ax: 12, ay: 22 }; // far rectangle, anchor 7.6 px from a's anchor
  assert.deepEqual(reduceLabelOverlap([a, b]), [true, false]);
  assert.deepEqual(reduceLabelOverlap([a, b], { minDist: 5 }), [true, true]);
  const c = { x: 10 + 30 + 1, y: 10, w: 30, h: 18, ax: 100, ay: 100 }; // 1 px gap to the right of a
  assert.deepEqual(reduceLabelOverlap([a, c], { pad: 2 }), [true, false], "within the padding");
  assert.deepEqual(reduceLabelOverlap([a, c], { pad: 0 }), [true, true]);
  const noAnchor = [{ x: 0, y: 0, w: 10, h: 10 }, { x: 50, y: 0, w: 10, h: 10 }];
  assert.deepEqual(reduceLabelOverlap(noAnchor), [true, true], "items without an anchor only use rectangles");
});

test("reduceLabelOverlap: a pinned label is moved off the one it overprints, never dropped for crowding, and still blocks the others", () => {
  const items = [{ x: 0, y: 0, w: 50, h: 18, ax: 0, ay: 9 }, { x: 10, y: 4, w: 50, h: 18, ax: 3, ay: 13, pin: true }, { x: 20, y: 6, w: 50, h: 18, ax: 5, ay: 15 }];
  assert.deepEqual(reduceLabelOverlap(items), [true, true, false]);
  const p = placeLabels(items);
  assert.equal(p[0].dy, 0);
  assert.equal(p[1].dy, 20, "one label height plus the padding down, the first free place");
  assert.equal(p[2].keep, false);
});

test("placeLabels: two pinned labels at one joint (the joint's name and a DOF name) end up apart, not overprinted (regression: 'rot nee')", () => {
  const name = { x: 100, y: 100, w: 70, h: 18, ax: 93, ay: 109, pin: true };
  const dof = { x: 100, y: 104, w: 30, h: 18, ax: 94, ay: 113, pin: true }; // same anchor area, pinned too
  const dof2 = { x: 103, y: 99, w: 30, h: 18, ax: 96, ay: 108, pin: true };
  const out = placeLabels([name, dof, dof2]);
  assert.deepEqual(out.map((r) => r.keep), [true, true, true]);
  assert.equal(out[0].dy, 0, "the first (highest priority) label stays where it is");
  const rects = [name, dof, dof2].map((r, i) => ({ ...r, y: r.y + out[i].dy }));
  for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) {
    const a = rects[i], b = rects[j];
    assert.ok(!(a.x < b.x + b.w + 2 && a.x + a.w + 2 > b.x && a.y < b.y + b.h + 2 && a.y + a.h + 2 > b.y), `labels ${i} and ${j} overlap`);
  }
  // pinned labels skip the anchor-distance test (arrow tips of one joint are close together), unpinned ones do not
  assert.deepEqual(placeLabels([{ x: 0, y: 0, w: 10, h: 10, ax: 0, ay: 0 }, { x: 100, y: 0, w: 10, h: 10, ax: 5, ay: 0, pin: true }]).map((r) => r.keep), [true, true]);
  // no free place within reach: the pinned label is dropped rather than printed over another one
  const wall = Array.from({ length: 9 }, (_, i) => ({ x: 0, y: i * 20 - 60, w: 80, h: 18, pin: true }));
  const crowded = placeLabels(wall.concat([{ x: 0, y: 0, w: 80, h: 18, pin: true }]), { maxNudge: 1 });
  assert.equal(crowded[9].keep, false);
});

test("isFiniteVec: only vectors with three finite components pass (guards the camera against NaN)", () => {
  assert.equal(isFiniteVec(new THREE.Vector3(1, 2, 3)), true);
  assert.equal(isFiniteVec([0, 0, 0]), true);
  for (const bad of [new THREE.Vector3(NaN, 0, 0), new THREE.Vector3(0, Infinity, 0), [0, 0, -Infinity], [1, 2], null, undefined, {}, 5]) assert.equal(isFiniteVec(bad), false, String(bad));
});

test("reduceLabelOverlap: large inputs finish and no two kept labels overlap", () => {
  const many = Array.from({ length: 3000 }, (_, i) => ({ x: (i * 37) % 900, y: (i * 91) % 700, w: 60, h: 18, ax: (i * 37) % 900 - 7, ay: ((i * 91) % 700) + 9 }));
  const keep = reduceLabelOverlap(many);
  const kept = many.filter((_, i) => keep[i]);
  assert.ok(kept.length > 10 && kept.length < many.length);
  for (let i = 0; i < kept.length; i++) for (let j = i + 1; j < kept.length; j++) {
    const a = kept[i], b = kept[j];
    const overlap = a.x < b.x + b.w + 2 && a.x + a.w + 2 > b.x && a.y < b.y + b.h + 2 && a.y + a.h + 2 > b.y;
    assert.ok(!overlap, "no two kept labels overlap");
  }
});

test("projectPoint: screen coordinates, visibility behind the camera and off screen", () => {
  const cam = new THREE.PerspectiveCamera(35, 800 / 600, 0.05, 100);
  cam.position.set(0, 0, 5); cam.lookAt(0, 0, 0); cam.updateMatrixWorld(true);
  const o = projectPoint(cam, new THREE.Vector3(0, 0, 0), 800, 600);
  near(o.x, 400, 1e-9); near(o.y, 300, 1e-9); near(o.depth, 5, 1e-9); assert.equal(o.visible, true);
  const up = projectPoint(cam, [0, 0.5, 0], 800, 600);
  assert.ok(up.y < 300 && near(up.x, 400, 1e-9) === undefined, "+Y is up the screen (smaller y)");
  const left = projectPoint(cam, [0.5, 0, 0], 800, 600);
  assert.ok(left.x > 400, "+X is to the right when looking down -Z (the figure's left of a figure facing +Z)");
  assert.equal(projectPoint(cam, [0, 0, 10], 800, 600).visible, false, "behind the camera");
  assert.equal(projectPoint(cam, [50, 0, 0], 800, 600).visible, false, "far off to the side");
  assert.equal(projectPoint(cam, [0, 0, -200], 800, 600).visible, false, "beyond the far plane");
  const out = {};
  assert.equal(projectPoint(cam, [0, 0, 0], 800, 600, out), out, "writes into the given object");
});

test("parseCssColor: the forms getComputedStyle and the site's tokens produce", () => {
  assert.deepEqual(parseCssColor("#fff"), [1, 1, 1]);
  assert.deepEqual(parseCssColor("#F0EFEC").map((v) => Math.round(v * 255)), [240, 239, 236]);
  assert.deepEqual(parseCssColor("#11223380").map((v) => Math.round(v * 255)), [17, 34, 51], "alpha is ignored");
  assert.deepEqual(parseCssColor("rgb(10, 20, 30)").map((v) => Math.round(v * 255)), [10, 20, 30]);
  assert.deepEqual(parseCssColor("rgba(10,20,30,0.5)").map((v) => Math.round(v * 255)), [10, 20, 30]);
  assert.deepEqual(parseCssColor("rgb(10 20 30 / 50%)").map((v) => Math.round(v * 255)), [10, 20, 30]);
  assert.deepEqual(parseCssColor("rgb(100%, 0%, 50%)"), [1, 0, 0.5]);
  assert.deepEqual(parseCssColor("color(srgb 0.5 0.25 1)"), [0.5, 0.25, 1]);
  assert.deepEqual(parseCssColor("  RGB(300, -5, 0) ").map((v) => v), [1, 0, 0], "components are clamped");
  for (const bad of ["", "red", "hsl(0 0% 0%)", "#12", "#ggg", "color(display-p3 1 0 0)", null, undefined, 5, {}]) assert.equal(parseCssColor(bad), null, String(bad));
});

test("luminance and lightPreset: dark backgrounds get their own light balance", () => {
  near(luminance([0, 0, 0]), 0); near(luminance([1, 1, 1]), 1, 1e-12);
  assert.ok(luminance(parseCssColor("#f0efec")) > 0.8 && luminance(parseCssColor("#232321")) < 0.05);
  const l = lightPreset(false), d = lightPreset(true);
  for (const k of ["hemi", "key", "fill", "head", "shadow"]) assert.ok(l[k] > 0 && d[k] > 0, k);
  assert.ok(d.hemi < l.hemi, "less ambient light on a dark background");
  assert.ok(d.shadow > l.shadow, "shadows need more opacity to show on a dark floor");
});

test("createViewport needs a DOM: in Node it fails loudly instead of half-working", () => {
  assert.throws(() => createViewport({}), (e) => e instanceof Error);
});
