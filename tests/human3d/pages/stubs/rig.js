// TEST FIXTURE, not part of the site: a minimal stand-in for site/js/human/rig.js (DESIGN.md 2.3) so that the shell and the viewer can be tested
// while the real rig is missing (test_viewer.py routes /js/human/rig.js here only when the real file does not exist, or with HM_STUB=1).
// It implements the same surface the shell uses: group, bones, angles, setPose/getPose, pickJoint, select, highlight, labelAnchors, setDisplay,
// onChange, centerOfMass, landmarkIds/landmarkWorld, dispose. The figure is static: poses are stored, not applied.
import * as THREE from "three";
import { JOINTS, JOINT_BY_ID } from "/js/human/skeleton.js";

const lerp3 = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const POS = {
  pelvis: [0, 0.97, 0], head: [0, 1.6, 0.01], jaw: [0, 1.6, 0.03], eye_L: [0.03, 1.68, 0.08], eye_R: [-0.03, 1.68, 0.08],
};
function spine(ids, a, b) { ids.forEach((id, i) => { POS[id] = lerp3(a, b, ids.length === 1 ? 0 : i / (ids.length - 1)); }); }
spine(["L5", "L4", "L3", "L2", "L1"], [0, 1.02, 0], [0, 1.15, 0.01]);
spine(["T12", "T11", "T10", "T9", "T8", "T7", "T6", "T5", "T4", "T3", "T2", "T1"], [0, 1.2, 0.01], [0, 1.42, 0]);
spine(["C7", "C6", "C5", "C4", "C3", "C2", "C1"], [0, 1.46, 0], [0, 1.58, 0.01]);
for (const [s, k] of [["L", 1], ["R", -1]]) {
  Object.assign(POS, {
    [`clavicle_${s}`]: [0.02 * k, 1.43, 0.02], [`shoulder_${s}`]: [0.2 * k, 1.43, 0], [`elbow_${s}`]: [0.21 * k, 1.15, 0], [`forearm_${s}`]: [0.21 * k, 1.15, 0],
    [`wrist_${s}`]: [0.22 * k, 0.9, 0.02], [`hip_${s}`]: [0.09 * k, 0.93, 0], [`knee_${s}`]: [0.1 * k, 0.5, 0.01], [`ankle_${s}`]: [0.1 * k, 0.08, -0.03], [`mtp_${s}`]: [0.1 * k, 0.03, 0.12],
  });
  [["thumb_cmc", 0.9, 0.04], ["thumb_mcp", 0.86, 0.06], ["thumb_ip", 0.83, 0.07]].forEach(([n, y, z]) => { POS[`${n}_${s}`] = [0.215 * k, y, z]; });
  ["index", "middle", "ring", "little"].forEach((f, i) => ["mcp", "pip", "dip"].forEach((n, j) => { POS[`${f}_${n}_${s}`] = [(0.22 - 0.008 * i) * k, 0.84 - 0.035 * j, 0.015 - 0.012 * i]; }));
}
const SEGMENTS = [["pelvis", "L5", 0.15], ["L5", "L1", 0.14], ["L1", "T1", 0.16], ["T1", "C7", 0.06], ["C7", "C1", 0.05], ["C1", "head", 0.045]];
for (const s of ["L", "R"]) SEGMENTS.push([`clavicle_${s}`, `shoulder_${s}`, 0.04], [`shoulder_${s}`, `elbow_${s}`, 0.045], [`elbow_${s}`, `wrist_${s}`, 0.038],
  [`hip_${s}`, `knee_${s}`, 0.075], [`knee_${s}`, `ankle_${s}`, 0.055], [`ankle_${s}`, `mtp_${s}`, 0.04]);

export function buildRig(body, options = {}) {
  const scale = (body?.stature ?? 1.75) / 1.75;
  const group = new THREE.Group();
  group.name = "rig";
  group.scale.setScalar(scale);
  const skinMat = new THREE.MeshStandardMaterial({ color: 0xc89a7c, roughness: 0.75 });
  const skin = new THREE.Group();
  skin.name = "skin";
  for (const [a, b, r] of SEGMENTS) {
    const A = new THREE.Vector3(...POS[a]), B = new THREE.Vector3(...POS[b]), len = A.distanceTo(B);
    const m = new THREE.Mesh(new THREE.CapsuleGeometry(r, Math.max(len - 2 * r, 0.001), 4, 12), skinMat);
    m.position.copy(A).add(B).multiplyScalar(0.5);
    m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), B.clone().sub(A).normalize());
    m.castShadow = m.receiveShadow = true;
    skin.add(m);
  }
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.1, 20, 14), skinMat);
  head.position.set(0, 1.68, 0.01); head.castShadow = true; skin.add(head);
  for (const s of [1, -1]) { const f = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.05, 0.25), skinMat); f.position.set(0.1 * s, 0.03, 0.06); f.castShadow = true; skin.add(f); }
  group.add(skin);
  const boneMat = new THREE.MeshStandardMaterial({ color: 0xe8dcc3, roughness: 0.6 });
  const skeleton = new THREE.Group();
  skeleton.visible = false;
  for (const [a, b] of SEGMENTS) {
    const A = new THREE.Vector3(...POS[a]), B = new THREE.Vector3(...POS[b]);
    const m = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, A.distanceTo(B), 6), boneMat);
    m.position.copy(A).add(B).multiplyScalar(0.5);
    m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), B.clone().sub(A).normalize());
    skeleton.add(m);
  }
  group.add(skeleton);

  const markers = new THREE.Group(), markerMat = new THREE.MeshBasicMaterial({ color: 0x1c5cab, depthTest: false, transparent: true }), selMat = new THREE.MeshBasicMaterial({ color: 0xeb6834, depthTest: false });
  markers.visible = false; markers.renderOrder = 10;
  const bones = new Map(), meshes = new Map(), angles = {};
  for (const j of JOINTS) {
    bones.set(j.id, new THREE.Bone());
    angles[j.id] = j.dof.map(() => 0);
    const p = POS[j.id];
    if (!p) continue;
    const m = new THREE.Mesh(new THREE.SphereGeometry(0.018, 10, 8), markerMat);
    m.position.set(...p); m.userData.joint = j.id; m.renderOrder = 10;
    markers.add(m); meshes.set(j.id, m);
  }
  group.add(markers);
  const rig = {
    body, group, bones, angles, skin: null, root: { x: 0, y: 0, z: 0, heading: 0, flex: 0, lat: 0, rot: 0 },
    display: { skin: true, skeleton: false, joints: false, labels: false, axes: false, landmarks: false, wireframe: false, xray: false, com: false },
    landmarkIds: ["vertex", "acromion_L", "acromion_R", "stylion_L"], _cbs: new Set(), _sel: null,
    setDisplay(partial) {
      Object.assign(this.display, partial);
      skin.visible = this.display.skin; skeleton.visible = this.display.skeleton; markers.visible = this.display.joints;
      skinMat.transparent = this.display.xray; skinMat.opacity = this.display.xray ? 0.25 : 1; skinMat.needsUpdate = true;
    },
    setPose({ root, angles: a } = {}) { if (root) Object.assign(this.root, root); if (a) for (const [k, v] of Object.entries(a)) this.angles[k] = [...v]; for (const f of this._cbs) f(); return { clamped: [] }; },
    getPose() { return { root: { ...this.root }, angles: structuredClone(this.angles) }; },
    onChange(fn) { this._cbs.add(fn); return () => this._cbs.delete(fn); },
    pickJoint(ray) { if (!markers.visible) return null; const hit = ray.intersectObjects([...meshes.values()], false)[0]; return hit ? { id: hit.object.userData.joint, point: hit.point, distance: hit.distance } : null; },
    pickBone() { return null; },
    select(id) { if (this._sel) { meshes.get(this._sel)?.scale.setScalar(1); meshes.get(this._sel).material = markerMat; } this._sel = id; const m = id && meshes.get(id); if (m) { m.scale.setScalar(1.8); m.material = selMat; } },
    highlight(id) { for (const [k, m] of meshes) m.scale.setScalar(k === id ? 1.5 : k === this._sel ? 1.8 : 1); },
    labelAnchors() { return [...meshes].filter(() => this.display.labels).map(([id, m]) => ({ id, text: JOINT_BY_ID[id].label, position: m.getWorldPosition(new THREE.Vector3()), priority: id === this._sel ? 100 : 0 })); },
    jointWorld(id, out = new THREE.Vector3()) { const m = meshes.get(id); return m ? m.getWorldPosition(out) : out.set(0, 0, 0); },
    landmarkWorld(id, out = new THREE.Vector3()) { return out.set(0, 1.7, 0.05); },
    centerOfMass() { return { point: new THREE.Vector3(0, 1.0, 0), mass: body?.mass ?? 80 }; },
    dispose() { skinMat.dispose(); boneMat.dispose(); markerMat.dispose(); selMat.dispose(); group.traverse((o) => o.geometry?.dispose?.()); },
  };
  rig.setDisplay({});
  return rig;
}
