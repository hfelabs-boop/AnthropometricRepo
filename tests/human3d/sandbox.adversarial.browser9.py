"""Browser probes 9: real TransformControls gizmo drags: translate, rotate, scale, undo steps, snapping, orbit suspended."""
import importlib.util, json
from pathlib import Path
spec = importlib.util.spec_from_file_location("lib", Path(__file__).with_name("sandbox.adversarial.lib.py")); lib = importlib.util.module_from_spec(spec); spec.loader.exec_module(lib)
from shot import browser
SB = lib.SB
def obj(page): return page.evaluate(f"async () => {{ const o = [...(await {SB}).objects.values()][0]; return {{pos:o.position.map(v=>+v.toFixed(4)), yaw:+o.yaw.toFixed(2), params:o.params}}; }}")
def hist(page): return page.evaluate(f"async () => {{ const s = await {SB}; return [s.canUndo, s.undoLabel, s.canRedo]; }}")
def cam(page): return page.evaluate("(() => { const v = window.__human.viewport; return v.camera.position.toArray().map(x=>+x.toFixed(3)); })()")
def count_steps(page):
    n = 0
    while page.evaluate(f"async () => (await {SB}).undo()"): n += 1
    return n
with browser(1280, 800) as (page, logs):
    lib.open_human(page, "scene")
    page.evaluate("""() => { const vp = window.__human.viewport; vp.camera.position.set(0.0,1.6,4.2); vp.controls.target.set(0,0.4,1.2); vp.controls.update(); vp.requestRender(); }""")
    page.evaluate(f"""async () => {{ const sb = await {SB}; sb.add('box', {{ position: [0, 0, 1.2], params: {{width:0.4,depth:0.4,height:0.4}}, select: true }}); }}""")
    page.wait_for_timeout(1500)
    page.screenshot(path=str(lib.OUT / "gizmo-translate.png"))
    o0 = lib.client(page, [0, 0, 1.2]); print("origin client", o0)
    # find X arrow: sample points right of origin
    import math
    def drag(x0, y0, dx, dy):
        page.mouse.move(x0, y0); page.mouse.down(); page.mouse.move(x0 + dx / 2, y0 + dy / 2, steps=6); page.mouse.move(x0 + dx, y0 + dy, steps=6); page.mouse.up(); page.wait_for_timeout(400)
    c0 = cam(page)
    px = {"x": o0["x"] + 42, "y": o0["y"]}
    print("x handle client", px)
    drag(px["x"], px["y"], 90, 0)
    print("after X gizmo drag", obj(page), "camera same", cam(page) == c0, hist(page))
    o1c = lib.client(page, [obj(page)["pos"][0], 0, 1.2]); pz = {"x": o1c["x"], "y": o1c["y"] + 30}
    drag(pz["x"], pz["y"], 0, 60)
    print("after Z drag", obj(page), hist(page))
    print("undo steps available beyond add:", count_steps(page) - 1, "(expect 2)")
    print("pos after all undos (box removed?):", page.evaluate(f"async () => (await {SB}).objects.size"))
    # redo all
    while page.evaluate(f"async () => (await {SB}).redo()"): pass
    # rotate
    page.keyboard.press("e") if False else page.evaluate(f"async () => (await {SB}).setGizmoMode('rotate')")
    page.wait_for_timeout(500); page.screenshot(path=str(lib.OUT / "gizmo-rotate.png"))
    p = obj(page)["pos"]
    oc = lib.client(page, p); r = {"x": oc["x"] + 55, "y": oc["y"]}
    drag(r["x"], r["y"], 0, 50)
    print("after rotate drag", obj(page), hist(page))
    # scale
    page.evaluate(f"async () => (await {SB}).setGizmoMode('scale')"); page.wait_for_timeout(500)
    page.screenshot(path=str(lib.OUT / "gizmo-scale.png"))
    p = obj(page)["pos"]
    before = obj(page)["params"]
    oc = lib.client(page, p); s = {"x": oc["x"] + 42, "y": oc["y"]}
    drag(s["x"], s["y"], 40, 0)
    print("after scale drag", obj(page)["params"], hist(page))
    # snap grid 50 mm, translate
    page.evaluate(f"async () => {{ const s = await {SB}; s.setSnap({{ gridMm: 100 }}); s.setGizmoMode('translate'); }}"); page.wait_for_timeout(400)
    p = obj(page)["pos"]; oc = lib.client(page, p); px = {"x": oc["x"] + 42, "y": oc["y"]}
    drag(px["x"], px["y"], 33, 0)
    print("after snapped X drag", obj(page)["pos"])
    print("errors:", [l for l in logs if l.startswith("[error]") or l.startswith("[pageerror]")][:5])
