"""Close-ups. python3 tests/human3d/rig.adversarial.close.py <outdir> [dark] [pageQuery]"""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from shot import browser
out = Path(sys.argv[1]); out.mkdir(parents=True, exist_ok=True)
dark = len(sys.argv) > 2 and sys.argv[2] == "dark"
sfx = "-dark" if dark else ""
q = sys.argv[3] if len(sys.argv) > 3 else ""
def tgt(x, y, z): return [x, y, z]
SHOTS = {
  "head": ("neutral", [dict(az=0, el=0, dist=0.8, target=tgt(0, 1.62, 0.02), fov=30), dict(az=90, el=0, dist=0.8, target=tgt(0, 1.62, 0.02)), dict(az=40, el=15, dist=0.8, target=tgt(0, 1.6, 0.02)), dict(az=180, el=0, dist=0.8, target=tgt(0, 1.62, 0.02))], 2),
  "thorax": ("neutral", [dict(az=0, el=0, dist=1.5, target=tgt(0, 1.25, 0)), dict(az=90, el=0, dist=1.5, target=tgt(0, 1.25, 0)), dict(az=35, el=10, dist=1.4, target=tgt(0, 1.25, 0)), dict(az=180, el=0, dist=1.5, target=tgt(0, 1.25, 0))], 2),
  "pelvis": ("neutral", [dict(az=0, el=0, dist=1.1, target=tgt(0, 0.9, 0)), dict(az=90, el=0, dist=1.1, target=tgt(0, 0.9, 0)), dict(az=180, el=0, dist=1.1, target=tgt(0, 0.9, 0)), dict(az=0, el=70, dist=1.1, target=tgt(0, 0.95, 0))], 2),
  "shoulder": ("armsOut", [dict(az=0, el=0, dist=1.4, target=tgt(0.2, 1.4, 0)), dict(az=180, el=0, dist=1.4, target=tgt(0.2, 1.4, 0)), dict(az=0, el=0, dist=1.4, target=tgt(0.2, 1.4, 0)), dict(az=90, el=0, dist=1.4, target=tgt(0, 1.4, 0))], 2),
  "armsUp": ("armsUp", [dict(az=0, el=0, dist=2.2, target=tgt(0, 1.4, 0)), dict(az=90, el=0, dist=2.2, target=tgt(0, 1.4, 0)), dict(az=180, el=0, dist=2.2, target=tgt(0, 1.4, 0)), dict(az=45, el=10, dist=2.2, target=tgt(0, 1.4, 0))], 2),
  "fist": ("fist", [dict(az=0, el=10, dist=1.0, target=tgt(0, 1.05, 0.2)), dict(az=90, el=10, dist=0.9, target=tgt(0, 1.0, 0.25)), dict(az=45, el=40, dist=0.7, target=tgt(0.2, 1.0, 0.3)), dict(az=-45, el=40, dist=0.7, target=tgt(-0.2, 1.0, 0.3))], 2),
  "open": ("open", [dict(az=0, el=10, dist=1.0, target=tgt(0, 1.05, 0.2)), dict(az=90, el=10, dist=0.9, target=tgt(0, 1.0, 0.25)), dict(az=45, el=40, dist=0.7, target=tgt(0.2, 1.0, 0.3)), dict(az=-45, el=40, dist=0.7, target=tgt(-0.2, 1.0, 0.3))], 2),
  "wrist": ("wristFlex", [dict(az=0, el=10, dist=0.9, target=tgt(0, 1.05, 0.2)), dict(az=90, el=10, dist=0.8, target=tgt(0.2, 1.0, 0.25)), dict(az=-90, el=10, dist=0.8, target=tgt(-0.2, 1.0, 0.25)), dict(az=0, el=60, dist=0.8, target=tgt(0, 1.0, 0.25))], 2),
  "foot": ("neutral", [dict(az=90, el=5, dist=0.8, target=tgt(0.09, 0.1, 0.03)), dict(az=0, el=75, dist=0.7, target=tgt(0.09, 0.05, 0.05)), dict(az=-30, el=20, dist=0.8, target=tgt(0.09, 0.1, 0.03)), dict(az=0, el=5, dist=0.8, target=tgt(0, 0.1, 0.05))], 2),
  "footFlex": ("footFlex", [dict(az=90, el=5, dist=1.4, target=tgt(0.09, 0.3, 0.1)), dict(az=-90, el=5, dist=1.4, target=tgt(-0.09, 0.3, 0.1)), dict(az=0, el=20, dist=1.6, target=tgt(0, 0.4, 0.1)), dict(az=180, el=10, dist=1.6, target=tgt(0, 0.4, 0))], 2),
  "knee": ("squat", [dict(az=90, el=0, dist=1.6, target=tgt(0, 0.5, 0.15)), dict(az=0, el=0, dist=1.6, target=tgt(0, 0.5, 0.15)), dict(az=45, el=15, dist=1.6, target=tgt(0, 0.5, 0.15)), dict(az=135, el=15, dist=1.6, target=tgt(0, 0.5, 0.1))], 2),
}
HANDS = {
  "fist": [("L", 0, 10, 0.5), ("L", 90, 10, 0.5), ("L", 45, 40, 0.45), ("R", -45, 40, 0.45)],
  "open": [("L", 0, 10, 0.5), ("L", 90, 10, 0.5), ("L", 45, 40, 0.45), ("R", -45, 40, 0.45)],
  "wrist": [("L", 0, 10, 0.5), ("L", 90, 10, 0.5), ("R", -90, 10, 0.5), ("R", 0, 60, 0.5)],
}
which = sys.argv[4].split(",") if len(sys.argv) > 4 else list(SHOTS)
with browser(1000, 800, dark=dark) as (page, logs):
    page.goto(page.base + "/__pages/rig.adversarial.html?w=1000&h=800" + q)
    page.wait_for_function("window.__ready", timeout=60000)
    for name in which:
        pose, views, cols = SHOTS[name]
        if name in HANDS:
            page.evaluate("(n)=>window.A.pose(n)", pose)
            views = []
            for side, az, el, dist in HANDS[name]:
                t = page.evaluate("(s)=>{const v=window.A.rig.jointWorld('middle_mcp_'+s); return [v.x,v.y,v.z];}", side)
                views.append(dict(az=az, el=el, dist=dist, target=t))
        page.evaluate("(a)=>window.A.sheet(a[0],a[1])", [views, {"poseName": pose, "cols": cols, "display": {"skeleton": True, "joints": False, "axes": False}}])
        page.wait_for_timeout(150)
        page.locator("#c").screenshot(path=str(out / f"c-{name}{sfx}.png"))
    print("\n".join(logs))
