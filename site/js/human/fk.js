// Pure forward kinematics for the rig of skeleton.js, without a three.js scene graph. Used by fit.js (fit report, seated
// reference posture), pose validation, IK solvers and the tests; rig.js builds the same chain out of THREE.Bone objects and
// a test asserts that both agree.
//
// World pose of joint i (parent p):   Q_i = Q_p * q_i(angles)        P_i = P_p + Q_p * offset_i
// Root (pelvis):                      Q_0 = Ry(heading) * exp(swing(flex, lat)) * twist(rot)        P_0 = (x, y, z)
// q_i is the swing-twist rotation of skeleton.js (jointQuaternion). Everything is stored in preallocated Float64Arrays, so
// solve() does not allocate: IK can call it thousands of times per second.
// solve() throws (RangeError) on a non-finite angle or root value rather than propagate NaN into every distal joint, and is
// atomic: it computes into scratch buffers and publishes them only when the whole pose is valid, so a throw leaves the previous pose.
import * as THREE from "three";
import { JOINTS, writeJointQuaternion, checkedAngles, checkRoot } from "./skeleton.js";

const D2R = Math.PI / 180;
const N = JOINTS.length;
const IDS = JOINTS.map((j) => j.id);
const INDEX = new Map(IDS.map((id, i) => [id, i]));
const PARENT = Int32Array.from(JOINTS.map((j) => (j.parent == null ? -1 : INDEX.get(j.parent))));
const NDOF = Int8Array.from(JOINTS.map((j) => j.dof.length));
const EMPTY = Object.freeze({});
const NONE = Object.freeze([]);

function unknownJoint(id, where) {
  return new Error(`unknown joint id "${id}"${where ? ` in ${where}` : ""}`);
}

export class Kinematics {
  /**
   * @param {Object<string, number[]>} offsets neutral rest offsets in metres relative to the parent joint centre, for every
   *   joint except the pelvis (its offset is ignored: the root position comes from solve()). Arrays [x, y, z] or {x, y, z}.
   */
  constructor(offsets) {
    this.ids = IDS.slice(); // joint ids in solve order (parents first)
    this.count = N;
    /** World joint centres, [x0, y0, z0, x1, ...] in `ids` order (metres). Valid after solve(); read-only for callers. */
    this.positions = new Float64Array(3 * N);
    /** World joint orientations [x, y, z, w] per joint in `ids` order. */
    this.quaternions = new Float64Array(4 * N);
    this.offsets = new Float64Array(3 * N);
    this.parentIndex = PARENT.slice(); // a copy: the module-level table stays private to solve()
    /**
     * When true (default) solve() checks `angles` for unknown joint ids by enumerating its keys, which allocates in V8 for large
     * dictionary-mode objects, and validates every angle and root value (type, finiteness, holes = 0), which boxes doubles. IK
     * loops that reuse one vetted object set it to false: solve() is then allocation-free and relies on the final finiteness check
     * only (a string would be coerced, a hole would give a "non-finite angle" error).
     */
    this.strict = true;
    this._P = new Float64Array(3 * N); // scratch for solve(): swapped in only on success
    this._Q = new Float64Array(4 * N);
    this._t = new Float64Array(8);
    this._ra = new Float64Array(3);
    this._holes = new Float64Array(3); // scratch for angle arrays with holes
    this.setOffsets(offsets);
    this.solve(EMPTY, EMPTY);
  }

  /**
   * Replace all rest offsets (e.g. after the profile changed). Throws for unknown ids and for a missing or non-finite offset; on
   * a throw the previous offsets are untouched. An offset is an array / typed array [x, y, z] or an object {x, y, z}.
   */
  setOffsets(offsets) {
    if (!offsets) throw new Error("offsets are required");
    for (const k in offsets) if (!INDEX.has(k)) throw unknownJoint(k, "offsets");
    const o = new Float64Array(3 * N); // staged, then copied: all or nothing
    for (let i = 1; i < N; i++) {
      const v = offsets[IDS[i]];
      const seq = v != null && typeof v === "object" && typeof v.length === "number";
      const x = v == null ? NaN : seq ? v[0] : v.x, y = v == null ? NaN : seq ? v[1] : v.y, z = v == null ? NaN : seq ? v[2] : v.z;
      if (!(Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z))) throw new Error(`missing or non-finite rest offset for joint "${IDS[i]}"`);
      o[3 * i] = x; o[3 * i + 1] = y; o[3 * i + 2] = z;
    }
    this.offsets.set(o);
    return this;
  }

  /** Index of a joint in `ids`, `positions` and `quaternions`. */
  index(id) {
    const i = INDEX.get(id);
    if (i === undefined) throw unknownJoint(id);
    return i;
  }

  /**
   * @param {Object<string, number[]>} angles degrees in DOF order per joint id; missing joints / entries are 0. Region
   *   expansion (lumbar/thoracic/cervical totals) and "_LR" keys must be expanded beforehand (skeleton.js).
   *   An optional `pelvis` entry is an extra local rotation applied after the root orientation (normally absent).
   * @param {{x?, y?, z?, heading?, flex?, lat?, rot?}} root pelvis joint-centre position (m) and orientation (deg).
   */
  solve(angles, root) {
    const A = angles || EMPTY, R = root || EMPTY;
    // strict: full input validation (boxes doubles, so it allocates); strict = false is the IK fast path, see the field below
    if (this.strict) checkRoot(R);
    if (this.strict) for (const k in A) if (!INDEX.has(k)) throw unknownJoint(k, "angles");
    const P = this._P, Q = this._Q, off = this.offsets, t = this._t;

    // root orientation: Ry(heading) * swing-twist(flex, lat, rot)
    const ra = this._ra;
    ra[0] = R.flex ?? 0; ra[1] = R.lat ?? 0; ra[2] = R.rot ?? 0;
    writeJointQuaternion(JOINTS[0], ra, t, 0);
    const h = 0.5 * (R.heading ?? 0) * D2R, hs = Math.sin(h), hc = Math.cos(h);
    let qx = hc * t[0] + hs * t[2], qy = hc * t[1] + hs * t[3], qz = hc * t[2] - hs * t[0], qw = hc * t[3] - hs * t[1];
    const pa = A.pelvis;
    if (pa !== undefined) {
      if (pa === null || typeof pa.length !== "number") throw new TypeError('angles for "pelvis" must be an array');
      writeJointQuaternion(JOINTS[0], this.strict ? checkedAngles(JOINTS[0], pa, this._holes) : pa, t, 4);
      const bx = t[4], by = t[5], bz = t[6], bw = t[7];
      const nx = qw * bx + bw * qx + (qy * bz - qz * by), ny = qw * by + bw * qy + (qz * bx - qx * bz);
      const nz = qw * bz + bw * qz + (qx * by - qy * bx), nw = qw * bw - (qx * bx + qy * by + qz * bz);
      qx = nx; qy = ny; qz = nz; qw = nw;
    }
    Q[0] = qx; Q[1] = qy; Q[2] = qz; Q[3] = qw;
    P[0] = R.x ?? 0; P[1] = R.y ?? 0; P[2] = R.z ?? 0;
    // NaN / Infinity guard (s - s is 0 only for finite s): one bad slider value must not destroy the whole rig silently.
    const s0 = qx + qy + qz + qw + P[0] + P[1] + P[2];
    if (s0 - s0 !== 0) throw new RangeError("non-finite root position or orientation");

    for (let i = 1; i < N; i++) {
      const p4 = 4 * PARENT[i], p3 = 3 * PARENT[i], i3 = 3 * i, i4 = 4 * i;
      let a = A[IDS[i]];
      if (a === undefined) a = NONE;
      else {
        if (a === null || typeof a.length !== "number") throw new TypeError(`angles for "${IDS[i]}" must be an array in DOF order`);
        if (this.strict) a = checkedAngles(JOINTS[i], a, this._holes); // strings / null / NaN throw; holes (undefined) are 0, as in jointQuaternion
        else if (a.length > NDOF[i]) this._extra(i, a);
      }
      writeJointQuaternion(JOINTS[i], a, t, 0);
      const sq = t[0] + t[1] + t[2] + t[3]; // finite angles give a unit quaternion
      if (sq - sq !== 0) throw new RangeError(`non-finite angle for joint "${IDS[i]}"`);
      const x = Q[p4], y = Q[p4 + 1], z = Q[p4 + 2], w = Q[p4 + 3];
      // position: P_i = P_p + Q_p * offset
      const ox = off[i3], oy = off[i3 + 1], oz = off[i3 + 2];
      const tx = 2 * (y * oz - z * oy), ty = 2 * (z * ox - x * oz), tz = 2 * (x * oy - y * ox);
      P[i3] = P[p3] + ox + w * tx + (y * tz - z * ty);
      P[i3 + 1] = P[p3 + 1] + oy + w * ty + (z * tx - x * tz);
      P[i3 + 2] = P[p3 + 2] + oz + w * tz + (x * ty - y * tx);
      // orientation: Q_i = Q_p * q_i
      const bx = t[0], by = t[1], bz = t[2], bw = t[3];
      Q[i4] = w * bx + bw * x + (y * bz - z * by);
      Q[i4 + 1] = w * by + bw * y + (z * bx - x * bz);
      Q[i4 + 2] = w * bz + bw * z + (x * by - y * bx);
      Q[i4 + 3] = w * bw - (x * bx + y * by + z * bz);
    }
    this.positions.set(P);
    this.quaternions.set(Q);
    return this;
  }

  // Only reached (strict = false) for arrays longer than the joint's DOF list: trailing zeros are harmless, anything else is a caller bug.
  _extra(i, a) {
    for (let k = NDOF[i]; k < a.length; k++) {
      if (a[k]) throw new RangeError(`joint "${IDS[i]}" has ${NDOF[i]} DOF (${JOINTS[i].dof.map((d) => d.key).join(", ")}), got ${a.length} values`);
    }
  }

  /** World position of a joint centre (m) after solve(). */
  position(id, out = new THREE.Vector3()) {
    const i = 3 * this.index(id), P = this.positions;
    return out.set(P[i], P[i + 1], P[i + 2]);
  }

  /** World orientation of a joint frame after solve(). */
  quaternion(id, out = new THREE.Quaternion()) {
    const i = 4 * this.index(id), Q = this.quaternions;
    return out.set(Q[i], Q[i + 1], Q[i + 2], Q[i + 3]);
  }

  /** A point given in the neutral frame as an offset from the joint centre (e.g. a landmark offset) -> world coordinates. */
  toWorld(id, localPoint, out = new THREE.Vector3()) {
    const j = this.index(id), i3 = 3 * j, i4 = 4 * j, P = this.positions, Q = this.quaternions;
    const vx = Array.isArray(localPoint) ? localPoint[0] : localPoint.x;
    const vy = Array.isArray(localPoint) ? localPoint[1] : localPoint.y;
    const vz = Array.isArray(localPoint) ? localPoint[2] : localPoint.z;
    const x = Q[i4], y = Q[i4 + 1], z = Q[i4 + 2], w = Q[i4 + 3];
    const tx = 2 * (y * vz - z * vy), ty = 2 * (z * vx - x * vz), tz = 2 * (x * vy - y * vx);
    return out.set(
      P[i3] + vx + w * tx + (y * tz - z * ty),
      P[i3 + 1] + vy + w * ty + (z * tx - x * tz),
      P[i3 + 2] + vz + w * tz + (x * ty - y * tx)
    );
  }
}
