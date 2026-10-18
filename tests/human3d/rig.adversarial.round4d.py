"""Round-4: anatomy close-ups of the neutral skeleton (z-fighting, gaps). python3 tests/human3d/rig.adversarial.round4d.py <outdir> [dark]"""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from shot import browser
out = Path(sys.argv[1]); out.mkdir(parents=True, exist_ok=True)
dark = len(sys.argv) > 2 and sys.argv[2] == "dark"
sfx = "-dark" if dark else ""
JS = """(a)=>{const [pose, views, disp] = a; window.A.pose(pose);
  const J=(id)=>{const v=window.A.rig.jointWorld(id);return [v.x,v.y,v.z]};
  const vs = views.map(v=>({...v, target: v.joint ? J(v.joint) : v.target}));
  window.A.sheet(vs,{cols: 2, display: disp});}"""
D = {"skeleton": True, "joints": False, "axes": False, "landmarks": False, "labels": False, "com": False}
with browser(1000, 800, dark=dark) as (page, logs):
    page.goto(page.base + "/__pages/rig.adversarial.html?fit=1&w=1000&h=800")
    page.wait_for_function("window.__ready", timeout=60000)
    sets = {
      "torso-back": [dict(az=180, el=5, dist=1.2, joint="T8", fov=30), dict(az=150, el=20, dist=1.2, joint="T4"), dict(az=180, el=5, dist=1.0, joint="pelvis"), dict(az=-90, el=0, dist=1.2, joint="L3")],
      "torso-front": [dict(az=0, el=5, dist=1.2, joint="T8"), dict(az=30, el=20, dist=1.0, joint="T4"), dict(az=0, el=0, dist=1.0, joint="pelvis"), dict(az=90, el=0, dist=1.2, joint="T6")],
      "head-neck": [dict(az=0, el=5, dist=0.8, joint="head"), dict(az=90, el=0, dist=0.8, joint="head"), dict(az=45, el=30, dist=0.8, joint="C5"), dict(az=180, el=0, dist=0.8, joint="C4")],
      "legs": [dict(az=0, el=5, dist=1.0, joint="knee_L"), dict(az=90, el=0, dist=1.0, joint="knee_L"), dict(az=30, el=15, dist=0.8, joint="ankle_L"), dict(az=-60, el=40, dist=0.7, joint="mtp_L")],
    }
    for name, v in sets.items():
        page.evaluate(JS, [{}, v, D])
        page.wait_for_timeout(100)
        page.locator("#c").screenshot(path=str(out / f"anat-{name}{sfx}.png"))
    print("\n".join(logs))
