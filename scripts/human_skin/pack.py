"""Pack the rigged meshes into the assets of site/js/human/realskin.js (step 3 of scripts/human_skin).

Input: $HSKIN_WORK/template-<sex>.json (template.mjs) and $HSKIN_WORK/rigged-<sex>.npz (rig_mesh.py).
Output: site/assets/human/skin-<sex>.json (manifest) and skin-<sex>.bin (little-endian arrays, offsets in the manifest).
Usage: python3 scripts/human_skin/pack.py [M] [F]

Per vertex: the neutral position (int16, quantized per axis over the bounding box), four joints (uint8, skeleton.js JOINTS order) and
weights (uint8, summing to 255), two fitting regions (uint8 ids into realskin.js REGIONS) and the weight of the first (uint8 of 255).
Regions are the sums of the skin weights of their joints, smoothed over the surface (so that two fitted regions blend over a few
centimetres instead of meeting at a seam). The manifest holds the template joint centres in the neutral pose, the horizontal sections
of the mesh at the template's ring heights (only those that cut the tube cleanly: a section within a factor 0.6 to 1.6 of the template's
ring in both breadth and depth; the others are listed in `dropped`), the mesh's own hand and foot measures, and the template's head
measures.
"""
import json
import os
import sys
from pathlib import Path

import numpy as np

WORK = os.environ.get("HSKIN_WORK", "/tmp/hm/skin")
OUT = Path(__file__).resolve().parents[2] / "site" / "assets" / "human"
SMOOTH = 12  # iterations of neighbour averaging of the region weights (edges are about 5 mm)


def unit(v):
    v = np.asarray(v, float)
    return v / np.linalg.norm(v)


def edges_of(F):
    e = np.concatenate([F[:, [0, 1]], F[:, [1, 2]], F[:, [2, 0]]])
    e = np.sort(e, axis=1)
    return np.unique(e, axis=0)


def smooth(R, E, n, iters):
    deg = np.bincount(E.ravel(), minlength=n).astype(float)[:, None]
    for _ in range(iters):
        acc = np.zeros_like(R)
        np.add.at(acc, E[:, 0], R[E[:, 1]])
        np.add.at(acc, E[:, 1], R[E[:, 0]])
        R = 0.5 * R + 0.5 * acc / np.maximum(deg, 1)
    return R / R.sum(axis=1, keepdims=True)


def pack(sex):
    T = json.load(open(os.path.join(WORK, f"template-{sex}.json")))
    z = np.load(os.path.join(WORK, f"rigged-{sex}.npz"))
    V, F, widx, wval, J = z["V"], z["F"], z["widx"], z["wval"], z["J"]
    ids = [str(i) for i in z["ids"]]
    assert ids == [j["id"] for j in T["joints"]], "joint order differs from the template"
    regions = T["regions"]
    for j in T["joints"]:
        if j["region"] == "neck":
            j["region"] = "torso"  # one tube from the crotch to under the jaw: the neck has too few clean sections to be fitted apart
    rid = {r: k for k, r in enumerate(regions)}
    jreg = np.array([rid[j["region"]] for j in T["joints"]])
    n = len(V)

    # regions: summed skin weights, smoothed
    R = np.zeros((n, len(regions)))
    for k in range(widx.shape[1]):
        np.add.at(R, (np.arange(n), jreg[widx[:, k]]), wval[:, k])
    # above the crotch the hips are trunk (fit.js's buttock and abdomen rings span them; its thigh rings start inside the pelvis)
    crotch = T["landmarks"]["crotch"][1]  # the template's (the mesh is scaled to it; on the mesh's midline the genitals hang lower)
    up = np.clip((V[:, 1] - crotch + 0.01) / 0.04, 0, 1)
    up = up * up * (3 - 2 * up)
    for s in "LR":
        moved = R[:, rid[f"thigh_{s}"]] * up
        R[:, rid[f"thigh_{s}"]] -= moved
        R[:, rid["torso"]] += moved
    R = smooth(R, edges_of(F), n, SMOOTH)
    order = np.argsort(-R, axis=1)[:, :2]
    rw = np.take_along_axis(R, order, axis=1)
    r1 = np.round(255 * rw[:, 0] / rw.sum(axis=1)).astype(np.uint8)
    reg = order.astype(np.uint8)

    # sections of the tubes at the template's ring heights
    stations, dropped = {}, []
    limb = lambda t: [f"{p}_{t[-1]}" for p in (("upper_arm", "forearm", "hand") if "arm" in t else ("thigh", "shank", "foot"))] if t[-2] == "_" else [t]
    T["stations"]["torso"] = sorted({r["id"]: r for r in T["stations"]["torso"] + T["stations"]["neck"]}.values(), key=lambda r: r["y"])
    T["stations"]["neck"] = []
    for tube, rings in T["stations"].items():
        own = R[:, [rid[x] for x in limb(tube)]].sum(axis=1) > 0.6  # a section of a limb is measured on the whole limb (a knee is half thigh, half shank)
        keep = []
        for ring in rings:
            for half in (0.006, 0.012):
                m = own & (np.abs(V[:, 1] - ring["y"]) < half)
                if m.sum() >= 24:
                    break
            if m.sum() < 24:
                dropped.append(f"{tube}/{ring['id']} (no section)")
                continue
            P = V[m]
            cx, cz = 0.5 * (P[:, 0].min() + P[:, 0].max()), 0.5 * (P[:, 2].min() + P[:, 2].max())
            rx, rz = 0.5 * np.ptp(P[:, 0]), 0.5 * np.ptp(P[:, 2])
            qx, qz = rx / ring["rx"], rz / ring["rz"]
            if not (0.6 < qx < 1.6 and 0.6 < qz < 1.6):
                dropped.append(f"{tube}/{ring['id']} (x {qx:.2f}, z {qz:.2f} of the ring)")
                continue
            keep.append({"id": ring["id"], "y": round(ring["y"], 5), "cx": round(cx, 5), "cz": round(cz, 5), "rx": round(rx, 5), "rz": round(rz, 5),
                         "t": [round(ring[k], 5) for k in ("cx", "cz", "rx", "rz")]})
        stations[tube] = keep

    # the mesh's own hand and foot measures (realskin.js scales those regions to the body's)
    P = {i: J[k] for k, i in enumerate(ids)}
    dims = {"head": T["dims"]["head"]}
    thumb = np.isin(widx, [ids.index(i) for i in ids if i.startswith("thumb")]) & (wval > 0.3)
    thumb = thumb.any(axis=1)
    for s in "LR":
        hand = R[:, rid[f"hand_{s}"]] > 0.5
        a = unit(P[f"middle_mcp_{s}"] - P[f"wrist_{s}"])
        b = P[f"index_mcp_{s}"] - P[f"little_mcp_{s}"]
        b = unit(b - (b @ a) * a)
        q = V - P[f"wrist_{s}"]
        ta = q @ a
        lm = np.linalg.norm(P[f"middle_mcp_{s}"] - P[f"wrist_{s}"])
        knuck = hand & ~thumb & (ta > 0.75 * lm) & (ta < 1.0 * lm)
        dims[f"hand_{s}"] = {"length": round(float(ta[hand].max()), 5), "breadth": round(float(np.ptp(q[knuck] @ b)), 5)}
        foot = R[:, rid[f"foot_{s}"]] > 0.5
        an, mt = P[f"ankle_{s}"], P[f"mtp_{s}"]
        u = unit([mt[0] - an[0], 0.0, mt[2] - an[2]])
        lat = np.cross([0.0, 1.0, 0.0], u)
        qf = V - an
        ball = foot & (np.abs((V - mt) @ u) < 0.02)
        dims[f"foot_{s}"] = {"length": round(float(np.ptp(qf[foot] @ u)), 5), "breadth": round(float(np.ptp(qf[ball] @ lat)), 5), "ankle": round(float(an[1]), 5)}

    # quantize and write
    eyes = [(z["eyeL"], z["eyeLF"]), (z["eyeR"], z["eyeRF"])]
    allp = np.concatenate([V] + [e for e, _ in eyes])
    lo, hi = allp.min(axis=0) - 1e-4, allp.max(axis=0) + 1e-4
    step = (hi - lo) / 65535
    qpos = lambda p: np.round((p - lo) / step).astype(np.uint16)
    w8 = np.floor(wval * 255).astype(np.int32)
    w8[np.arange(n), 0] += 255 - w8.sum(axis=1)  # exactly 255 per vertex
    chunks, layout, offset = [], {}, 0

    def put(name, arr):
        nonlocal offset
        b = np.ascontiguousarray(arr).tobytes()
        pad = (-offset) % 4
        if pad:
            chunks.append(b"\0" * pad)
            offset += pad
        layout[name] = {"offset": offset, "length": int(arr.size), "type": str(arr.dtype)}
        chunks.append(b)
        offset += len(b)
    put("position", qpos(V))
    put("index", F.astype(np.uint16))
    put("skinIndex", widx.astype(np.uint8))
    put("skinWeight", w8.astype(np.uint8))
    put("region", reg)
    put("regionWeight", r1)
    for s, (ev, ef) in zip("LR", eyes):
        put(f"eye{s}Position", qpos(ev))
        put(f"eye{s}Index", ef.astype(np.uint16))
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / f"skin-{sex}.bin").write_bytes(b"".join(chunks))
    manifest = {
        "version": 1,
        "source": "Blender Studio Human Base Meshes v1.4.1 (CC0), GEO-body_" + ("male" if sex == "M" else "female") + "_realistic, multires level 1; rigged by scripts/human_skin",
        "sex": sex, "template": {"label": T["profile"], "stature": T["stature"], "joints": {j["id"]: [round(c, 6) for c in j["p"]] for j in T["joints"]},
                                  "rings": {t: [{k: (round(r[k], 5) if k != "id" else r[k]) for k in ("id", "y", "cx", "cz", "rx", "rz")} for r in rs] for t, rs in T["stations"].items() if rs}},
        "vertices": n, "triangles": int(len(F)),
        "quant": {"origin": [round(float(x), 7) for x in lo], "step": [float(x) for x in step]},
        "layout": layout, "regions": regions,
        "joints": {i: [round(float(c), 6) for c in P[i]] for i in ids},
        "crotch": round(float(crotch), 5), "stations": stations, "dropped": dropped, "dims": T["dims"], "meshDims": dims,
    }
    (OUT / f"skin-{sex}.json").write_text(json.dumps(manifest, separators=(",", ":")) + "\n")
    print(sex, f"{n} vertices, {len(F)} triangles, {offset / 1e6:.2f} MB; dropped sections: {', '.join(dropped) or 'none'}")
    print("   dims", dims)


if __name__ == "__main__":
    for sex in (sys.argv[1:] or ["M", "F"]):
        pack(sex)
