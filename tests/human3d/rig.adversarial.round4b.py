"""Round-4: display flags with a skin. python3 tests/human3d/rig.adversarial.round4b.py <outdir> [dark]"""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from shot import browser
out = Path(sys.argv[1]); out.mkdir(parents=True, exist_ok=True)
dark = len(sys.argv) > 2 and sys.argv[2] == "dark"
sfx = "-dark" if dark else ""
CONF = {
  "skin": {"skin": True, "skeleton": False, "joints": False, "xray": False, "wireframe": False, "landmarks": False, "labels": False, "com": False},
  "skin+sk+joints": {"skin": True, "skeleton": True, "joints": True, "xray": False, "wireframe": False},
  "xray": {"skin": True, "skeleton": True, "joints": True, "xray": True, "wireframe": False},
  "wire": {"skin": True, "skeleton": True, "joints": False, "xray": False, "wireframe": True},
  "xray+wire+lm+com": {"skin": True, "skeleton": True, "joints": True, "xray": True, "wireframe": True, "landmarks": True, "com": True},
  "sel": {"skin": True, "skeleton": True, "joints": True, "xray": True, "wireframe": False, "landmarks": False, "com": False},
}
with browser(1000, 650, dark=dark) as (page, logs):
    page.goto(page.base + "/__pages/rig.adversarial.html?fit=1&skin=1")
    page.wait_for_function("window.__ready", timeout=60000)
    for name, d in CONF.items():
        page.evaluate("(a)=>{const [n,d]=a; window.A.pose('seated'); window.A.sheet([{az:0,el:5,dist:3.6},{az:60,el:10,dist:3.6}],{cols:2,display:d, select: n==='sel'?'shoulder_L':null});}", [name, d])
        page.wait_for_timeout(100)
        page.locator("#c").screenshot(path=str(out / f"disp-{name.replace('+','_')}{sfx}.png"))
    print("\n".join(logs))
