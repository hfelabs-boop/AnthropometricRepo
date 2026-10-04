import numpy as np
from PIL import Image
from render import *
bg=Image.new("RGB",(2800,1340),(244,243,240)); cell=0
for tag,pose,view in [("M","stand","front"),("F","stand","front"),("M","sit","side"),("F","sit","side")]:
    z=np.load(f"out/{tag}_{pose}.npz"); V,T,H=z["V"],z["T"],float(z["H"])
    ppm=440/H*3; zf=float(V[:,2].min())
    if view=="front": W=int(.80*ppm); Hh=int(H*ppm)+20; x0=-.40; zfp=Hh-10+zf*ppm
    else:             W=int(.80*ppm); Hh=int((H-zf)*ppm)+20; x0=-.20; zfp=Hh-10+zf*ppm
    g,a=render(V,T,view,ppm,W,Hh,x0,zfp)
    save(g,a,f"out/{tag}_{pose}.webp")
    im=Image.open(f"out/{tag}_{pose}.webp"); bg.paste(im,(cell,0),im); cell+=W+40
    print(tag,pose,view,W,Hh,"zf",round(zf,3),"H",round(H,3))
bg.resize((1400,670)).save("out/prev_all.png")
