"""Browser probes 3: shift (vertical) drag, camera stability during drag, drag over the figure's joints, labels."""
import importlib.util, json
from pathlib import Path
spec = importlib.util.spec_from_file_location("lib", Path(__file__).with_name("sandbox.adversarial.lib.py")); lib = importlib.util.module_from_spec(spec); spec.loader.exec_module(lib)
from shot import browser
SB, MS = lib.SB, lib.MS
def objs(page):
    return page.evaluate(f"async () => {{ const sb = await {SB}; return [...sb.objects.values()].map(o => ({{id:o.id,pos:o.position.map(v=>+v.toFixed(4)),yaw:o.yaw}})); }}")
def cam(page): return page.evaluate("(() => { const v = window.__human.viewport; return [v.camera.position.toArray().map(x=>+x.toFixed(3)), v.controls.target.toArray().map(x=>+x.toFixed(3))]; })()")
def hist(page): return page.evaluate(f"async () => {{ const s = await {SB}; return [s.canUndo, s.undoLabel, s.canRedo]; }}")

with browser(1280, 800) as (page, logs):
    lib.open_human(page, "scene")
    page.evaluate("""() => { const vp = window.__human.viewport; vp.camera.position.set(2.5,2.2,4); vp.controls.target.set(0,0.6,1); vp.controls.update(); vp.requestRender(); }""")
    page.evaluate(f"""async () => {{ const sb = await {SB}; sb.add('box', {{ position: [0, 0, 1.2], params: {{width:0.5,depth:0.5,height:0.5}}, select: true }}); sb.select(null); }}""")
    page.wait_for_timeout(1500)
    c0 = cam(page)
    p = lib.client(page, [0, 0.5, 1.2])
    page.mouse.move(p["x"], p["y"]); page.mouse.down(); page.mouse.move(p["x"]+60, p["y"]+20, steps=12); page.mouse.up(); page.wait_for_timeout(800)
    print("plain drag: pos", objs(page)[0]["pos"], "camera unchanged:", cam(page) == c0, cam(page), c0)
    # shift drag
    o = objs(page)[0]["pos"]; p = lib.client(page, [o[0], 0.5, o[2]])
    page.keyboard.down("Shift"); page.mouse.move(p["x"], p["y"]); page.mouse.down(); page.mouse.move(p["x"], p["y"]-40, steps=10); page.mouse.move(p["x"], p["y"]-90, steps=10); page.mouse.up(); page.keyboard.up("Shift"); page.wait_for_timeout(500)
    print("shift drag: pos", objs(page)[0]["pos"], hist(page))
    page.screenshot(path=str(lib.OUT / "shiftdrag.png"))
    print("errors:", [l for l in logs if l.startswith("[error]") or l.startswith("[pageerror]")])
