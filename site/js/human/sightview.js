// The line-of-sight overlay of the 3D view (the "Line of sight" toggle): MIL-STD-1472H Figure 2 drawn from the figure's eyes. The normal line of sight
// (15 degrees below the head's horizontal), the 30 degree cone about it (warnings and critical indicators, 5.1.2.2.3.11, 5.2.3.1.11), the 90 degree cone
// (any display, at most 45 degrees off, 5.10.3.6.1.5) and a line to each display and control, coloured by what the checks found:
//   green: in the 30 degree cone and nothing in the way; amber: outside the 30 degree cone (acceptable unless it carries warnings);
//   red: outside 45 degrees, hidden behind an object, or behind the figure's own arm.
// The facts come from compliance.js sightFacts; this module only draws them.
//   createSightView(viewport) -> { update(sight), clear(), dispose() }
import * as THREE from "three";

export const SIGHT_COLORS = Object.freeze({ good: 0x1f9d55, warn: 0xd99a1e, bad: 0xd0453b, los: 0x2a78d6, horizon: 0x8a929b });
export const CONTROL_RANGE = 1.3; // m: controls this close to the eye are drawn and checked (as in mil1472.js)

/** The colour key of a target: "good" | "warn" | "bad", or null when it is not drawn (a display behind the figure, a control out of reach). */
export function sightLevel(t) {
  if (t.kind === "display") {
    if (Math.abs(t.horiz) > 90) return null;
    if (t.blockedBy || t.arm || t.angle > 45) return "bad";
    return t.angle <= 15 ? "good" : "warn";
  }
  if (t.distance > CONTROL_RANGE) return null;
  return t.blockedBy ? "bad" : "good";
}

export function createSightView(viewport) {
  const group = new THREE.Group();
  group.name = "hm-sight";
  group.renderOrder = 5;
  viewport.add(group);
  const owned = [];
  const mat = (m) => { owned.push(m); return m; };
  const lineMat = (color, opts = {}) => mat(new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.95, ...opts }));
  const coneMat = (color, opacity) => mat(new THREE.MeshBasicMaterial({ color, transparent: true, opacity, side: THREE.DoubleSide, depthWrite: false }));
  const M = {
    los: lineMat(SIGHT_COLORS.los), horizon: new THREE.LineDashedMaterial({ color: SIGHT_COLORS.horizon, dashSize: 0.04, gapSize: 0.03, depthTest: false, transparent: true }),
    inner: coneMat(SIGHT_COLORS.good, 0.13), outer: coneMat(SIGHT_COLORS.warn, 0.06), innerRim: lineMat(SIGHT_COLORS.good), outerRim: lineMat(SIGHT_COLORS.warn, { opacity: 0.6 }),
    good: lineMat(SIGHT_COLORS.good), warn: lineMat(SIGHT_COLORS.warn), bad: lineMat(SIGHT_COLORS.bad),
    dot: { good: mat(new THREE.MeshBasicMaterial({ color: SIGHT_COLORS.good, depthTest: false })), warn: mat(new THREE.MeshBasicMaterial({ color: SIGHT_COLORS.warn, depthTest: false })), bad: mat(new THREE.MeshBasicMaterial({ color: SIGHT_COLORS.bad, depthTest: false })) },
  };
  owned.push(M.horizon);
  const dotGeo = new THREE.SphereGeometry(0.012, 12, 8);

  function clear() {
    for (const c of [...group.children]) { group.remove(c); if (c.geometry && c.geometry !== dotGeo) c.geometry.dispose(); }
  }
  const line = (a, b, m) => {
    const l = new THREE.Line(new THREE.BufferGeometry().setFromPoints([a, b]), m);
    l.renderOrder = 6;
    if (m === M.horizon) l.computeLineDistances();
    group.add(l);
    return l;
  };
  /** A cone with its apex at the eye around `axis` (unit), half-angle in degrees, `len` long, and a ring at its base. */
  function cone(eye, axis, half, len, m, rim) {
    const r = Math.tan(half * Math.PI / 180) * len;
    const g = new THREE.ConeGeometry(r, len, 48, 1, true).translate(0, -len / 2, 0); // apex at the origin, opening down -Y
    const mesh = new THREE.Mesh(g, m);
    mesh.position.copy(eye);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, -1, 0), axis);
    group.add(mesh);
    const ring = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(Array.from({ length: 64 }, (_, i) => new THREE.Vector3(Math.cos(i / 64 * 2 * Math.PI) * r, -len, Math.sin(i / 64 * 2 * Math.PI) * r))), rim);
    ring.position.copy(eye);
    ring.quaternion.copy(mesh.quaternion);
    group.add(ring);
  }

  function update(sight) {
    clear();
    if (!sight) { viewport.requestRender?.(); return; }
    const eye = new THREE.Vector3(...sight.eye), los = new THREE.Vector3(...sight.los), fwd = new THREE.Vector3(...sight.forward);
    cone(eye, los, 45, 0.55, M.outer, M.outerRim);
    cone(eye, los, 15, 1.1, M.inner, M.innerRim);
    line(eye, eye.clone().addScaledVector(los, 1.6), M.los);
    line(eye, eye.clone().addScaledVector(new THREE.Vector3(fwd.x, 0, fwd.z).normalize(), 1.2), M.horizon);
    for (const t of sight.targets ?? []) {
      const lv = sightLevel(t);
      if (!lv) continue;
      const p = new THREE.Vector3(...t.point);
      line(eye, p, M[lv]);
      const d = new THREE.Mesh(dotGeo, M.dot[lv]);
      d.position.copy(p);
      d.renderOrder = 7;
      group.add(d);
    }
    viewport.requestRender?.();
  }

  function dispose() {
    clear();
    viewport.remove(group);
    dotGeo.dispose();
    for (const m of owned) m.dispose();
  }
  return { group, update, clear, dispose };
}
