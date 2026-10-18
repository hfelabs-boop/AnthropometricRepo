"""Browser probes 12: pointercancel during an object drag (touch cancel), and the stale measure-tool hint."""
import importlib.util
from pathlib import Path
spec = importlib.util.spec_from_file_location("lib", Path(__file__).with_name("sandbox.adversarial.lib.py")); lib = importlib.util.module_from_spec(spec); spec.loader.exec_module(lib)
from shot import browser
SB, MS = lib.SB, lib.MS
with browser(390, 800, mobile=True) as (page, logs):
    lib.open_human(page, "scene")
    cdp = page.context.new_cdp_session(page)
    def touch(kind, pts): cdp.send("Input.dispatchTouchEvent", {"type": kind, "touchPoints": [{"x": x, "y": y, "id": i} for i, (x, y) in enumerate(pts)]})
    page.evaluate(f"""async () => {{ const sb = await {SB}; sb.add('box', {{ position: [0, 0, 1.2], params: {{width:0.8,depth:0.8,height:0.8}} }}); sb.select(null);
        const vp = window.__human.viewport; vp.camera.position.set(1.5,1.6,4); vp.controls.target.set(0,0.5,1); vp.controls.update(); vp.requestRender(); }}""")
    page.evaluate("document.querySelector('canvas').scrollIntoView({block:'center'})"); page.wait_for_timeout(1200)
    p = lib.client(page, [0, 0.4, 1.2]); x, y = p["x"], p["y"]
    touch("touchStart", [(x, y)])
    for i in range(1, 8): touch("touchMove", [(x + i * 4, y + i)]); page.wait_for_timeout(20)
    print("mid drag: controls.enabled", page.evaluate("window.__human.viewport.controls.enabled"), "dragging", page.evaluate(f"async () => (await {SB}).dragging"))
    touch("touchCancel", []); page.wait_for_timeout(400)
    print("after touchCancel: controls.enabled", page.evaluate("window.__human.viewport.controls.enabled"), "dragging", page.evaluate(f"async () => (await {SB}).dragging"))
    # orbit on empty space now?
    c0 = page.evaluate("window.__human.viewport.camera.position.toArray()")
    touch("touchStart", [(40, 300)])
    for i in range(1, 10): touch("touchMove", [(40 + i * 10, 300)]); page.wait_for_timeout(20)
    touch("touchEnd", []); page.wait_for_timeout(500)
    c1 = page.evaluate("window.__human.viewport.camera.position.toArray()")
    print("orbit by dragging empty space after a cancelled drag works:", c0 != c1)
    print("history:", page.evaluate(f"async () => {{ const s = await {SB}; return [s.undoLabel, s.canUndo]; }}"))
