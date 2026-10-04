# Renders the extra views: python make_sprites.py stand_side stand_back reach up situp sitleg (after rig.py has posed them).
import numpy as np, json
from render import render, save
from meshio import load
import sys
ALL={"stand_side":("stand","side"),"stand_back":("stand","back"),"reach":("reach","side"),"up":("up","side"),"situp":("situp","side"),"sitleg":("sitleg","side")}
POSES=[(n,*ALL[n]) for n in sys.argv[1:]]
import os
META=json.load(open("out/meta2.json")) if os.path.exists("out/meta2.json") else {}; INFO={}
for tag in "MF":
    U,T0,H=load(tag); u=440/H; ppm=u*3
    Q=np.load(f"out/{tag}_sit.npz")["V"].astype(float)
    m=(-Q[:,1]<.30)&(Q[:,2]>.6)&(Q[:,2]<.95); zseat=float(Q[m,2].min())
    band=(Q[:,2]<zseat+.25)&(Q[:,2]>zseat); rear=float((-Q[band,1]).min())
    zseat=float(Q[(-Q[:,1]<rear+.25)&(Q[:,2]>float(Q[:,2].min())+.25),2].min())
    back_sit=float((-Q[(Q[:,2]>zseat+.20)&(Q[:,2]<zseat+.55)&(abs(Q[:,0])<.22),1]).min())
    S=np.load(f"out/{tag}_stand.npz")["V"].astype(float)
    tor=(S[:,2]>.45*H)&(S[:,2]<.80*H)&(abs(S[:,0])<.22); rearS=float((-S[tor,1]).min())
    INFO[tag]=dict(rear=rear,rearS=rearS,back_sit=back_sit,zseat=zseat,H=H,u=u)
    print(tag,"rear(sit buttock)",round(rear,3),"back(sit upper)",round(back_sit,3),"rearS",round(rearS,3),flush=True)
    for name,pose,view in POSES:
        z=np.load(f"out/{tag}_{pose}.npz"); V,T=z["V"].astype(float),z["T"]
        top=float(V[:,2].max()); sit=pose.startswith("sit")
        if view=="back":
            x0=-.40; W=int(.80*ppm); X=100+x0*u
        else:
            rr=rear if sit else rearS
            x0=rr-.14; right=float((-V[:,1]).max())+.08; W=int((right-x0)*ppm); X=76+(x0-rr)*u
        if sit:
            zf=float(V[:,2].min()); Hh=int((top-zf)*ppm)+20; zfp=Hh-10+zf*ppm; Y=258-(zfp-zseat*ppm)/3
        else:
            Hh=int(top*ppm)+20; zfp=Hh-10; Y=450-(Hh-10)/3
        g,a=render(V,T,view,ppm,W,Hh,x0,zfp)
        save(g,a,f"out/{tag}_{name}.webp")
        META[f"{tag}_{name}"]=dict(x=X,y=Y,w=W/3,h=Hh/3)
        print(tag,name,W,Hh,flush=True)
json.dump(META,open("out/meta2.json","w")); json.dump(INFO,open("out/info2.json","w"))
print("done")
