# Landmarks that bodymarks.js needs beyond calib.py: side silhouettes, arm/hand points in every pose, head landmarks, walls, survey proportions.
# Run after make_sprites.py (and after the sit sprite is copied into site/img/body); writes out/lm2.json.
import numpy as np, json, collections
from pathlib import Path
REPO = Path(__file__).resolve().parents[2]
from PIL import Image
from meshio import load
import survey_fractions as FRX

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
    cl=clusters_x(pts,gap); c=[k for k in cl if k[0]<=.02 and k[1]>=-.02]
    if not c: return None
    lo,hi=c[0]; return pts[(pts[:,0]>=lo-1e-6)&(pts[:,0]<=hi+1e-6)]

old=json.load(open("out/calib.json")); meta1=json.load(open("out/meta.json"))
meta2=json.load(open("out/meta2.json")); info=json.load(open("out/info2.json"))
r1=lambda v: round(float(v),1)

# ---- head landmarks (sit-frame SVG), read off the gridded renders; widths from the survey data are used in the browser
HEAD={
 "M":dict(glabella=[133.1,42.5],sellion=[132.1,47.2],pronasale=[138.1,56.9],subnasale=[134.8,60.9],labrale_sup=[135.8,64.9],stomion=[134.8,66.9],labrale_inf=[135.5,68.9],pogonion=[133.3,75.3],menton=[129.5,79.5],
          tragion=[109.6,55.5],ear_top=45.3,ear_bottom=62.7,ear_outer=98.5,ear_front=111.0,inion_y=43.0),
 "F":dict(glabella=[134.9,39.3],sellion=[134.5,44.3],pronasale=[141.5,54.6],subnasale=[137.9,59.3],labrale_sup=[138.9,62.5],stomion=[137.9,65.0],labrale_inf=[138.2,66.8],pogonion=[135.4,73.0],menton=[131.0,77.3],
          tragion=[112.5,56.5],ear_top=46.2,ear_bottom=62.2,ear_outer=104.3,ear_front=114.0,inion_y=41.0),
}
def outline(tag,G,sp):
    al=np.array(Image.open(str(REPO / "site" / "img" / "body" / f"{tag}_sit.webp")))[:,:,3]
    ex=int((G['eye'][0]-sp['x'])*3); fr=[];rr=[]
    y=G['headTop'][1]-.7
    while y<G['menton'][1]+14:
        py=int((y-sp['y'])*3); xs=np.where(al[py]>110)[0]; xs=xs[(xs>ex-170)&(xs<ex+80)]
        if len(xs): fr.append([r1(sp['x']+xs.max()/3),r1(y)]); rr.append([r1(sp['x']+xs.min()/3),r1(y)])
        y+=1.0
    return fr+rr[::-1]

OUT={}
for tag in "MF":
    U,T0,H=load(tag); u=440/H; inf=info[tag]; rear,rearS,zseat=inf['rear'],inf['rearS'],inf['zseat']
    S=np.load(f"out/{tag}_stand.npz"); S,TS=S["V"].astype(float),S["T"]
    Xsd=lambda y:76+(-y-rearS)*u          # standing side view
    Xsit=lambda y:76+(-y-rear)*u
    D={}
    # ---- standing side silhouette rows (torso from the arms-out mesh, legs from the posed mesh)
    ts={}
    for y in range(8,454,2):
        z=(450-y)/u; c=central(slice_pts(U,T0,z),.045)
        if c is not None: sx=-c[:,1]
        else:
            p=slice_pts(S,TS,z); p=p[abs(p[:,0])<.22]
            if len(p)==0: continue
            sx=-p[:,1]
        ts[y]=[r1(Xsd(-sx.max())),r1(Xsd(-sx.min()))]   # [rear, front]
    D["ts"]=ts; D["dxs"]=r1((rear-rearS)*u)
    # ---- arms / hands in each pose, projected into that view's SVG frame
    def proj(view,p):
        if view=="front": return [r1(100+p[0]*u),r1(450-p[2]*u)]
        if view=="back":  return [r1(100-p[0]*u),r1(450-p[2]*u)]
        if view=="side":  return [r1(Xsd(p[1])),r1(450-p[2]*u)]
        return [r1(Xsit(p[1])),r1(258+(zseat-p[2])*u)]
    ARMS={}
    for pose,view in (("stand","front"),("stand","back"),("stand","side"),("reach","side"),("up","side"),("sit","sit"),("situp","sit"),("sitleg","sit")):
        V=np.load(f"out/{tag}_{pose}.npz")["V"].astype(float); J=json.load(open(f"out/{tag}_{pose}_joints.json"))
        sh,el,wr=J["uarm.L"][0],J["farm.L"][0],J["hand.L"][0]; hd=np.array(J["hand.L"][1])
        d=hd-np.array(wr); d/=np.linalg.norm(d)
        rel=V-np.array(wr); al=rel@d; per=np.linalg.norm(rel-np.outer(al,d),axis=1)
        if pose in ("sit","sitleg"):     # hand lying over the thigh: pick the hand by its height band above the elbow
            e=el; mh=(V[:,0]>.12)&(V[:,2]>e[2]-.015)&(V[:,2]<e[2]+.17)&(-V[:,1]>-e[1]+.12); tip=V[mh][np.argmax(np.where(True,-V[mh][:,1],0))]
        else:
            m=(al>0)&(per<.075)&(V[:,0]>0.03)
            tip=V[m][np.argmax(al[m])]
        # thumb side: the extreme point perpendicular to the hand axis (palm-in pose -> thumb faces forward/inward)
        ARMS[f"{pose}:{view}"]=dict(sh=proj(view,sh),el=proj(view,el),wr=proj(view,wr),tip=proj(view,tip),dir=[r1(v*100)/100 for v in d])
    D["arms"]=ARMS
    # ---- walls & head
    G=old[tag]['G']; sp=meta1[tag+"_sit"]
    HD={k:v for k,v in HEAD[tag].items()}
    HD["opisthocranion"]=[G['opistho'],HEAD[tag]['inion_y']]
    HD["vertex"]=G['headTop']
    HD["outline"]=outline(tag,G,sp)
    D["head"]=HD
    D["wall"]=dict(sit_back=r1(76+(inf['back_sit']-rear)*u),stand_back=76.0)
    # sprites
    D["sprites"]={n:{k:round(v,2) for k,v in meta2[f"{tag}_{n}"].items()} for n in ("stand_side","stand_back","reach","up","situp","sitleg")}
    D["legfoot"]={"M":dict(heel=[321,238],ball=[318,203],toe=[311,184]),"F":dict(heel=[321,237],ball=[322.5,202],toe=[318,178])}[tag]
    # fractions
    OUT[tag]=D
# stature / sitting-height fractions of every measure (n-weighted)
FR={}
for k in set(FRX.FS)|set(FRX.FH):
    e={}
    for s in "MF":
        a=FRX.FS.get(k,{}).get(s); b=FRX.FH.get(k,{}).get(s)
        if a or b: e[s]=[round(a[0],4) if a else None, round(b[0],4) if b else None]
    FR[k]=e
json.dump(dict(OUT=OUT,FR=FR),open("out/lm2.json","w"),separators=(",",":"))
for t in "MF": print(t,json.dumps(OUT[t]["arms"]["reach:side"]),json.dumps(OUT[t]["arms"]["up:side"]),json.dumps(OUT[t]["wall"]),OUT[t]["dxs"],len(OUT[t]["head"]["outline"]))
print(len(FR))
