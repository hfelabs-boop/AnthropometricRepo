"""Round 5: display flags in the real page (x-ray, skin hidden, skeleton + joints shown, wireframe?) must not change the exported GLB / OBJ (materials included)."""
import importlib.util, json, struct, hashlib
from pathlib import Path
spec = importlib.util.spec_from_file_location("lib", Path(__file__).with_name("export.adversarial.lib.py")); lib = importlib.util.module_from_spec(spec); spec.loader.exec_module(lib)
def glb_json(data):
    n = struct.unpack("<I", data[12:16])[0]; return json.loads(data[20:20 + n])
def strip(txt): return "\n".join(l for l in txt.split("\n") if not l.startswith("# Created"))
with lib.session() as s:
    p = s.page
    s.open()
    ref = {}
    for label, disp in [("default", {}), ("xray", {"xray": True}), ("skin hidden", {"skin": False}), ("skeleton+joints+labels+landmarks+com", {"skeleton": True, "joints": True, "labels": True, "landmarks": True, "com": True}), ("skin hidden + skeleton", {"skin": False, "skeleton": True, "joints": True})]:
        s.js("(d) => window.__human.ctx.setDisplay({ skin: true, skeleton: false, joints: false, labels: false, landmarks: false, com: false, xray: false, ...d })", disp)
        p.wait_for_timeout(500)
        _, glb = s.grab("Download GLB"); s.idle(); _, obj = s.grab("Download OBJ"); s.idle()
        j = glb_json(glb); mats = json.dumps(j["materials"], sort_keys=True)
        h = (mats, hashlib.md5(strip(obj.decode()).encode()).hexdigest(), len(glb))
        if not ref: ref = h
        print(f"{label:40s} glb {len(glb)} obj md5 {h[1][:8]} materials same: {h[0] == ref[0]} obj same: {h[1] == ref[1]}")
        if h[0] != ref[0]: print("   ", mats[:300])
    print("errors", s.errors()[:3])
