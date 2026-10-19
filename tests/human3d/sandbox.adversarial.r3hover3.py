"""Round 3: DEFECT probe: the hover outline of an object stays after the pointer has left the canvas (sandbox.js never listens to pointerleave)."""
import importlib.util
from pathlib import Path
spec = importlib.util.spec_from_file_location("lib", Path(__file__).with_name("sandbox.adversarial.lib.py")); lib = importlib.util.module_from_spec(spec); spec.loader.exec_module(lib)
from shot import browser
SB = lib.SB
with browser(1280, 800) as (page, logs):
    lib.open_human(page, "scene")
    page.evaluate(f"async () => {{ const sb = await {SB}; sb.add('crate', {{ position: [-0.8, 0, 1.0] }}); sb.select(null); }}")
    page.wait_for_timeout(2000)
    b = lib.client(page, [-0.8, 0.2, 1.0])
    page.mouse.move(b["x"], b["y"]); page.wait_for_timeout(400)
    print("hover on the crate:", page.evaluate(f"async () => (await {SB}).hovered"))
    page.mouse.move(100, 400, steps=4); page.wait_for_timeout(600)   # over the left panel, outside the canvas
    print("pointer now over:", page.evaluate("document.elementFromPoint(100, 400).className"), "| hover:", page.evaluate(f"async () => (await {SB}).hovered"))
    page.screenshot(path=str(lib.OUT / "r3-hover-stale.png"))
