import bpy, bmesh, numpy as np, mathutils
from mathutils import Vector, Matrix
M_ = {}
def joints(tag, H):
    # joint positions in metres, model centred on x=0, feet on z=0, facing -Y (estimated from slice analysis)
    if tag=="M": hipx,kneex,anklex,shx,elx,wrx,hdx=.09,.13,.16,.17,.335,.40,.44
    else:        hipx,kneex,anklex,shx,elx,wrx,hdx=.08,.105,.12,.155,.31,.38,.42
    return dict(hip=(hipx,0.0,.52*H), knee=(kneex,.0,.285*H), ankle=(anklex,.04,.045*H), toe=(anklex+.01,-.12,.02),
                sh=(shx,0,.815*H), el=(elx,0,.60*H), wr=(wrx,0,.48*H), hd=(hdx,0,.425*H))
def build(tag):
    z=np.load(f"out/{tag}.npz"); V=z["V"].astype(float).copy(); T=z["T"]
    V[:,0]-=V[:,0].mean(); V[:,2]-=V[:,2].min(); H=V[:,2].max()
    bpy.ops.wm.read_factory_settings(use_empty=True)
    me=bpy.data.meshes.new("body"); me.from_pydata([tuple(v) for v in V],[],[tuple(t) for t in T]); me.update()
    ob=bpy.data.objects.new("body",me); bpy.context.scene.collection.objects.link(ob)
    arm=bpy.data.armatures.new("rig"); ao=bpy.data.objects.new("rig",arm); bpy.context.scene.collection.objects.link(ao)
    bpy.context.view_layer.objects.active=ao; ao.select_set(True)
    bpy.ops.object.mode_set(mode='EDIT')
    J=joints(tag,H); eb=arm.edit_bones
    def bone(name,h,t,parent=None,connect=False):
        b=eb.new(name); b.head=Vector(h); b.tail=Vector(t)
        if parent: b.parent=eb[parent]; b.use_connect=connect
        return b
    hip=Vector((0,0,J["hip"][2])); neck=Vector((0,0,.82*H))
    bone("pelvis",hip,hip+Vector((0,0,.08)))
    bone("spine",hip+Vector((0,0,.08)),neck,"pelvis",True)
    bone("head",neck,Vector((0,0,H)),"spine",True)
    for s,sg in (("L",1),("R",-1)):
        sx=lambda p:(sg*p[0],p[1],p[2])
        bone("thigh."+s,sx(J["hip"]),sx(J["knee"]),"pelvis")
        bone("shin."+s,sx(J["knee"]),sx(J["ankle"]),"thigh."+s,True)
        bone("foot."+s,sx(J["ankle"]),sx(J["toe"]),"shin."+s,True)
        bone("uarm."+s,sx(J["sh"]),sx(J["el"]),"spine")
        bone("farm."+s,sx(J["el"]),sx(J["wr"]),"uarm."+s,True)
        bone("hand."+s,sx(J["wr"]),sx(J["hd"]),"farm."+s,True)
    bpy.ops.object.mode_set(mode='OBJECT')
    ob.select_set(True); bpy.context.view_layer.objects.active=ao
    bpy.ops.object.parent_set(type='ARMATURE_AUTO')
    return ob,ao,H
def set_dir(ao,name,target,keep_head=True):
    pb=ao.pose.bones[name]; M=pb.matrix.copy()
    cur=(M.to_3x3()@Vector((0,1,0))).normalized(); q=cur.rotation_difference(Vector(target).normalized())
    R=q.to_matrix().to_4x4(); N=R@M; N.translation=M.translation
    pb.matrix=N; bpy.context.view_layer.update()
def pose_and_export(tag,pose):
    ob,ao,H=build(tag)
    bpy.context.view_layer.update()
    for s,sg in (("L",1),("R",-1)):
        if pose=="stand":
            set_dir(ao,"uarm."+s,(sg*.30,0,-1)); set_dir(ao,"farm."+s,(sg*.22,-.04,-1)); set_dir(ao,"hand."+s,(sg*.20,-.05,-1))
        else:
            set_dir(ao,"thigh."+s,(sg*.10,-1,-.02)); set_dir(ao,"shin."+s,(sg*.02,.03,-1)); set_dir(ao,"foot."+s,(0,-1,-.05))
            set_dir(ao,"uarm."+s,(sg*.10,.04,-1)); set_dir(ao,"farm."+s,(sg*.04,-1,-.12)); set_dir(ao,"hand."+s,(sg*.03,-1,-.2))
    dg=bpy.context.evaluated_depsgraph_get(); oe=ob.evaluated_get(dg); me=oe.to_mesh()
    V=np.array([v.co[:] for v in me.vertices],dtype=np.float32); T=np.array([[*p.vertices] for p in me.polygons],dtype=np.int32)
    J={b.name:[list(ao.matrix_world@b.head),list(ao.matrix_world@b.tail)] for b in ao.pose.bones}
    import json; json.dump(J,open(f"out/{tag}_{pose}_joints.json","w"))
    np.savez(f"out/{tag}_{pose}.npz",V=V,T=T,H=H); print(tag,pose,V.shape,"min",V.min(0).round(3),"max",V.max(0).round(3))
for tag in "MF":
    for pose in ("stand","sit"): pose_and_export(tag,pose)
