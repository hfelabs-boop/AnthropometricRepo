import json,sys
from PIL import Image, ImageDraw
from pathlib import Path
js=open(Path(__file__).resolve().parents[2]/'site'/'js'/'bodydata.js').read(); D=json.loads(js[js.index('= ')+2:].rstrip().rstrip(';'))
M2=json.load(open('out/meta2.json'))
def meta(tag,name):
    if name in("stand","sit"): return D[tag]['sprite'][name]
    return M2[f"{tag}_{name}"]
def view(tag,name,x0,y0,x1,y1,step=5,scale=8,out=None,webp=None):
    m=meta(tag,name); path=webp or f"out/{tag}_{name}.webp"
    im=Image.open(path).convert("RGBA")
    box=(int((x0-m['x'])*3),int((y0-m['y'])*3),int((x1-m['x'])*3),int((y1-m['y'])*3))
    c=im.crop(box); bg=Image.new("RGBA",c.size,(244,243,240,255)); bg.alpha_composite(c)
    k=scale/3; bg=bg.convert("RGB").resize((int(c.width*k),int(c.height*k)),Image.LANCZOS); d=ImageDraw.Draw(bg)
    gx=x0-x0%step+step if x0%step else x0
    while gx<=x1:
        X=(gx-x0)*scale; major=gx%(step*2)==0
        d.line([(X,0),(X,bg.height)],fill=(210,110,110) if major else (235,190,190),width=1)
        if major: d.text((X+2,2),str(int(gx)),fill=(160,0,0))
        gx+=step
    gy=y0-y0%step+step if y0%step else y0
    while gy<=y1:
        Y=(gy-y0)*scale; major=gy%(step*2)==0
        d.line([(0,Y),(bg.width,Y)],fill=(110,110,210) if major else (190,190,235),width=1)
        if major: d.text((2,Y+2),str(int(gy)),fill=(0,0,160))
        gy+=step
    out=out or f"out/gv_{tag}_{name}_{int(x0)}_{int(y0)}.png"; bg.save(out); return out
if __name__=="__main__":
    a=sys.argv; print(view(a[1],a[2],*[float(v) for v in a[3:7]],step=float(a[7]) if len(a)>7 else 5,scale=float(a[8]) if len(a)>8 else 8))
