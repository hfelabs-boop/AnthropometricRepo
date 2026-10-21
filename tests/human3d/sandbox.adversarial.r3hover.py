"""Round 3: hover highlight follows the pointer with the new throttle (settles on the final position, clears when the pointer leaves the canvas or a drag/gizmo starts)."""
import importlib.util
from pathlib import Path
spec = importlib.util.spec_from_file_location("lib", Path(__file__).with_name("sandbox.adversarial.lib.py")); lib = importlib.util.module_from_spec(spec); spec.loader.exec_module(lib)
from shot import browser
SB = lib.SB
HOV = f"async () => {{ const s = await {SB}; return s.hovered ?? s.hoverId ?? null; }}"
with browser(1280, 800) as (page, logs):
    lib.open_human(page, "scene")
    page.evaluate(f"async () => {{ const sb = await {SB}; sb.add('box', {{ position: [0.5, 0, 1.0], params: {{ width: 0.5, depth: 0.5, height: 0.5 }} }}); sb.add('crate', {{ position: [-0.8, 0, 1.0] }}); sb.select(null); }}")
    page.wait_for_timeout(2000)
    print("keys with hover:", page.evaluate(f"async () => {{ const s = await {SB}; return Object.keys(s).filter(k => /hover/i.test(k)); }}"))
    a = lib.client(page, [0.5, 0.25, 1.0]); b = lib.client(page, [-0.8, 0.2, 1.0])
    # fast sweep: a -> b with many small moves, ending on b: after settling the hover must be b's object
    page.mouse.move(a["x"], a["y"]); page.wait_for_timeout(300); print("on box:", page.evaluate(HOV))
    page.mouse.move(b["x"], b["y"], steps=40); page.wait_for_timeout(500); print("after fast sweep onto crate:", page.evaluate(HOV))
    page.mouse.move(b["x"] + 1, b["y"], steps=1); page.mouse.move(a["x"], a["y"], steps=1); page.wait_for_timeout(500); print("jump back onto box in 1 step:", page.evaluate(HOV))
    page.mouse.move(100, 400, steps=5); page.wait_for_timeout(500); print("pointer over side panel:", page.evaluate(HOV))
    page.mouse.move(a["x"], a["y"], steps=3); page.wait_for_timeout(300); print("back on box:", page.evaluate(HOV))
    page.mouse.move(640, 5); page.wait_for_timeout(400); print("pointer above canvas (page header):", page.evaluate(HOV), "cursor", page.evaluate("document.querySelector('.hm-canvas').style.cursor || getComputedStyle(document.querySelector('.hm-canvas')).cursor"))
    # leave the window entirely
    page.mouse.move(a["x"], a["y"], steps=3); page.wait_for_timeout(300)
    page.evaluate("document.querySelector('.hm-canvas').dispatchEvent(new PointerEvent('pointerleave', {bubbles: false}))"); page.wait_for_timeout(400)
    print("after pointerleave event:", page.evaluate(HOV))
    print("errors:", [l for l in logs if l.startswith("[error]") or l.startswith("[pageerror]")])
