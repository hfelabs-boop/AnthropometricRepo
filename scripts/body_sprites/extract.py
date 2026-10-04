import bpy, numpy as np, glob
f = glob.glob('/tmp/hm/**/*.blend', recursive=True)[0]
bpy.ops.wm.open_mainfile(filepath=f)
dg = bpy.context.evaluated_depsgraph_get()
for name, tag in [("GEO-body_male_realistic","M"),("GEO-body_female_realistic","F")]:
    o = bpy.data.objects[name]
    for m in o.modifiers:
        if m.type == 'MULTIRES': print(name, "levels", m.levels, m.sculpt_levels, m.render_levels, m.total_levels)
    [setattr(m,"levels",0) for m in o.modifiers if m.type=="MULTIRES"]; bpy.context.view_layer.update(); dg = bpy.context.evaluated_depsgraph_get(); oe = o.evaluated_get(dg); me = oe.to_mesh()
    me.calc_loop_triangles()
    V = np.array([ (o.matrix_world @ v.co)[:] for v in me.vertices ], dtype=np.float32)
    T = np.array([t.vertices[:] for t in me.loop_triangles], dtype=np.int32)
    print(tag, V.shape, T.shape, "min", V.min(0).round(3), "max", V.max(0).round(3))
    np.savez(f"/tmp/hm/out/{tag}.npz", V=V, T=T)
