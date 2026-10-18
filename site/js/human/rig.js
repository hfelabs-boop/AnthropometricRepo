// BodyModel -> three.js rig: the THREE.Bone hierarchy of the 77 joints of skeleton.js, a Kinematics kept in sync (the numerical truth),
// an optional skin (built by body.js through options.skinBuilder) and the skeleton / joint / landmark / centre-of-mass visuals of
// skeletonview.js. API: DESIGN.md 2.3. Imports only three and the pure modules; never touches the DOM.
//
// Pose semantics (the one place where the contract needed a decision):
//   setPose({ root, angles }, { clamp, keepPosition })   a key that is PRESENT replaces that part completely, an absent key leaves it alone.
//        angles: joints not listed become neutral (so applying a posture never leaves bits of the previous one behind);
//        root:   fields not listed become 0 (x, y, z too: setPose({ root: { heading: 90 } }) puts the pelvis at the origin, at y = 0, i.e.
//                half the body under the floor). This is deliberate: a pose is a whole state, and getPose() / setPose() round-trip exactly
//                (rig.adversarial.test.mjs pins it as the documented default).
//                A POSTURE root (DESIGN 2.4) has an orientation and no position, so for it pass { keepPosition: true } (x, y, z not listed keep their
//                current value; the orientation fields not listed are still 0) or use setRoot, which merges.
//   setAngles(partial) / setRoot(partial) / setSpine(regions) MERGE into the current pose; they touch (validate, clamp, report) only what
//        they are given: a joint that is outside its range because an earlier pose was applied with clamp: false stays where it is.
// Everything is atomic: the input is validated and clamped first, the Kinematics solve (which is itself all-or-nothing) runs on the
// staged values and only then are bones, state and listeners touched. A bad pose throws and changes nothing.
//
// Skin: a builder's SkinnedMesh is never frustum culled (the root moves through the pelvis bone, so the bounding sphere of the bind pose would
// leave the view with the body) and its cached bounds are dropped after every pose so that raycasting and lowestY({ skin }) see the posed mesh.
//
// Bones vs Kinematics: both call skeleton.js writeJointQuaternion on the same numbers, so world positions and orientations agree to
// rounding (about 1e-15 m). `kin` is read by every query (jointWorld, landmarkWorld, ...); the bones carry the same pose to the renderer.
import * as THREE from "three";
import { JOINTS, JOINT_BY_ID, BONES, BONE_BY_ID, BONE_LANDMARKS, REGIONS, regionOf, clampAngles, checkedAngles, checkRoot, rootQuaternion, writeJointQuaternion, expandRegions } from "./skeleton.js";
import { Kinematics } from "./fk.js";
import { SkeletonView } from "./skeletonview.js";

const NJ = JOINTS.length;
const DISPLAY_KEYS = ["skin", "skeleton", "joints", "labels", "axes", "landmarks", "wireframe", "xray", "com"];
const ROOT_KEYS = ["x", "y", "z", "heading", "flex", "lat", "rot"];
const ZERO_ROOT = Object.freeze({ x: 0, y: 0, z: 0, heading: 0, flex: 0, lat: 0, rot: 0 });
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const fin3 = (v) => v != null && typeof v.length === "number" && v.length >= 3 && [v[0], v[1], v[2]].every((c) => typeof c === "number" && Number.isFinite(c));

/** Throws an Error naming the first thing that is wrong with a BodyModel (only what the rig reads; extra keys are ignored). */
function checkBody(body, needSkeleton) {
  if (!isObj(body)) throw new TypeError("buildRig: body must be a BodyModel object");
  if (!isObj(body.joints)) throw new Error("buildRig: body.joints is missing");
  for (const j of JOINTS) {
    if (!isObj(body.joints[j.id]) || !fin3(body.joints[j.id].offset)) throw new Error(`buildRig: body.joints.${j.id}.offset must be [x, y, z] in metres`);
  }
  if (!isObj(body.landmarks)) throw new Error("buildRig: body.landmarks is missing");
  for (const [id, l] of Object.entries(body.landmarks)) {
    if (!isObj(l) || !JOINT_BY_ID[l.joint] || !fin3(l.offset)) throw new Error(`buildRig: landmark "${id}" needs { joint: <joint id>, offset: [x, y, z] }`);
  }
  if (body.contacts != null) {
    if (!isObj(body.contacts)) throw new Error("buildRig: body.contacts must be an object { setName: [landmark id | { joint, offset }] }");
    for (const [name, set] of Object.entries(body.contacts)) {
      if (!Array.isArray(set)) throw new Error(`buildRig: body.contacts.${name} must be an array`);
      set.forEach((c, i) => {
        if (typeof c === "string") {
          if (!Object.hasOwn(body.landmarks, c)) throw new Error(`buildRig: body.contacts.${name}[${i}] names the landmark "${c}", which body.landmarks lacks`);
        } else if (!(isObj(c) && JOINT_BY_ID[c.joint] && fin3(c.offset))) throw new Error(`buildRig: body.contacts.${name}[${i}] must be a landmark id or { joint: <joint id>, offset: [x, y, z] }`);
      });
    }
  }
  if (needSkeleton) {
    const missing = BONE_LANDMARKS.filter((id) => !body.landmarks[id]);
    if (missing.length) throw new Error(`buildRig: body.landmarks lacks ${missing.join(", ")} (the skeleton ends there)`);
  }
}

// ---- rest model ---------------------------------------------------------------------------------------------------------------------------
// The rig rebases the body in two places, so that rigid attachments agree with the anatomy they draw. Both are no-ops when the data already
// has the form (the neutral world position of every joint, landmark, contact and mass is unchanged in any case):
//  1. Forearm twist axis. skeleton.js twists the forearm about the WORLD-VERTICAL axis through the forearm joint, which fit.js puts on the elbow
//     centre. The hand hangs to the side of that (the arm is abducted at rest: 28 mm at 6 degrees, 13 cm at 28), so pronation swung wrist and hand
//     along an arc of that radius (the grip point moved with pronation alone) and the ulna, rigid on the elbow, came off the wrist. The forearm joint
//     is moved onto the vertical through the wrist, a quarter of the forearm length above it (inside the silhouette of the forearm at any tilt, and
//     clear of the wrist's marker): pronation spins the hand about the wrist, the wrist stays where the ulna ends, and skeletonview.js skins the
//     radius between the elbow and this joint so that its head stays on the humerus. What remains is the tilt itself: the axis is vertical while
//     the forearm leans by the abduction of the neutral arm, so the fingers still describe a cone (see the report: this needs tilted twist axes in
//     skeleton.js, or a vertical neutral arm in fit.js).
//     CONSEQUENCE FOR OTHER MODULES: the rig's forearm_* and wrist_* offsets differ from body.joints / body.positions (every other joint, and every
//     landmark, contact and mass in world space, is unchanged). Anything that poses the figure numerically must use `rig.kin`, rig.jointWorld /
//     landmarkWorld, or a Kinematics built from `rig.restOffsets` (equivalently from `rig.restBody.joints`), never one built from body.joints:
//     with the elbow bent and the forearm pronated those put the wrist and hand tens of millimetres off the drawn figure.
//  2. Sternum. skeleton.js BONES carries the sternum as one rigid piece on T4, so its end landmarks (fit.js attaches xiphoid and substernale to
//     T11) move with T4: boneSegment("sternum") is then the mesh, not a point 4 cm off it in a bent spine.
const SIDES = ["L", "R"];
const SAME_PLACE = { substernale: "xiphoid" }; // a landmark that sits on another one follows it
const add3 = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

function rebase(body) {
  const off = {};
  for (const j of JOINTS) off[j.id] = Array.from(body.joints[j.id].offset).slice(0, 3);
  const world = () => {
    const W = {};
    for (const j of JOINTS) W[j.id] = j.parent ? add3(W[j.parent], off[j.id]) : [0, off[j.id][1], 0];
    return W;
  };
  const W0 = world();
  for (const s of SIDES) {
    const f = off[`forearm_${s}`], w = off[`wrist_${s}`];
    if (Math.abs(w[0]) < 1e-12 && Math.abs(w[2]) < 1e-12) continue; // the wrist is already below the forearm joint: nothing to do (the rebasing is idempotent)
    f[0] += w[0]; f[1] += 0.75 * w[1]; f[2] += w[2];
    w[0] = 0; w[1] *= 0.25; w[2] = 0;
  }
  const W1 = world();
  const moved = (id) => sub3(W0[id], W1[id]); // what an attachment to this joint must add to keep its neutral position
  let changed = JOINTS.some((j) => moved(j.id).some((c) => Math.abs(c) > 1e-12));

  const lm = new Map(); // id -> { joint, off }
  for (const [id, l] of Object.entries(body.landmarks)) lm.set(id, { joint: l.joint, off: add3(Array.from(l.offset).slice(0, 3), moved(l.joint)) });
  const home = new Set();
  const rehome = (id, joint) => {
    const l = lm.get(id);
    if (!l || l.joint === joint || home.has(id)) return;
    lm.set(id, { joint, off: sub3(add3(W1[l.joint], l.off), W1[joint]) });
    home.add(id);
    changed = true;
  };
  for (const d of BONES) for (const e of [d.from, d.to]) if (e && e.startsWith("lm:")) rehome(e.slice(3), d.joint);
  for (const [id, of] of Object.entries(SAME_PLACE)) if (lm.has(of)) rehome(id, lm.get(of).joint);

  const contacts = new Map(); // name -> [{ lm } | { joint, off }]
  for (const [name, set] of Object.entries(body.contacts || {})) {
    contacts.set(name, set.map((c) => (typeof c === "string" ? { lm: c } : { joint: c.joint, off: add3(Array.from(c.offset).slice(0, 3), moved(c.joint)) })));
  }

  let view = body; // what the skeleton view and a skin builder read: the body itself when nothing had to change
  if (changed) {
    const joints = {}, landmarks = {}, positions = { ...(body.positions || {}) };
    for (const j of JOINTS) { joints[j.id] = { ...body.joints[j.id], offset: off[j.id] }; positions[j.id] = W1[j.id]; }
    for (const [id, l] of lm) landmarks[id] = { ...body.landmarks[id], joint: l.joint, offset: l.off };
    view = { ...body, joints: { ...body.joints, ...joints }, landmarks, positions };
  }
  return { off, lm, contacts, moved, view };
}

const optClamp = (o) => {
  if (o == null) return true;
  if (typeof o !== "object") throw new TypeError("options must be an object { clamp }");
  return o.clamp === undefined ? true : !!o.clamp;
};

export class Rig {
  constructor(body, options = {}) {
    const opt = { skeleton: true, quality: "high", skinBuilder: null, ...options };
    checkBody(body, opt.skeleton);
    this.body = body;
    this.quality = opt.quality === "low" ? "low" : "high";
    this.group = new THREE.Group();
    this.group.name = "rig";
    this._disposed = false;
    this._listeners = new Set();
    this._tmpQ = new Float64Array(4);
    this._q = new THREE.Quaternion();
    this._q2 = new THREE.Quaternion();
    this._v = new THREE.Vector3();

    // ---- joints: the bone hierarchy and the kinematics ----------------------------------------------------------------------------
    const rb = rebase(body);
    this._moved = rb.moved;
    this.restBody = rb.view; // the body as the rig poses it: `body` with the rebasing above applied (the same object when none was needed)
    const offsets = {};
    for (const j of JOINTS) if (j.parent) offsets[j.id] = rb.off[j.id];
    this.kin = new Kinematics(offsets);
    this.restRootY = body.joints.pelvis.offset[1];
    this.bones = new Map(); // JOINTS order: parents first (body.js relies on it for the bone indices of its skin)
    for (const j of JOINTS) {
      const b = new THREE.Bone();
      b.name = j.id;
      if (j.parent) { b.position.fromArray(offsets[j.id]); this.bones.get(j.parent).add(b); } else this.group.add(b);
      this.bones.set(j.id, b);
    }
    this.landmarkIds = Object.freeze(Object.keys(body.landmarks));
    this._lm = rb.lm;
    this._contacts = rb.contacts;
    this._segs = this._parseMasses(body.masses);

    // ---- pose state ---------------------------------------------------------------------------------------------------------------
    this._root = Object.freeze({ ...ZERO_ROOT, y: this.restRootY });
    this._angles = this._neutralAngles();
    this._clampedLast = [];
    this._commitBones();
    this.kin.solve(this._angles, this._root);
    this.group.updateMatrixWorld(true); // neutral standing pose: what a skinned mesh binds to

    // ---- skin (bound in the neutral pose, see above) ------------------------------------------------------------------------------
    this.skin = null;
    this._skinHandle = null;
    this._skinMats = [];
    this._skinned = [];
    this.skinError = null; // set when the skin builder failed: the rig then works as a skeleton only
    if (typeof opt.skinBuilder === "function") {
      let r = null;
      try {
        r = opt.skinBuilder(this.restBody, this.bones, { quality: this.quality });
        if (r && r.mesh) {
          // the mesh is normally one SkinnedMesh, but a Group of them is accepted: every descendant is a part of the skin
          const mats = new Set(), skinned = [];
          r.mesh.traverse((o) => {
            o.frustumCulled = false; // see the header: the cached bounds of a skinned mesh are those of the pose they were computed in
            if (o.isSkinnedMesh) skinned.push(o);
            if (o.material) for (const m of [].concat(o.material)) mats.add(m);
          });
          this.group.add(r.mesh);
          this._skinHandle = r;
          this.skin = r.mesh;
          this._skinned = skinned;
          this._skinMats = [...mats].map((m) => ({ m, transparent: m.transparent, opacity: m.opacity, depthWrite: m.depthWrite }));
        }
      } catch (e) {
        // the skin is optional: a failing generator must not take the skeleton and the whole joint model down with it (the shell would otherwise
        // retry with the generic body, fail the same way and show an empty viewport)
        console.warn("Digital human: the skin could not be built, showing the skeleton only:", e);
        this.skinError = e;
        this.skin = null; this._skinHandle = null; this._skinMats = []; this._skinned = [];
        try { r?.mesh?.removeFromParent(); } catch { /* a half-built skin: nothing more to detach */ }
        try { if (r && typeof r.dispose === "function") r.dispose(); } catch { /* ... or to free */ }
      }
    }

    // ---- skeleton visuals -----------------------------------------------------------------------------------------------------------
    this.view = opt.skeleton ? new SkeletonView({ body: this.restBody, bones: this.bones, kin: this.kin, group: this.group, quality: this.quality, com: (out) => this._comInto(out) }) : null;
    this.selected = null;
    this.highlighted = null;
    this._display = Object.freeze({ skin: false, skeleton: false, joints: false, labels: false, axes: true, landmarks: false, wireframe: false, xray: false, com: false });
    this.setDisplay(this.skin ? { skin: true } : this.view ? { skeleton: true, joints: true } : {});
    this.group.updateMatrixWorld(true);
  }

  // ---- pose ---------------------------------------------------------------------------------------------------------------------------
  get root() { return this._root; }
  get angles() { return this._angles; }

  /** The rest offsets this rig poses with, { jointId: [x, y, z] } for every joint but the pelvis: pass them to `new Kinematics(...)` to get one that agrees with `kin` (see the forearm note in the header). */
  get restOffsets() {
    const o = {};
    for (const j of JOINTS) if (j.parent) o[j.id] = Array.from(this.restBody.joints[j.id].offset).slice(0, 3);
    return o;
  }

  _neutralAngles() {
    const o = {};
    for (const j of JOINTS) o[j.id] = Object.freeze(j.dof.map(() => 0));
    return Object.freeze(o);
  }

  /** Validate + clamp into new frozen state; touches nothing. Returns { root, angles, clamped, any }. merge: keep the joints of `pose.angles` only. */
  _stage(pose, clamp, merge = false, keepPosition = false) {
    if (!isObj(pose)) throw new TypeError("setPose: pose must be an object { root?, angles? }");
    for (const k of Object.keys(pose)) if (k !== "root" && k !== "angles") throw new Error(`setPose: unknown key "${k}" (expected root, angles)`);
    const staged = { root: this._root, angles: this._angles, clamped: [], any: false };
    if (pose.root !== undefined) {
      const r = pose.root;
      if (!isObj(r)) throw new TypeError("setPose: root must be an object { x, y, z, heading, flex, lat, rot }");
      for (const k of Object.keys(r)) if (!ROOT_KEYS.includes(k)) throw new Error(`setPose: unknown root field "${k}" (expected ${ROOT_KEYS.join(", ")})`);
      checkRoot(r); // RangeError for anything that is not a finite number
      const root = {};
      for (const k of ROOT_KEYS) root[k] = r[k] !== undefined ? r[k] : keepPosition && (k === "x" || k === "y" || k === "z") ? this._root[k] : 0;
      staged.root = Object.freeze(root);
      staged.any = true;
    }
    if (pose.angles !== undefined) {
      const a = pose.angles;
      if (!isObj(a)) throw new TypeError("setPose: angles must be an object { jointId: [degrees in DOF order] }");
      const out = {};
      for (const j of JOINTS) out[j.id] = merge ? this._angles[j.id] : Object.freeze(j.dof.map(() => 0));
      const scratch = new Float64Array(3);
      for (const [id, v] of Object.entries(a)) {
        const j = JOINT_BY_ID[id];
        if (!j) throw new Error(`setPose: unknown joint id "${id}"`);
        if (v === null || typeof v !== "object" || typeof v.length !== "number") throw new TypeError(`setPose: angles for "${id}" must be an array in DOF order (${j.dof.map((d) => d.key).join(", ")})`);
        const checked = checkedAngles(j, v, scratch); // RangeError for NaN, strings, too many values; holes are 0
        const req = j.dof.map((_, i) => (i < checked.length ? checked[i] : 0));
        if (clamp) {
          const c = clampAngles(id, req);
          c.angles.forEach((ap, i) => {
            // a value that misses its limit by float noise (a region total spread over the vertebrae lands an ulp beyond the last one) is
            // clamped silently: a report of "-4.864864864864866 became -4.864864864864865" is not information
            if (c.clamped[i] && !(Math.abs(req[i] - ap) < 1e-9)) staged.clamped.push({ joint: id, dof: j.dof[i].key, requested: req[i], applied: ap });
          });
          out[id] = Object.freeze(c.angles);
        } else out[id] = Object.freeze(req);
      }
      staged.angles = Object.freeze(out);
      staged.any = true;
    }
    return staged;
  }

  /**
   * Set root and/or joint angles, atomically. options: { clamp = true, keepPosition = false } (see the pose semantics at the top of the file). Returns { clamped: [{ joint, dof, requested, applied }] } (empty when nothing hit a limit
   * or clamp is false). Throws (and changes nothing) for unknown joint ids, non-finite values, too many values for a joint.
   */
  setPose(pose, opts) {
    return this._apply(pose, optClamp(opts), false, opts != null && opts.keepPosition === true);
  }

  _apply(pose, clamp, merge, keepPosition = false) {
    this._alive();
    const st = this._stage(pose, clamp, merge, keepPosition);
    if (!st.any) return { clamped: [] };
    this.kin.solve(st.angles, st.root); // throws before anything is committed (Kinematics.solve is all-or-nothing)
    this._root = st.root;
    this._angles = st.angles;
    this._clampedLast = st.clamped;
    this._commitBones();
    this.group.updateMatrixWorld(true);
    for (const m of this._skinned) { m.boundingSphere = null; m.boundingBox = null; } // recomputed in the new pose when a raycast or lowestY asks
    if (this.view) this.view.update();
    for (const fn of [...this._listeners]) {
      try { fn(this); } catch (e) { console.error(e); } // a faulty listener must not stop the others or leave the caller guessing
    }
    return { clamped: st.clamped };
  }

  _commitBones() {
    const t = this._tmpQ, A = this._angles, R = this._root;
    for (let i = 1; i < NJ; i++) {
      writeJointQuaternion(JOINTS[i], A[JOINTS[i].id], t, 0);
      this.bones.get(JOINTS[i].id).quaternion.set(t[0], t[1], t[2], t[3]);
    }
    const pelvis = this.bones.get("pelvis");
    pelvis.position.set(R.x, R.y, R.z);
    rootQuaternion(R, this._q);
    writeJointQuaternion(JOINTS[0], A.pelvis, t, 0); // optional extra local rotation of the pelvis, applied after the root (as Kinematics.solve does)
    pelvis.quaternion.copy(this._q.multiply(this._q2.set(t[0], t[1], t[2], t[3])));
  }

  /** Merge joint angles ({ id: [..] }) into the current pose; the other joints are left exactly as they are. */
  setAngles(partial, opts) {
    this._alive();
    if (!isObj(partial)) throw new TypeError("setAngles: expected { jointId: [degrees] }");
    return this._apply({ angles: partial }, optClamp(opts), true);
  }

  /** Merge root fields ({ x, y, z, heading, flex, lat, rot }) into the current root. */
  setRoot(partial, opts) {
    this._alive();
    if (!isObj(partial)) throw new TypeError("setRoot: expected { x?, y?, z?, heading?, flex?, lat?, rot? }");
    const root = { ...this._root };
    for (const [k, v] of Object.entries(partial)) if (v !== undefined) root[k] = v; // an undefined field means "leave it"
    return this.setPose({ root }, opts);
  }

  /**
   * Spine by region totals: { lumbar: [flex, lat, rot], thoracic: [...], cervical: [...] } (+ optional per-vertebra additions { L3: [..] }), merged
   * into the pose: only the regions that are mentioned (as a total or through one of their vertebrae) change, the others stay as they are.
   * A region cannot move further than its vertebrae allow (expandRegions pins each vertebra at its own limit): what could not be placed is
   * reported like a clamp, { joint: "lumbar", dof: "flex", requested, applied } with the region name as `joint` and the totals as values.
   * This is reported whatever options.clamp says: the limit of the vertebrae is not a clamp that can be switched off.
   */
  setSpine(regions, perVertebra, opts) {
    this._alive();
    for (const [what, v] of [["regions", regions], ["perVertebra", perVertebra]]) {
      if (v == null) continue;
      if (!isObj(v)) throw new TypeError(`setSpine: ${what} must be an object { ${what === "regions" ? "lumbar: [flex, lat, rot], thoracic: [...], cervical: [...]" : "L3: [flex, lat, rot], ..."} }`);
      for (const [k, a] of Object.entries(v)) if (a == null) throw new TypeError(`setSpine: "${k}" needs [flex, lat, rot] in degrees, not ${a}`);
    }
    const all = expandRegions(regions, perVertebra); // validates the rest, and throws before anything changes
    const names = new Set([...Object.keys(regions || {}), ...Object.keys(perVertebra || {}).map(regionOf)]);
    const partial = {};
    for (const r of names) for (const id of REGIONS[r].joints) partial[id] = all[id];
    const rep = this.setAngles(partial, opts);
    const sat = [];
    for (const r of Object.keys(regions || {})) {
      ["flex", "lat", "rot"].forEach((dof, c) => {
        const requested = regions[r][c] ?? 0;
        const applied = Math.round(REGIONS[r].joints.reduce((sum, id) => sum + this._angles[id][c] - (perVertebra?.[id]?.[c] ?? 0), 0) * 1e9) / 1e9; // no float noise in what a UI shows
        if (Math.abs(applied - requested) > 1e-9) sat.push({ joint: r, dof, requested, applied });
      });
    }
    return { clamped: [...rep.clamped, ...sat] };
  }

  /** Neutral standing pose on the floor: every angle 0, root at (0, rest pelvis height, 0), heading 0. */
  resetPose() {
    return this.setPose({ root: { y: this.restRootY }, angles: {} });
  }

  getPose() {
    const angles = {};
    for (const [id, a] of Object.entries(this._angles)) angles[id] = [...a];
    return { root: { ...this._root }, angles };
  }

  /** Called as fn(rig) after every committed setPose (also through setAngles, setRoot, setSpine, resetPose). Returns the unsubscribe function. */
  onChange(fn) {
    if (typeof fn !== "function") throw new TypeError("onChange: expected a function");
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  // ---- queries (all through the Kinematics) ---------------------------------------------------------------------------------------------
  /** World position of a joint centre. */
  jointWorld(id, out = new THREE.Vector3()) { this._alive(); return this.kin.position(id, out); }
  /** World ORIENTATION of a joint frame (not the local rotation of skeleton.js jointQuaternion). */
  jointQuaternion(id, out = new THREE.Quaternion()) { this._alive(); return this.kin.quaternion(id, out); }

  landmarkWorld(id, out = new THREE.Vector3()) {
    this._alive();
    const l = this._lm.get(id);
    if (!l) throw new Error(`unknown landmark id "${id}"`);
    return this.kin.toWorld(l.joint, l.off, out);
  }

  /** World positions of a named contact set (body.contacts[name]: landmark ids, or { joint, offset } entries). */
  contactPoints(setName) {
    this._alive();
    const set = this._contacts.get(setName);
    if (!set) throw new Error(`unknown contact set "${setName}" (available: ${[...this._contacts.keys()].join(", ") || "none"})`);
    return set.map((c) => (c.lm !== undefined ? this.landmarkWorld(c.lm) : this.kin.toWorld(c.joint, c.off, new THREE.Vector3())));
  }

  /**
   * Lowest world y of the body, for putting it on a floor: the minimum over all landmarks and all contact points. Joint centres are NOT used,
   * and the skin only when asked (options.skin = true): the skinned bounding box visits every vertex of the skin, which is too slow for IK loops
   * (DESIGN 2.3 lists skin bounds; this is the one deviation, so that the default stays cheap). The landmark set must therefore
   * contain the lowest points of the body in every posture (heels, ball and toes of the feet, ischial tuberosities, buttocks, knees,
   * hands, elbows, back of the head, ...), which fit.js guarantees through its contact sets. Those are SKIN points of the body (the buttock extremity,
   * the deltoid, the back of the head, the sole of the heel): the bones of the skeleton view stay within 2 mm of the floor or above it in every lying,
   * kneeling and crawling posture tested (rig.test.mjs). A skin built from the same shape stations does not reach further than the landmarks;
   * { skin: true } is the way to check that for a given skin builder (it returns the lower of the two).
   */
  lowestY({ skin = false } = {}) {
    this._alive();
    let y = Infinity;
    const v = this._v;
    for (const l of this._lm.values()) { this.kin.toWorld(l.joint, l.off, v); if (v.y < y) y = v.y; }
    for (const set of this._contacts.values()) {
      for (const c of set) {
        if (c.lm !== undefined) continue; // landmark ids are covered above
        this.kin.toWorld(c.joint, c.off, v); if (v.y < y) y = v.y;
      }
    }
    if (y === Infinity) for (const id of this.bones.keys()) { this.kin.position(id, v); if (v.y < y) y = v.y; } // no landmarks at all: joint centres
    if (skin && this.skin) {
      this.group.updateMatrixWorld(true);
      const m = this.skin;
      if (m.isSkinnedMesh) m.computeBoundingBox(); // in the pose of the bones now (the cached box would be the bind pose's)
      else if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
      const box = (m.isSkinnedMesh ? m.boundingBox : m.geometry.boundingBox).clone().applyMatrix4(m.matrixWorld);
      if (!box.isEmpty() && box.min.y < y) y = box.min.y;
    }
    return y;
  }

  /** World end points { a, b } of an entry of skeleton.js BONES (joint ids or "lm:" landmarks); b = a for bones without a second end (ribs, patella). */
  boneSegment(boneId) {
    this._alive();
    const def = BONE_BY_ID[boneId];
    if (!def) throw new Error(`unknown bone id "${boneId}"`);
    const end = (e) => (e.startsWith("lm:") ? this.landmarkWorld(e.slice(3)) : this.kin.position(e, new THREE.Vector3()));
    const a = end(def.from);
    return { a, b: def.to ? end(def.to) : a.clone() };
  }

  // ---- centre of mass ---------------------------------------------------------------------------------------------------------------------
  _parseMasses(masses) {
    if (masses == null) return [];
    const list = Array.isArray(masses) ? masses : Object.entries(masses).map(([id, m]) => ({ id, ...m }));
    return list.map((m, i) => {
      const c = m.com || m; // { mass, com: { joint, offset } } or flat { mass, joint, offset }
      if (!(typeof m.mass === "number" && m.mass >= 0) || !JOINT_BY_ID[c.joint] || !fin3(c.offset)) throw new Error(`buildRig: body.masses[${m.id ?? i}] needs { mass (kg), com: { joint, offset } }`);
      return { id: m.id ?? String(i), label: m.label ?? m.id ?? String(i), mass: m.mass, joint: c.joint, off: add3(Array.from(c.offset).slice(0, 3), this._moved(c.joint)) };
    });
  }

  _comInto(out) {
    if (!this._segs.length) throw new Error("this body has no segment masses (body.masses)");
    const v = this._v;
    let M = 0;
    out.set(0, 0, 0);
    for (const s of this._segs) { this.kin.toWorld(s.joint, s.off, v); out.addScaledVector(v, s.mass); M += s.mass; }
    if (M > 0) out.multiplyScalar(1 / M);
    return { point: out, mass: M };
  }

  /** Whole-body centre of mass from body.masses: { point, mass } (point is `out`). */
  centerOfMass(out = new THREE.Vector3()) { this._alive(); return this._comInto(out); }

  /** Segment details of the last centerOfMass: [{ id, label, mass, point }] for the current pose (computed on access). */
  get comSegments() {
    this._alive();
    return this._segs.map((s) => ({ id: s.id, label: s.label, mass: s.mass, point: this.kin.toWorld(s.joint, s.off, new THREE.Vector3()) }));
  }

  // ---- display ----------------------------------------------------------------------------------------------------------------------------
  get display() { return this._display; }

  /** Flags that cannot apply (no skin, or built with skeleton: false) stay false. Returns the new display object. */
  setDisplay(partial) {
    this._alive();
    if (!isObj(partial)) throw new TypeError("setDisplay: expected an object of booleans");
    for (const k of Object.keys(partial)) if (!DISPLAY_KEYS.includes(k)) throw new Error(`setDisplay: unknown flag "${k}" (expected ${DISPLAY_KEYS.join(", ")})`);
    const d = { ...this._display };
    for (const [k, v] of Object.entries(partial)) d[k] = !!v;
    if (!this.skin) { d.skin = false; d.wireframe = false; }
    if (!this.view) { d.skeleton = d.joints = d.labels = d.landmarks = d.com = false; }
    this._display = Object.freeze(d);
    if (this.skin) {
      this.skin.visible = d.skin;
      for (const s of this._skinMats) {
        s.m.wireframe = d.wireframe;
        s.m.transparent = d.xray ? true : s.transparent;
        s.m.opacity = d.xray ? Math.min(s.opacity, 0.28) : s.opacity;
        s.m.depthWrite = d.xray ? false : s.depthWrite;
        s.m.needsUpdate = true;
      }
    }
    // markers are hidden by the skin when it is visible (and not x-rayed); with the skeleton alone they are drawn over the bones, which
    // would otherwise swallow most joint centres (hip, knee and shoulder markers lie inside the epiphyses)
    if (this.view) { this.view.setDisplay({ ...d, onTop: d.xray || !d.skin }); this.view.update(); }
    return d;
  }

  // ---- picking, selection, labels ------------------------------------------------------------------------------------------------------------
  /**
   * Nearest visible joint marker hit by the raycaster: { id, point, distance } | null. null when the markers are hidden (or any ancestor of the
   * rig is), and for a missing raycaster (no ray, no hit). opts.tolerance (default 0.012, 0 = exact): a marker is also hit when the ray passes within that fraction of the view height of its
   * centre, so that small markers can be picked with a mouse or a finger; needs raycaster.camera, which Raycaster.setFromCamera sets.
   */
  pickJoint(raycaster, opts) { this._alive(); return this.view && raycaster ? this.view.pickJoint(raycaster, opts) : null; }
  /** Nearest visible bone mesh hit by the raycaster: { id (a BONES id), point, distance } | null. null when the skeleton is hidden. */
  pickBone(raycaster) { this._alive(); return this.view && raycaster ? this.view.pickBone(raycaster) : null; }

  /** Selection ring + local-frame triad with one arrow per DOF (positive direction) on a joint; null clears. */
  select(jointId) {
    this._alive();
    if (jointId != null && !JOINT_BY_ID[jointId]) throw new Error(`unknown joint id "${jointId}"`);
    this.selected = jointId ?? null;
    if (this.view) this.view.select(this.selected);
  }

  /** Hover emphasis of a joint marker; null clears. */
  highlight(jointId) {
    this._alive();
    if (jointId != null && !JOINT_BY_ID[jointId]) throw new Error(`unknown joint id "${jointId}"`);
    this.highlighted = jointId ?? null;
    if (this.view) this.view.highlight(this.highlighted);
  }

  /** Label positions for the viewport's HTML overlay: [{ id, text, position: Vector3, kind: "joint"|"landmark"|"dof", ... }]. */
  labelAnchors() {
    this._alive();
    return this.view ? this.view.labelAnchors() : [];
  }

  // ---- lifecycle ---------------------------------------------------------------------------------------------------------------------------
  _alive() {
    if (this._disposed) throw new Error("this rig was disposed");
  }

  /** Frees every geometry, material and texture the rig created (the skin through its builder) and detaches the group. Idempotent. */
  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this._listeners.clear();
    if (this.view) this.view.dispose();
    if (this._skinHandle) {
      try {
        if (typeof this._skinHandle.dispose === "function") this._skinHandle.dispose();
        else {
          this.skin.geometry?.dispose();
          for (const m of [].concat(this.skin.material)) m.dispose();
        }
      } finally {
        // the bone texture belongs to the Skeleton, not to the geometry or material, and most builders' dispose() forgets it (idempotent)
        for (const m of this._skinned) m.skeleton?.dispose();
      }
    }
    this.group.removeFromParent();
    this.group.clear();
    this.skin = null;
  }
}

/** Build the rig of a BodyModel. options: { skinBuilder, skeleton = true, quality = "high" | "low" }. */
export function buildRig(body, options) {
  return new Rig(body, options);
}
