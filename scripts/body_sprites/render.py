import numpy as np
from PIL import Image

def vnormals(V,T):
    fn=np.cross(V[T[:,1]]-V[T[:,0]],V[T[:,2]]-V[T[:,0]])
    N=np.zeros_like(V)
    for k in range(3): np.add.at(N,T[:,k],fn)
    n=np.linalg.norm(N,axis=1,keepdims=True); return N/np.maximum(n,1e-12)

def render(V,T,view,px_per_m,W,H,x0,z_floor_px,ss=2):
    """view 'front': camera looks along +Y (model faces -Y). 'side': looks along -X (screen right = -Y, i.e. facing right)."""
    N=vnormals(V,T)
    if view=="front": sx,sz,dep=V[:,0],V[:,2],V[:,1]; Nx,Nz,Nd=N[:,0],N[:,2],N[:,1]; sgn=-1  # toward camera = -Y
    elif view=="back": sx,sz,dep=-V[:,0],V[:,2],-V[:,1]; Nx,Nz,Nd=-N[:,0],N[:,2],-N[:,1]; sgn=-1  # camera behind, screen right = model -x
    else:             sx,sz,dep=-V[:,1],V[:,2],-V[:,0]; Nx,Nz,Nd=-N[:,1],N[:,2],-N[:,0]; sgn=-1
    # camera at -depth side looking toward +depth; nearer = smaller dep
    X=(sx-x0)*px_per_m*ss; Yp=z_floor_px*ss-sz*px_per_m*ss
    Wd,Hd=W*ss,H*ss
    zb=np.full((Hd,Wd),np.inf,np.float32)
    img=np.zeros((Hd,Wd),np.float32)
    # shading: key light upper-left-front, fill, hemisphere
    def lam(l):
        l=np.array(l,float); l/=np.linalg.norm(l); return np.clip(Nx*l[0]+Nz*l[1]+(-Nd)*l[2],0,1)
    key=lam([-.5,.6,.7]); fill=lam([.7,.1,.5]); hemi=.5+.5*Nz
    rim=np.clip(1-(-Nd),0,1)**2
    shade=.28+.62*key+.22*fill+.12*hemi - .0*rim
    shade=np.clip(shade,0,1)
    for t in T:
        a,b,c=t; xs=X[t]; ys=Yp[t]
        x_min=int(max(np.floor(xs.min()),0)); x_max=int(min(np.ceil(xs.max()),Wd-1))
        y_min=int(max(np.floor(ys.min()),0)); y_max=int(min(np.ceil(ys.max()),Hd-1))
        if x_min>x_max or y_min>y_max: continue
        den=(ys[1]-ys[2])*(xs[0]-xs[2])+(xs[2]-xs[1])*(ys[0]-ys[2])
        if abs(den)<1e-9: continue
        gx,gy=np.meshgrid(np.arange(x_min,x_max+1)+.5,np.arange(y_min,y_max+1)+.5)
        w0=((ys[1]-ys[2])*(gx-xs[2])+(xs[2]-xs[1])*(gy-ys[2]))/den
        w1=((ys[2]-ys[0])*(gx-xs[2])+(xs[0]-xs[2])*(gy-ys[2]))/den
        w2=1-w0-w1
        m=(w0>=-1e-6)&(w1>=-1e-6)&(w2>=-1e-6)
        if not m.any(): continue
        d=w0*dep[a]+w1*dep[b]+w2*dep[c]
        sh=w0*shade[a]+w1*shade[b]+w2*shade[c]
        sub=zb[y_min:y_max+1,x_min:x_max+1]; ims=img[y_min:y_max+1,x_min:x_max+1]
        upd=m&(d<sub)
        sub[upd]=d[upd]; ims[upd]=sh[upd]
    alpha=np.isfinite(zb).astype(np.float32)
    # downsample
    a=alpha.reshape(H,ss,W,ss).mean((1,3)); g=(img*alpha).reshape(H,ss,W,ss).mean((1,3))/np.maximum(a,1e-6)
    return g,a
def save(g,a,path,tone=(.66,.71,.78)):
    from PIL import ImageFilter
    al=Image.fromarray((np.clip(a,0,1)*255).astype(np.uint8))
    er=np.asarray(al.filter(ImageFilter.MinFilter(5)),dtype=np.float32)/255
    edge=np.clip(a-er,0,1)
    g=np.clip(g*(1-.55*edge)+0*edge,0,1)
    g=.12+.88*g
    rgb=np.stack([g*tone[0],g*tone[1],g*tone[2]],-1)
    out=np.dstack([(np.clip(rgb,0,1)*255).astype(np.uint8),(np.clip(a,0,1)*255).astype(np.uint8)])
    Image.fromarray(out,"RGBA").save(path,"WEBP",quality=82,method=6)
