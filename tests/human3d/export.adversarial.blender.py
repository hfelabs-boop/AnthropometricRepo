"""Blender (bpy) opens the files of export.adversarial.blender.gen.mjs the way EXPORT.md tells people to, and the figure must land where the doc says.
Blender is Z up with the front facing -Y; model (x left, y up, z front) -> Blender (x, -z, y) i.e. model (x, y, z) = blender (x, z, -y).
Usage: python tests/human3d/export.adversarial.blender.py <dir>"""
import json, sys
import bpy, mathutils
D = sys.argv[1]
truth = json.load(open(f"{D}/truth.json"))
def to_blender(p): return mathutils.Vector((p[0], -p[2], p[1]))
def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)
def bbox(objs):
    pts = []
    for o in objs:
        if o.type != "MESH": continue
        dg = bpy.context.evaluated_depsgraph_get(); ev = o.evaluated_get(dg); m = ev.to_mesh()
        pts += [o.matrix_world @ v.co for v in m.vertices]; ev.to_mesh_clear()
    lo = [min(p[i] for p in pts) for i in range(3)]; hi = [max(p[i] for p in pts) for i in range(3)]
    return lo, hi, len(pts)
tb_lo = to_blender(truth["bbox"][0]); tb_hi = to_blender(truth["bbox"][1])
exp_lo = [min(tb_lo[i], tb_hi[i]) for i in range(3)]; exp_hi = [max(tb_lo[i], tb_hi[i]) for i in range(3)]
def report(name, objs, tol=2e-3):
    lo, hi, n = bbox(objs)
    d = max(abs(a - b) for a, b in zip(lo + hi, exp_lo + exp_hi))
    print(f"{name:34s} verts {n:6d} bbox err {d*1000:8.2f} mm  {'OK' if d < tol else 'MISMATCH'}  size {[round(h-l,3) for l,h in zip(lo,hi)]}")
    return d
skin_only = lambda objs: [o for o in objs if o.type == "MESH" and o.name.startswith("skin")]

for f in ("baked.glb", "clip.glb"):
    reset(); bpy.ops.import_scene.gltf(filepath=f"{D}/{f}")
    arm = [o for o in bpy.data.objects if o.type == "ARMATURE"]; meshes = skin_only(bpy.data.objects)
    print(f, "armatures", len(arm), "bones", len(arm[0].data.bones) if arm else 0, "meshes", [o.name for o in bpy.data.objects if o.type == "MESH"], "vertex groups", [len(o.vertex_groups) for o in meshes], "actions", [a.name for a in bpy.data.actions])
    if f == "clip.glb":
        bpy.context.scene.frame_set(0)
        a = bpy.data.actions[0]
        for o in arm: 
            if o.animation_data is None: o.animation_data_create()
            o.animation_data.action = a
        bpy.context.scene.frame_set(0); bpy.context.view_layer.update()
    report(f + " skin", meshes)
    # bone heads vs truth
    worst = 0
    for o in arm:
        for b in o.data.bones:
            j = truth["joints"].get(b.name)
            if j is None: continue
            head = o.matrix_world @ (o.pose.bones[b.name].head if f == "clip.glb" else b.head_local)
            worst = max(worst, (head - to_blender(j)).length)
    print("   worst bone head error", round(worst * 1000, 3), "mm")

for axes in ("y-up", "z-up", "x-front"):
    # OBJ with Blender's documented defaults (Forward -Z, Up Y) is right for y-up only; scale 0.001
    reset(); bpy.ops.wm.obj_import(filepath=f"{D}/mesh_{axes}.obj", global_scale=0.001)
    objs = list(bpy.data.objects); report(f"OBJ {axes} (defaults, scale .001)", skin_only(objs) or objs)
    reset(); bpy.ops.wm.stl_import(filepath=f"{D}/mesh_{axes}.stl", global_scale=0.001)
    objs = list(bpy.data.objects); report(f"STL {axes} (defaults, scale .001)", objs)
reset(); bpy.ops.wm.obj_import(filepath=f"{D}/mesh_m.obj"); report("OBJ m (defaults)", skin_only(list(bpy.data.objects)) or list(bpy.data.objects))
# z-up OBJ needs Forward = Y, Up = Z
reset(); bpy.ops.wm.obj_import(filepath=f"{D}/mesh_z-up.obj", global_scale=0.001, forward_axis="Y", up_axis="Z"); report("OBJ z-up (Forward Y, Up Z)", skin_only(list(bpy.data.objects)) or list(bpy.data.objects))
# y-up STL with the doc's alternative: Up = Y, Forward = -Z
reset(); bpy.ops.wm.stl_import(filepath=f"{D}/mesh_y-up.stl", global_scale=0.001, forward_axis="NEGATIVE_Z", up_axis="Y"); report("STL y-up (Up Y, Forward -Z)", list(bpy.data.objects))

for unit, scale in (("cm", 0.01), ("mm", 0.001), ("m", 1.0)):
    reset(); bpy.ops.import_anim.bvh(filepath=f"{D}/skel_{unit}.bvh", global_scale=scale)
    arm = [o for o in bpy.data.objects if o.type == "ARMATURE"][0]
    bpy.context.scene.frame_set(1); bpy.context.view_layer.update()
    worst = 0; n = 0
    for pb in arm.pose.bones:
        j = truth["joints"].get(pb.name)
        if j is None: continue
        n += 1; worst = max(worst, ((arm.matrix_world @ pb.head) - to_blender(j)).length)
    print(f"BVH {unit} scale {scale}: bones {len(arm.pose.bones)} matched {n}, frame 1 worst head error {worst*1000:.3f} mm")
reset()
try:
    bpy.ops.import_anim.bvh(filepath=f"{D}/skel_hdr.bvh"); print("BVH with header imported (", len([o for o in bpy.data.objects]), "objects )")
except Exception as e: print("BVH with '#' header refused:", str(e)[:100])
