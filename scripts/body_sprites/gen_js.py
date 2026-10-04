import json, shutil
d=json.load(open("out/calib.json")); meta=json.load(open("out/meta.json"))
rnd=lambda v: round(v,1); out={}
for t in "MF":
    D=d[t]
    out[t]=dict(sprite={k:{kk:rnd(vv) for kk,vv in meta[t+"_"+k].items()} for k in ("stand","sit")},
                runs={int(k):[[rnd(a),rnd(b)] for a,b in v] for k,v in D["runs"].items() if int(k)%4==0 or 236<=int(k)<=300 or 80<=int(k)<=140},
                tw={int(k):v for k,v in D["tw"].items()}, td={int(k):v for k,v in D["td"].items()}, L=D["L"], G=D["G"])
js="// Landmarks and silhouettes measured on the two CC0 body meshes (see site/img/body). Generated; SVG units, 440 per stature.\nexport const DATA = "+json.dumps(out,separators=(",",":"))+";\n"
open("/home/user/AnthropometricRepo/site/js/bodydata.js","w").write(js); print(len(js))
for t in "MF":
    for p in ("stand","sit"): shutil.copy(f"out/{t}_{p}.webp",f"/home/user/AnthropometricRepo/site/img/body/{t}_{p}.webp")
