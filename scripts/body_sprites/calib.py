import numpy as np, json, bpy, glob
from collections import defaultdict

def slice_pts(V,T,z0):
    a,b,c=V[T[:,0]],V[T[:,1]],V[T[:,2]]; pts=[]
    for p,q in ((a,b),(b,c),(c,a)):
        m=(p[:,2]-z0)*(q[:,2]-z0)<0
        pp,qq=p[m],q[m]; t=((z0-pp[:,2])/(qq[:,2]-pp[:,2]))[:,None]
        pts.append(pp+(qq-pp)*t)
    return np.concatenate(pts) if pts else np.zeros((0,3))
def clusters_x(pts,gap=.035):
    if len(pts)==0: return []
    x=np.sort(pts[:,0]); out=[[x[0],x[0]]]
    for v in x[1:]:
        if v-out[-1][1]>gap: out.append([v,v])
        else: out[-1][1]=v
    return out
def central(pts,gap=.04):
    """points of the cluster containing x~0 (torso)"""
    cl=clusters_x(pts,gap); c=[k for k in cl if k[0]<=.02 and k[1]>=-.02]
    if not c: return None
    lo,hi=c[0]; return pts[(pts[:,0]>=lo-1e-6)&(pts[:,0]<=hi+1e-6)]

# eyes from the blend file
bpy.ops.wm.open_mainfile(filepath=glob.glob('/tmp/hm/**/*.blend',recursive=True)[0])
eyes={}
for tag,nm in (("M","GEO-body_male_realistic"),("F","GEO-body_female_realistic")):
    cs=[]
    for side in ("L","R"):
        o=bpy.data.objects[f"{nm}.eye.{side}"]; cs.append(np.mean([(o.matrix_world@v.co)[:] for v in o.data.vertices],axis=0))
    eyes[tag]=np.mean(cs,axis=0)   # raw world coords
OUT={}; META={}
for tag in "MF":
    z0=np.load(f"out/{tag}.npz"); U=z0["V"].astype(float); T0=z0["T"]
    off=np.array([U[:,0].mean(),0,U[:,2].min()]); U=U-off; H=U[:,2].max(); u=440/H
    eye=eyes[tag]-off    # model frame (x centred, z from floor)
    ps=np.load(f"out/{tag}_stand.npz"); S,TS=ps["V"].astype(float),ps["T"]
    pt=np.load(f"out/{tag}_sit.npz"); Q,TQ=pt["V"].astype(float),pt["T"]
    JS=json.load(open(f"out/{tag}_stand_joints.json")); JQ=json.load(open(f"out/{tag}_sit_joints.json"))
    # ---- sprite placement
    ppm=u*3; zfS=0.0
    Ws=int(.80*ppm); Hs=int(H*ppm)+20
    stand=dict(x=100-Ws/6,y=450-(Hs-10)/3,w=Ws/3,h=Hs/3)
    zf=float(Q[:,2].min()); Wq=int(.80*ppm); Hq=int((H-zf)*ppm)+20; zfp=Hq-10+zf*ppm
    m=(-Q[:,1]<.30)&(Q[:,2]>.6)&(Q[:,2]<.95); zseat=float(Q[m,2].min())
    band=(Q[:,2]<zseat+.25)&(Q[:,2]>zseat); rear=float((-Q[band,1]).min())
    zseat=float(Q[(-Q[:,1]<rear+.25)&(Q[:,2]>zf+.25),2].min())
    sit=dict(x=76-((rear+.20)*ppm)/3,y=258-(zfp-zseat*ppm)/3,w=Wq/3,h=Hq/3,floor=258+(zseat-zf)*u)
    META[tag+"_stand"]=stand; META[tag+"_sit"]=sit
    Xs=lambda x:100+x*u; Ys=lambda z:450-z*u
    Xq=lambda y:76+(-y-rear)*u; Yq=lambda z:258+(zseat-z)*u
    r=lambda v:round(float(v),1)
    # ---- standing rows: runs of the posed mesh + torso half-widths from the unposed (arms-out) mesh
    runs={}; tw={}
    for y in range(8,452,2):
        z=(450-y)/u; pts=slice_pts(S,TS,z)
        cl=clusters_x(pts,.03) if len(pts) else []
        runs[y]=[[r(Xs(a)),r(Xs(b))] for a,b in cl]
        pu=slice_pts(U,T0,z); c=central(pu,.045)
        if c is not None: tw[y]=r(abs(c[:,0]).max()*u)
    # torso depth (front/rear Y) rows from unposed central cluster
    td={}
    for y in range(60,300,2):
        z=(450-y)/u; c=central(slice_pts(U,T0,z),.045)
        if c is not None: td[y]=[r(Xq(c[:,1].min())),r(Xq(c[:,1].max()))]
    L={}
    # standing landmark rows (SVG y)
    ey=Ys(eye[2]); L["eyeY"]=r(ey)
    twmin=lambda lo,hi:min(((tw[y],y) for y in tw if lo<=y<=hi))
    L["neckY"]=twmin(Ys(.89*H),Ys(.835*H))[1]
    L["waistY"]=twmin(Ys(.69*H),Ys(.56*H))[1]
    L["hipY"]=int(round(Ys(.52*H)))
    # chest/bust row: most-forward torso point between .66H and .78H
    cand=[(td[y][0],y) for y in td if Ys(.78*H)<=y<=Ys(.66*H)]; L["chestY"]=min(cand)[1] if False else None
    # (front = smaller screen x ... Xq grows with -Y, so the most forward point has the LARGEST value)
    L["chestY"]=max(cand)[1]
    # buttock row: most rear torso point between .42H and .56H
    candb=[(td[y][1],y) for y in td if Ys(.56*H)<=y<=Ys(.42*H)]; L["buttY"]=min(candb)[1]
    # acromion: highest point of the shoulder (outer deltoid region)
    sh=(S[:,2]>.78*H)&(S[:,2]<.86*H)&(abs(S[:,0])<.30); outer=abs(S[sh,0]).max()
    msh=(abs(S[:,0])>.80*outer)&(abs(S[:,0])<.92*outer)&(S[:,2]>.76*H)&(S[:,2]<.90*H)
    ia=np.argmax(np.where(msh,S[:,2],-1)); L["acromionY"]=r(Ys(S[ia,2])); L["acromionX"]=r(Xs(abs(S[ia,0]))); L["shoulderOuterX"]=r(Xs(outer))
    # crotch: first row (going down) where the central cluster splits into two legs
    wr=JS["hand.L"][0]; mh2=(S[:,0]>wr[0]-.05)&(S[:,2]<wr[2]+.03); ih2=np.argmin(np.where(mh2,S[:,2],9)); L["fingerY"]=r(Ys(S[ih2,2])); L["fingerX"]=r(Xs(S[ih2,0]))
    L["wristX"]=r(Xs(wr[0])); L["elbowX"]=r(Xs(JS["farm.L"][0][0])); L["shoulderX"]=r(Xs(JS["uarm.L"][0][0]))
    from PIL import Image
    al=np.array(Image.open(f"out/{tag}_stand.webp"))[:,:,3]; sx0=stand["x"]; sy0=stand["y"]
    for y in range(200,330):
        py=int((y-sy0)*3); px=int((100-sx0)*3)
        if al[py,px-4:px+5].max()<60: L["crotchY"]=y; break
    L["kneeY"]=r(Ys(JS["shin.L"][0][2])); L["ankleY"]=r(Ys(JS["shin.L"][1][2]))
    L["elbowY"]=r(Ys(JS["farm.L"][0][2])); L["wristY"]=r(Ys(JS["hand.L"][0][2]))
    L["headTopY"]=10.0; L["u"]=r(u)
    # ---- seated landmarks
    G={}
    top=Q[:,2].argmax(); G["headTop"]=[r(Xq(Q[top,1])),r(Yq(Q[top,2]))]
    G["eye"]=[r(Xq(eye[1])),r(Yq(eye[2]))]   # eye centre (x of the eyeball; surface is a little further forward)
    head=(Q[:,2]>eye[2]-.12)
    sl=slice_pts(Q,TQ,eye[2]+.02); sl=sl[(abs(sl[:,0])<.1)]
    G["glabellaY"]=r(Xq(sl[:,1].min())); G["opistho"]=r(Xq(sl[:,1].max())); G["browZ"]=r(Yq(eye[2]+.02))
    face=(Q[:,2]>eye[2]-.17)&(Q[:,2]<eye[2]+.03)&(Q[:,1]<sl[:,1].mean())&(abs(Q[:,0])<.06)
    ic=np.argmin(np.where(face,Q[:,2],9)); G["menton"]=[r(Xq(Q[ic,1])),r(Yq(Q[ic,2]))]
    # sellion: nose-bridge, front point at eye level between the eyes
    ss=slice_pts(Q,TQ,eye[2]); ss=ss[abs(ss[:,0])<.015]; G["sellion"]=[r(Xq(ss[:,1].min())),r(Yq(eye[2]))]
    # ear approx: centre between eye line and chin level, at 45% of head depth from the back
    hx=sl[:,1]; ear_y=G["eye"][1]+.5*(G["menton"][1]-G["eye"][1]); ear_x=Xq(hx.max()-.55*(hx.max()-hx.min()))
    G["ear"]=[r(ear_x),r(ear_y-.035*u),r(ear_y+.035*u)]
    # shoulder / arm (near arm = +x)
    ms=(Q[:,0]>.80*outer)&(Q[:,0]<.92*outer)&(Q[:,2]>.76*H)&(Q[:,2]<.90*H); ia=np.argmax(np.where(ms,Q[:,2],-1)); G["acromion"]=[r(Xq(Q[ia,1])),r(Yq(Q[ia,2]))]
    e=JQ["farm.L"][0]; G["elbow"]=[r(Xq(e[1])),r(Yq(e[2]))]
    G["olecranonY"]=r(Yq(e[2]-.032))
    mh=(Q[:,0]>.12)&(Q[:,2]>e[2]-.015)&(Q[:,2]<e[2]+.17)&(-Q[:,1]>-e[1]+.12); ih=np.argmax(np.where(mh,-Q[:,1],-9)); G["finger"]=[r(Xq(Q[ih,1])),r(Yq(Q[ih,2]))]
    # legs / seat
    G["seatY"]=258.0; G["floorY"]=r(sit["floor"])
    thigh=(Q[:,2]>zseat-.01)&(Q[:,2]<zseat+.22)&(-Q[:,1]>.25)&(abs(Q[:,0])<.16)
    ik=np.argmax(np.where(thigh,-Q[:,1],-9)); G["kneeFront"]=[r(Xq(Q[ik,1])),r(Yq(Q[ik,2]))]
    kz=JQ["shin.L"][0]; G["kneeJoint"]=[r(Xq(kz[1])),r(Yq(kz[2]))]
    knee_top=(-Q[:,1]>.40)&(-Q[:,1]<.62)&(Q[:,2]>zseat)&(Q[:,2]<zseat+.22)&(abs(Q[:,0])<.16); it=np.argmax(np.where(knee_top,Q[:,2],-1)); G["kneeTop"]=[r(Xq(Q[it,1])),r(Yq(Q[it,2]))]
    pop=(-Q[:,1]>.30)&(-Q[:,1]<.50)&(Q[:,2]>zseat-.12)&(Q[:,2]<zseat+.08)&(abs(Q[:,0])<.16); ip=np.argmin(np.where(pop,Q[:,2],9)); G["popUnder"]=[r(Xq(Q[ip,1])),r(Yq(Q[ip,2]))]
    G["popX"]=r(Xq(kz[1]+.06))   # back of the knee (fossa) ~ joint centre minus knee radius, rear is +Y
    th=(-Q[:,1]>.12)&(-Q[:,1]<.32)&(Q[:,2]>zseat)&(Q[:,2]<zseat+.21)&(abs(Q[:,0])<.12); ic2=np.argmax(np.where(th,Q[:,2],-1)); G["thighTop"]=[r(Xq(Q[ic2,1])),r(Yq(Q[ic2,2]))]
    foot=(Q[:,2]<zf+.14)&(-Q[:,1]>.35)
    G["heel"]=r(Xq(Q[foot,1].max())); G["toe"]=r(Xq(Q[foot,1].min()))
    G["rear"]=76.0
    # shoulder-elbow: also the shoulder joint
    G["shoulder"]=[r(Xq(JQ["uarm.L"][0][1])),r(Yq(JQ["uarm.L"][0][2]))]
    G["footToeBall"]=r(Xq(Q[foot,1].min()+.07))
    OUT[tag]=dict(runs={str(k):v for k,v in runs.items()},tw={str(k):v for k,v in tw.items()},td={str(k):v for k,v in td.items()},L=L,G=G)
json.dump(META,open("out/meta.json","w")); json.dump(OUT,open("out/calib.json","w"))
for t in "MF": print(t,json.dumps(OUT[t]["L"]),"\n  ",json.dumps(OUT[t]["G"]))
print(json.dumps(META))
