"""Rig the realistic Human Base Meshes to the 77 joints of skeleton.js and turn them to the neutral pose (step 2 of scripts/human_skin).

Input: the Blender Studio "Human Base Meshes" bundle v1.4.1 (CC0, https://www.blender.org/download/demo-files/ -> Human Base Meshes),
unpacked so that human_base_meshes_bundle.blend lies anywhere under $HSKIN_BUNDLE (default /tmp/hm), and the template bodies written by
template.mjs in $HSKIN_WORK (default /tmp/hm/skin). Output: $HSKIN_WORK/rigged-<sex>.npz, read by pack.py.
Usage: python3 scripts/human_skin/rig_mesh.py [M] [F]    (needs the bpy module; Blender 4.2 to 5.0)

What it does, per sex:
 1. Evaluates GEO-body_<sex>_realistic at multires level $HSKIN_LEVEL (default 1) and its two eyeballs, converts Blender's Z-up, -Y-facing
    axes to the model's (+Y up, +Z anterior, +X the figure's left), centres it, puts the soles at y = 0 and scales it to the template stature.
 2. Places the 77 joints in the A-pose mesh: the spine, neck and head chain on the midline at the template heights, as far in front of or
    behind the centre of the trunk section as the template's joints are; arms from the shoulder along the A-pose arm, the elbow and wrist at
    the template's proportions of the arm and centred in its sections; the hand joints carried over from the template's hand frame (scaled to
    the hand's length and breadth, and the finger joints centred in the finger); legs centred in the leg sections; the foot joints in the
    foot's frame.
 3. Builds an armature with one bone per joint (head at the joint, tail at its main child) and binds the mesh with Blender's bone heat
    weights. jaw, eye_* and forearm_* do not deform.
 4. Turns the upper arms, forearms and hands, the thighs and the shanks to the template's neutral directions (shortest rotation; the feet keep
    their orientation so that the soles stay flat), with volume-preserving skinning, and keeps that as the neutral mesh and joint centres.
"""
import glob
import json
import os
import sys

import bpy
import numpy as np
from mathutils import Matrix, Vector

WORK = os.environ.get("HSKIN_WORK", "/tmp/hm/skin")
BUNDLE = os.environ.get("HSKIN_BUNDLE", "/tmp/hm")
LEVEL = int(os.environ.get("HSKIN_LEVEL", "1"))
NAMES = {"M": "GEO-body_male_realistic", "F": "GEO-body_female_realistic"}
K = 10.0  # Blender works in decimetres here: bone heat weighting fails on the female body at metre scale
NO_DEFORM = ("jaw", "eye_L", "eye_R", "forearm_L", "forearm_R")
FINGERS = ("index", "middle", "ring", "little")


def mesh_arrays(obj, dg):
    me = obj.evaluated_get(dg).to_mesh()
    me.calc_loop_triangles()
    co = np.empty(len(me.vertices) * 3)
    me.vertices.foreach_get("co", co)
    co = co.reshape(-1, 3)
    tri = np.empty(len(me.loop_triangles) * 3, dtype=np.int64)
    me.loop_triangles.foreach_get("vertices", tri)
    mw = np.array(obj.matrix_world)
    co = co @ mw[:3, :3].T + mw[:3, 3]
    return co, tri.reshape(-1, 3)


def to_model(p):
    """Blender (x, y, z), Z up, facing -Y  ->  model (x, z, -y), Y up, facing +Z."""
    return np.stack([p[:, 0], p[:, 2], -p[:, 1]], axis=1)


def extract(sex):
    path = glob.glob(os.path.join(BUNDLE, "**", "human_base_meshes_bundle.blend"), recursive=True)[0]
    bpy.ops.wm.open_mainfile(filepath=path)
    body = bpy.data.objects[NAMES[sex]]
    for m in body.modifiers:
        if m.type == "MULTIRES":
            m.levels = LEVEL
    bpy.context.view_layer.update()
    dg = bpy.context.evaluated_depsgraph_get()
    V, F = mesh_arrays(body, dg)
    eyes = [mesh_arrays(bpy.data.objects[f"{NAMES[sex]}.eye.{s}"], dg) for s in "LR"]
    return to_model(V), F, [(to_model(v), f) for v, f in eyes]


def central(V, y, half=0.006, gap=0.02):
    """Vertices of the cluster around x = 0 (the trunk) in a horizontal band at height y."""
    idx = np.nonzero(np.abs(V[:, 1] - y) < half)[0]
    if len(idx) == 0:
        return idx
    order = idx[np.argsort(V[idx, 0])]
    x = V[order, 0]
    cuts = np.nonzero(np.diff(x) > gap)[0]
    starts = np.r_[0, cuts + 1]
    ends = np.r_[cuts, len(x) - 1]
    for a, b in zip(starts, ends):
        if x[a] <= 0.01 and x[b] >= -0.01:
            return order[a:b + 1]
    return order


def cluster_near(V, y, x0, half=0.006, gap=0.02):
    """Vertices of the cluster (along x) of a horizontal band at height y that is nearest to x0, on x0's side of the midline."""
    idx = np.nonzero((np.abs(V[:, 1] - y) < half) & (V[:, 0] * np.sign(x0) > 0))[0]
    order = idx[np.argsort(V[idx, 0])]
    x = V[order, 0]
    cuts = np.nonzero(np.diff(x) > gap)[0]
    groups = np.split(order, cuts + 1)
    dist = [0 if V[g, 0].min() <= x0 <= V[g, 0].max() else min(abs(V[g, 0].min() - x0), abs(V[g, 0].max() - x0)) for g in groups]
    return groups[int(np.argmin(dist))]


def unit(v):
    v = np.asarray(v, float)
    return v / np.linalg.norm(v)


def place_joints(V, eyes, T):
    J = {j["id"]: np.array(j["p"], float) for j in T["joints"]}
    LM = {k: np.array(v, float) for k, v in T["landmarks"].items()}
    st = T["stations"]
    mid = sorted([(s["y"], s["cz"]) for s in st["torso"] + st["neck"]])
    czT = lambda y: np.interp(y, [a for a, _ in mid], [b for _, b in mid])

    def czM(y):
        c = central(V, y)
        return 0.5 * (V[c, 2].min() + V[c, 2].max())

    P = {}
    axial = ["pelvis"] + [j["id"] for j in T["joints"] if j["region"] in ("torso", "neck") and not j["id"].startswith("clavicle") and j["id"] != "pelvis"] + ["head"]
    for id_ in axial:
        p = J[id_]
        P[id_] = np.array([0.0, p[1], czM(p[1]) + p[2] - czT(p[1])])
    for s in "LR":
        e = eyes[0 if s == "L" else 1][0]
        P[f"eye_{s}"] = e.mean(axis=0)
    # above T6 a horizontal slice also cuts the shoulders, then the jaw: the head joint is placed from the eyes (as far behind them as the
    # template's), and T5 ... C1 follow the template's curve between T6 and the head
    eyeM = 0.5 * (P["eye_L"] + P["eye_R"])
    eyeT = 0.5 * (J["eye_L"] + J["eye_R"])
    P["head"] = np.array([0.0, J["head"][1], eyeM[2] + J["head"][2] - eyeT[2]])
    upper = ["T5", "T4", "T3", "T2", "T1", "C7", "C6", "C5", "C4", "C3", "C2", "C1"]
    a, b = "T6", "head"
    for id_ in upper:
        f = (J[id_][1] - J[a][1]) / (J[b][1] - J[a][1])
        base_T = J[a][2] + f * (J[b][2] - J[a][2])
        base_M = P[a][2] + f * (P[b][2] - P[a][2])
        P[id_] = np.array([0.0, J[id_][1], base_M + J[id_][2] - base_T])
    P["jaw"] = P["head"] + J["jaw"] - J["head"]
    tips = {"vertex": np.array([0.0, V[:, 1].max(), P["head"][2]])}

    for s, sg in (("L", 1.0), ("R", -1.0)):
        cl = J[f"clavicle_{s}"]
        P[f"clavicle_{s}"] = np.array([cl[0], cl[1], czM(cl[1]) + cl[2] - czT(cl[1])])
        # shoulder: the template's, moved out or in with the lateral edge of the acromion
        ac = LM[f"acromion_{s}"]
        band = np.nonzero((np.abs(V[:, 1] - ac[1]) < 0.006) & (np.abs(V[:, 2] - czM(ac[1])) < 0.08))[0]
        acx = (V[band, 0] * sg).max() * sg
        shT = J[f"shoulder_{s}"]
        sh = np.array([shT[0] + acx - ac[0], shT[1], czM(shT[1]) + shT[2] - czT(shT[1])])
        P[f"shoulder_{s}"] = sh
        # the A-pose arm: fingertip = furthest vertex out and down
        d = V - sh
        upper = V[:, 1] > 0.45 * T["stature"]  # not the feet
        tip = V[upper][np.argmax(d[upper] @ unit([sg, -1.0, 0.0]))]
        d0 = unit(tip - sh)
        t = d @ d0
        perp = np.linalg.norm(d - np.outer(t, d0), axis=1)
        arm = (t > 0.03) & (perp < 0.1) & (sg * V[:, 0] > sg * sh[0] - 0.02)
        lu = np.linalg.norm(J[f"elbow_{s}"] - shT)
        lf = np.linalg.norm(J[f"wrist_{s}"] - J[f"elbow_{s}"])
        lh = np.linalg.norm(LM[f"dactylion_{s}"] - J[f"wrist_{s}"])
        L = (tip - sh) @ d0
        el = V[arm & (np.abs(t - L * lu / (lu + lf + lh)) < 0.008)].mean(axis=0)
        d1 = unit(tip - el)
        t1 = (V - el) @ d1
        wr = V[arm & (np.abs(t1 - np.linalg.norm(tip - el) * lf / (lf + lh)) < 0.006)].mean(axis=0)
        # the glenohumeral centre is on the axis of the upper arm (the A-pose arm hangs in the frontal plane): its depth is the arm's
        uam = V[arm & (np.abs(t - 0.4 * L * lu / (lu + lf + lh)) < 0.008)].mean(axis=0)
        sh[2] = 0.5 * (uam[2] + el[2])
        P[f"elbow_{s}"] = el
        P[f"forearm_{s}"] = el.copy()
        P[f"wrist_{s}"] = wr
        # hand frame: a along the hand, b across the knuckles toward the thumb (forward), c = a x b
        a = unit(tip - wr)
        q = V - wr
        ta = q @ a
        hand = arm & (ta > -0.005) & (np.linalg.norm(q - np.outer(ta, a), axis=1) < 0.07)
        knuck = hand & (ta > 0.06) & (ta < 0.095)
        Q = q[knuck] - np.outer(ta[knuck], a)
        w, vec = np.linalg.eigh(np.cov(Q.T))
        b = unit(vec[:, -1] - (vec[:, -1] @ a) * a)
        if b[2] < 0:
            b = -b
        c = np.cross(a, b)
        breadth = np.ptp(q[knuck] @ b)
        aT = unit(LM[f"dactylion_{s}"] - J[f"wrist_{s}"])
        bT = J[f"index_mcp_{s}"] - J[f"little_mcp_{s}"]
        bT = unit(bT - (bT @ aT) * aT)
        cT = np.cross(aT, bT)
        ka = np.linalg.norm(tip - wr) / lh
        kb = breadth / T["dims"][f"hand_{s}"]["breadth"]

        def carry(pT):
            r = pT - J[f"wrist_{s}"]
            return wr + a * (r @ aT) * ka + b * (r @ bT) * kb + c * (r @ cT) * kb

        hv = V[hand]
        for f in FINGERS + ("thumb",):
            names = [f"thumb_cmc_{s}", f"thumb_mcp_{s}", f"thumb_ip_{s}"] if f == "thumb" else [f"{f}_mcp_{s}", f"{f}_pip_{s}", f"{f}_dip_{s}"]
            for k, n in enumerate(names):
                p = carry(J[n])
                if k > 0:  # inside the finger: centre it among the finger's vertices
                    for _ in range(3):
                        near = hv[np.linalg.norm(hv - p, axis=1) < 0.011]
                        if len(near) > 8:
                            p = near.mean(axis=0)
                P[n] = p
            tips[f"{f}_tip_{s}"] = carry(LM[("dactylion" if f == "middle" else f"{f}_tip") + f"_{s}"])
        # legs: centred in the sections at the template's ring heights
        def leg_centre(y, x0):
            m = cluster_near(V, y, x0)
            return np.array([0.5 * (V[m, 0].min() + V[m, 0].max()), y, 0.5 * (V[m, 2].min() + V[m, 2].max())])
        ring = {r["id"]: r for r in st[f"thigh_{s}"] + st[f"shank_{s}"]}
        for jid, rid in ((f"hip_{s}", "th_prox"), (f"knee_{s}", "sh_knee"), (f"ankle_{s}", "sh_ankle")):
            r = ring[rid]
            c = leg_centre(r["y"], r["cx"])
            jT = J[jid]
            if jid.startswith("hip"):  # the femoral head is above the middle of the thigh (fit.js's thigh rings lie forward by design)
                P[jid] = np.array([c[0], jT[1], c[2]])
            else:
                P[jid] = np.array([c[0] + jT[0] - r["cx"], jT[1], c[2] + jT[2] - r["cz"]])
        # foot frame: heel -> toe, horizontal
        an = P[f"ankle_{s}"]
        foot = (V[:, 1] < an[1]) & (np.abs(V[:, 0] - an[0]) < 0.09)
        fv = V[foot]
        heel, toe = fv[np.argmin(fv[:, 2])], fv[np.argmax(fv[:, 2])]
        u = unit([toe[0] - heel[0], 0.0, toe[2] - heel[2]])
        lat = np.cross([0.0, 1.0, 0.0], u)  # toward +x for a foot pointing +z
        kf = (toe[2] - heel[2]) / T["dims"][f"foot_{s}"]["length"]
        kh = an[1] / J[f"ankle_{s}"][1]

        def carry_foot(pT):
            r = pT - J[f"ankle_{s}"]
            return an + u * r[2] * kf + np.array([0.0, 1.0, 0.0]) * r[1] * kh + lat * r[0] * kf
        P[f"mtp_{s}"] = carry_foot(J[f"mtp_{s}"])
        tips[f"toe_tip_{s}"] = carry_foot(LM[f"toe_tip_{s}"])
    P["pelvis"][2] = 0.5 * (P["hip_L"][2] + P["hip_R"][2])  # the pelvis joint is the middle of the hip joints, as in fit.js
    missing = [j["id"] for j in T["joints"] if j["id"] not in P]
    assert not missing, missing
    return P, tips


def tail_of(id_, P, tips, children):
    s = id_[-1]
    special = {"head": "vertex", f"index_dip_{s}": f"index_tip_{s}", f"middle_dip_{s}": f"middle_tip_{s}", f"ring_dip_{s}": f"ring_tip_{s}",
               f"little_dip_{s}": f"little_tip_{s}", f"thumb_ip_{s}": f"thumb_tip_{s}", f"mtp_{s}": f"toe_tip_{s}"}
    main = {"pelvis": "L5", "T1": "C7", "C1": "head", f"wrist_{s}": f"middle_mcp_{s}", f"elbow_{s}": f"wrist_{s}"}
    if id_ in special:
        return tips[special[id_]]
    if id_ in main:
        return P[main[id_]]
    kids = children.get(id_, [])
    if kids:
        return P[kids[0]]
    return P[id_] + np.array([0.0, 0.0, 0.01])


def build(sex):
    T = json.load(open(os.path.join(WORK, f"template-{sex}.json")))
    V, F, eyes = extract(sex)
    s = T["stature"] / (V[:, 1].max() - V[:, 1].min())
    off = np.array([V[:, 0].mean(), V[:, 1].min(), 0.0])
    V = (V - off) * s
    eyes = [((e - off) * s, f) for e, f in eyes]
    # depth: the trunk section at the template's waist ring is centred where the template's is
    w = next(r for r in T["stations"]["torso"] if r["id"] == "waist")
    c = central(V, w["y"])
    dz = w["cz"] - 0.5 * (V[c, 2].min() + V[c, 2].max())
    V[:, 2] += dz
    eyes = [(e + np.array([0, 0, dz]), f) for e, f in eyes]
    print(sex, "vertices", len(V), "triangles", len(F), "scale", round(s, 4))

    P, tips = place_joints(V, eyes, T)
    # then the pelvis joint (the middle of the hips) goes where the template's is: the waist puts the female mesh's hips 35 mm behind it
    sh = np.array([0.0, 0.0, T["joints"][0]["p"][2] - P["pelvis"][2]])
    V = V + sh
    eyes = [(e + sh, f) for e, f in eyes]
    P = {k: v + sh for k, v in P.items()}
    tips = {k: v + sh for k, v in tips.items()}
    ids = [j["id"] for j in T["joints"]]
    parent = {j["id"]: j["parent"] for j in T["joints"]}
    children = {}
    for j in T["joints"]:
        if j["parent"]:
            children.setdefault(j["parent"], []).append(j["id"])

    bpy.ops.wm.read_factory_settings(use_empty=True)
    me = bpy.data.meshes.new("body")
    me.from_pydata((V * K).tolist(), [], F.tolist())
    me.update()
    ob = bpy.data.objects.new("body", me)
    bpy.context.scene.collection.objects.link(ob)
    arm = bpy.data.armatures.new("rig")
    ao = bpy.data.objects.new("rig", arm)
    bpy.context.scene.collection.objects.link(ao)
    bpy.context.view_layer.objects.active = ao
    ao.select_set(True)
    bpy.ops.object.mode_set(mode="EDIT")
    for id_ in ids:
        b = arm.edit_bones.new(id_)
        b.head = Vector(P[id_] * K)
        t = tail_of(id_, P, tips, children)
        if np.linalg.norm(t - P[id_]) < 0.004:
            t = P[id_] + np.array([0.0, -0.01, 0.0])
        b.tail = Vector(t * K)
        b.use_deform = id_ not in NO_DEFORM
        if parent[id_]:
            b.parent = arm.edit_bones[parent[id_]]
    bpy.ops.object.mode_set(mode="OBJECT")
    bpy.ops.object.select_all(action="DESELECT")
    ob.select_set(True)
    ao.select_set(True)
    bpy.context.view_layer.objects.active = ao
    bpy.ops.object.parent_set(type="ARMATURE_AUTO")

    # weights (dense), then the vertices the heat solver missed take those of their nearest weighted neighbour
    W = np.zeros((len(V), len(ids)))
    gi = {g.index: ids.index(g.name) for g in ob.vertex_groups}
    for v in me.vertices:
        for g in v.groups:
            W[v.index, gi[g.group]] = g.weight
    tot = W.sum(axis=1)
    bad = np.nonzero(tot < 1e-6)[0]
    if len(bad):
        good = np.nonzero(tot >= 1e-6)[0]
        for i in bad:
            W[i] = W[good[np.argmin(np.linalg.norm(V[good] - V[i], axis=1))]]
    print(sex, "unweighted vertices fixed:", len(bad))
    W /= W.sum(axis=1, keepdims=True)

    # the neutral pose of the template: arms and legs turned, feet kept flat
    mod = next(m for m in ob.modifiers if m.type == "ARMATURE")
    mod.use_deform_preserve_volume = True
    J = {j["id"]: np.array(j["p"], float) for j in T["joints"]}
    LM = {k: np.array(v, float) for k, v in T["landmarks"].items()}
    bpy.context.view_layer.objects.active = ao
    bpy.ops.object.mode_set(mode="POSE")
    keep = {f"ankle_{x}": ao.pose.bones[f"ankle_{x}"].matrix.copy() for x in "LR"}

    def set_dir(name, target):
        pb = ao.pose.bones[name]
        M = pb.matrix.copy()
        cur = (M.to_3x3() @ Vector((0, 1, 0))).normalized()
        q = cur.rotation_difference(Vector(target).normalized())
        N = q.to_matrix().to_4x4() @ M
        N.translation = M.translation
        pb.matrix = N
        bpy.context.view_layer.update()
    for x in "LR":
        set_dir(f"shoulder_{x}", J[f"elbow_{x}"] - J[f"shoulder_{x}"])
        set_dir(f"elbow_{x}", J[f"wrist_{x}"] - J[f"elbow_{x}"])
        set_dir(f"wrist_{x}", J[f"middle_mcp_{x}"] - J[f"wrist_{x}"])
        set_dir(f"hip_{x}", J[f"knee_{x}"] - J[f"hip_{x}"])
        set_dir(f"knee_{x}", J[f"ankle_{x}"] - J[f"knee_{x}"])
        pb = ao.pose.bones[f"ankle_{x}"]
        N = keep[f"ankle_{x}"].copy()
        N.translation = pb.matrix.translation
        pb.matrix = N
        bpy.context.view_layer.update()
    bpy.ops.object.mode_set(mode="OBJECT")
    dg = bpy.context.evaluated_depsgraph_get()
    me2 = ob.evaluated_get(dg).to_mesh()
    Vn = np.empty(len(me2.vertices) * 3)
    me2.vertices.foreach_get("co", Vn)
    Vn = Vn.reshape(-1, 3) / K
    Jn = np.array([np.array(ao.matrix_world @ ao.pose.bones[i].head) for i in ids]) / K
    Ja = np.array([P[i] for i in ids])

    k = 4
    order = np.argsort(-W, axis=1)[:, :k]
    wv = np.take_along_axis(W, order, axis=1)
    wv /= wv.sum(axis=1, keepdims=True)
    out = os.path.join(WORK, f"rigged-{sex}.npz")
    np.savez(out, V=Vn, V0=V, F=F, widx=order, wval=wv, J=Jn, J0=Ja, ids=np.array(ids),
             eyeL=eyes[0][0], eyeLF=eyes[0][1], eyeR=eyes[1][0], eyeRF=eyes[1][1], tips=json.dumps({k: list(v) for k, v in tips.items()}))
    print(sex, "->", out)
    for i in ("shoulder_L", "elbow_L", "wrist_L", "hip_L", "knee_L", "ankle_L", "mtp_L", "head"):
        print(f"   {i:12s} template {np.round(J[i], 3)}  mesh {np.round(Jn[ids.index(i)], 3)}")


if __name__ == "__main__":
    for sex in (sys.argv[1:] or ["M", "F"]):
        build(sex)
