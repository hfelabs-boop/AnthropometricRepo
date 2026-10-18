"""A SkinnedMesh from a skin builder, default frustumCulled: does it vanish when the rig is moved away from the origin (root x) while the camera follows it?
   python3 tests/human3d/rig.adversarial.cull.py"""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from shot import browser
with browser(600, 400) as (page, logs):
    page.goto(page.base + "/__pages/rig.adversarial.cull.html")
    page.wait_for_function("window.__ready", timeout=60000)
    for root in ({"x": 0, "y": 0.95}, {"x": 0.1, "y": 0.95}, {"x": 3, "y": 0.95}, {"x": 8, "y": 0.95}, {"x": 0, "y": 0.95, "z": 8}, {"x": 20, "y": 0.95, "z": 0}):
        n = page.evaluate("(r)=>window.T.tris(r)", root)
        print(root, "triangles drawn:", n, "(expected 77*12 = 924)")
    print("\n".join(logs))
