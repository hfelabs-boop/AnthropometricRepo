"""Display flags / selection visuals. python3 tests/human3d/rig.adversarial.vis.py <outdir> [dark] [query]"""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from shot import browser
out = Path(sys.argv[1]); out.mkdir(parents=True, exist_ok=True)
dark = len(sys.argv) > 2 and sys.argv[2] == "dark"; sfx = "-dark" if dark else ""
q = sys.argv[3] if len(sys.argv) > 3 else ""
with browser(1000, 800, dark=dark) as (page, logs):
    page.goto(page.base + "/__pages/rig.adversarial.html?w=1000&h=800&skin=1" + q)
    page.wait_for_function("window.__ready", timeout=60000)
    def shot(name, views, **o):
        page.evaluate("(a)=>window.A.sheet(a[0],a[1])", [views, o | {"cols": 2 if len(views) > 1 else 1}])
        page.wait_for_timeout(100); page.locator("#c").screenshot(path=str(out / f"v-{name}{sfx}.png"))
    full = [dict(az=0, el=4, dist=3.6), dict(az=60, el=15, dist=3.6)]
    shot("markers", full, poseName="seated", display={"skeleton": True, "joints": True, "axes": True, "landmarks": False, "com": False}, select=None)
    shot("select-shoulder", [dict(az=20, el=10, dist=1.0, target=[0.2, 1.4, 0]), dict(az=70, el=10, dist=1.0, target=[0.2, 1.4, 0])], poseName="neutral", display={"joints": True}, select="shoulder_L")
    page.evaluate("()=>{window.A.rig.highlight('elbow_L')}")
    shot("highlight", [dict(az=20, el=10, dist=1.4, target=[0.2, 1.25, 0]), dict(az=-20, el=10, dist=1.4, target=[-0.2, 1.25, 0])], select="elbow_L")
    shot("select-hand", [dict(az=20, el=10, dist=0.7, target=[0.3, 0.85, 0])], select="index_mcp_L", display={"joints": True})
    shot("select-spine", [dict(az=80, el=10, dist=1.2, target=[0, 1.2, 0]), dict(az=0, el=10, dist=1.2, target=[0, 1.2, 0])], select="L3")
    shot("select-forearm", [dict(az=20, el=10, dist=1.0, target=[0.3, 1.0, 0]), dict(az=90, el=10, dist=1.0, target=[0.3, 1.0, 0])], select="forearm_L")
    shot("select-pelvis", [dict(az=20, el=10, dist=1.0, target=[0, 0.95, 0]), dict(az=90, el=10, dist=1.0, target=[0, 0.95, 0])], select="pelvis")
    shot("lm-com", full, select=None, poseName="bend", display={"landmarks": True, "com": True, "joints": False})
    shot("xray-skin", full, poseName="neutral", display={"skin": True, "xray": True, "joints": True, "landmarks": False, "com": False})
    shot("skin-opaque", full, poseName="neutral", display={"skin": True, "xray": False, "joints": True, "skeleton": True})
    shot("skin-wire", full, poseName="neutral", display={"skin": True, "xray": False, "wireframe": True, "joints": True})
    shot("only-joints", full, poseName="neutral", display={"skin": False, "skeleton": False, "joints": True, "wireframe": False, "xray": False})
    print("\n".join(logs))
