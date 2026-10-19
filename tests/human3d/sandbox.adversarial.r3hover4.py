"""Round 3: DEFECT probe: the measuring tool's snap preview (marker + "Joint · ..." label) stays after the pointer leaves the canvas."""
import importlib.util
from pathlib import Path
spec = importlib.util.spec_from_file_location("lib", Path(__file__).with_name("sandbox.adversarial.lib.py")); lib = importlib.util.module_from_spec(spec); spec.loader.exec_module(lib)
from shot import browser
SB, MS = lib.SB, lib.MS
with browser(1280, 800) as (page, logs):
    lib.open_human(page, "measure")
    page.evaluate(f"async () => {{ (await {MS}).setTool('distance'); }}")
    page.wait_for_timeout(500)
    c = page.evaluate("() => { const p = window.__human.ctx.getRig().landmarkWorld('acromion_L') || window.__human.ctx.getRig().jointWorld('shoulder_L'); return [p.x, p.y, p.z]; }")
    s = lib.client(page, c)
    page.mouse.move(s["x"], s["y"], steps=3); page.wait_for_timeout(500)
    print("hover over shoulder:", page.evaluate(f"async () => {{ const h = (await {MS}).hover; return h && h.text; }}"))
    page.mouse.move(100, 400, steps=4); page.wait_for_timeout(600)
    print("pointer over the left panel, hover still:", page.evaluate(f"async () => {{ const h = (await {MS}).hover; return h && h.text; }}"))
    page.screenshot(path=str(lib.OUT / "r3-measure-hover-stale.png"))
