"""Round-4 close-ups. python3 tests/human3d/rig.adversarial.round4.py <outdir> [dark]"""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from shot import browser
out = Path(sys.argv[1]); out.mkdir(parents=True, exist_ok=True)
dark = len(sys.argv) > 2 and sys.argv[2] == "dark"
sfx = "-dark" if dark else ""
JS_TILE = """(a)=>{const [pose, views, disp] = a; window.A.pose(pose);
  const J=(id)=>{const v=window.A.rig.jointWorld(id);return [v.x,v.y,v.z]};
  const vs = views.map(v=>({...v, target: v.joint ? J(v.joint) : v.target}));
  window.A.sheet(vs,{cols: vs.length>2?2:vs.length, display: disp});}"""
def shot(page, name, pose, views, disp=None, w=1000, h=650):
    page.evaluate(JS_TILE, [pose, views, disp or {"skeleton": True, "joints": False, "axes": False, "landmarks": False}])
    page.wait_for_timeout(100)
    page.locator("#c").screenshot(path=str(out / f"{name}{sfx}.png"))
with browser(1000, 650, dark=dark) as (page, logs):
    page.goto(page.base + "/__pages/rig.adversarial.html?fit=1")
    page.wait_for_function("window.__ready", timeout=60000)
    arm = {"elbow_L": [90], "shoulder_L": [30, 0, 0], "elbow_R": [90], "shoulder_R": [30, 0, 0]}
    for p in (-80, 0, 80):
        shot(page, f"pron{p}", {"angles": {**arm, "forearm_L": [p], "forearm_R": [p]}}, [dict(az=0, el=10, dist=0.7, joint="wrist_L"), dict(az=90, el=10, dist=0.7, joint="wrist_L"), dict(az=0, el=70, dist=0.7, joint="wrist_L"), dict(az=-30, el=10, dist=0.7, joint="elbow_L")])
    print("\n".join(logs))
