"""Browser probes 7: the measuring tool with real clicks: snapping, skin points, floor points, live updates under pose / object moves, Escape, tool vs drag, hostile-ish sequences."""
import importlib.util, json, math
from pathlib import Path
spec = importlib.util.spec_from_file_location("lib", Path(__file__).with_name("sandbox.adversarial.lib.py")); lib = importlib.util.module_from_spec(spec); spec.loader.exec_module(lib)
from shot import browser
SB, MS = lib.SB, lib.MS
def items(page): return page.evaluate(f"async () => {{ const ms = await {MS}; return ms.items.map(i => ({{id:i.id,kind:i.kind,a:i.a,b:i.b,c:i.c,r:(() => {{ const r = ms.evaluate(i); return {{ok:r.ok, v:r.value, dx:r.dx, dy:r.dy, dz:r.dz}}; }})()}})); }}")
with browser(1280, 800) as (page, logs):
    lib.open_human(page, "scene")
    page.evaluate("""() => { const vp = window.__human.viewport; vp.camera.position.set(1.8,1.6,3.6); vp.controls.target.set(0,0.9,0.4); vp.controls.update(); vp.requestRender(); }""")
    page.evaluate(f"""async () => {{ const sb = await {SB}; sb.add('box', {{ position: [0.9, 0, 0.8], params: {{width:0.4,depth:0.4,height:0.4}} }}); sb.add('point_marker', {{ position: [-0.8, 0, 0.5], params: {{ height: 1.3 }} }}); }}""")
    page.wait_for_timeout(1200)
    page.click("#hm-tab-measure"); page.wait_for_timeout(600)
    page.click(".hm-ms button:has-text('Distance')"); page.wait_for_timeout(200)
    # first click: top corner of the box (snap to corner_fl) ; second: the marker point
    A = page.evaluate(f"async () => (await {SB}).anchorWorld('o1','corner_fl').toArray()")
    Bp = page.evaluate(f"async () => (await {SB}).anchorWorld('o2','point').toArray()")
    ca, cb = lib.client(page, A), lib.client(page, Bp)
    print("clients", ca, cb)
    page.mouse.move(ca["x"] + 3, ca["y"] + 2); page.wait_for_timeout(500)
    page.screenshot(path=str(lib.OUT / "measure-hover.png"))
    page.mouse.click(ca["x"] + 3, ca["y"] + 2); page.wait_for_timeout(300)
    page.mouse.move(cb["x"] - 2, cb["y"] + 2); page.wait_for_timeout(400)
    page.mouse.click(cb["x"] - 2, cb["y"] + 2); page.wait_for_timeout(500)
    it = items(page); print(json.dumps(it, indent=0)[:600])
    exp = math.dist(A, Bp); print("expected", exp)
    page.screenshot(path=str(lib.OUT / "measure-after.png"))
    # live: move the box, pose change
    page.evaluate(f"async () => (await {SB}).move('o1', {{ x: 0.2, z: 1.5 }})"); page.wait_for_timeout(400)
    A2 = page.evaluate(f"async () => (await {SB}).anchorWorld('o1','corner_fl').toArray()")
    print("after box move: value", items(page)[0]["r"]["v"], "expected", math.dist(A2, Bp))
    # height tool on the skin
    page.click(".hm-ms button:has-text('Height')"); page.wait_for_timeout(200)
    chest = page.evaluate("() => { const rig = window.__human.ctx.getRig(); const p = rig.landmarkWorld('suprasternale'); return [p.x, p.y - 0.15, p.z + 0.2]; }")
    c = lib.client(page, chest); page.mouse.click(c["x"], c["y"]); page.wait_for_timeout(500)
    it = items(page); print("height item", it[-1])
    # figure pose changes: skin point follows
    page.evaluate("""() => { const rig = window.__human.ctx.getRig(); rig.setPose({ root: rig.getPose().root, angles: { L3: [30,0,0], T8: [20,0,0] } }); }""")
    page.wait_for_timeout(500)
    print("height after bending:", items(page)[-1]["r"])
    # Escape twice ends tool
    page.click(".hm-ms button:has-text('Angle')"); page.wait_for_timeout(200)
    page.mouse.click(c["x"] + 40, c["y"] + 40); page.keyboard.press("Escape"); page.wait_for_timeout(200)
    print("tool after 1st Esc:", page.evaluate(f"async () => {{ const m = await {MS}; return [m.tool, m.pending.length]; }}"))
    page.keyboard.press("Escape"); page.wait_for_timeout(200)
    print("tool after 2nd Esc:", page.evaluate(f"async () => {{ const m = await {MS}; return [m.tool, m.pending.length]; }}"))
    # switching tab ends the tool
    page.click(".hm-ms button:has-text('Distance')"); page.click("#hm-tab-scene"); page.wait_for_timeout(300)
    print("tool after leaving tab:", page.evaluate(f"async () => (await {MS}).tool"))
    print("errors:", [l for l in logs if l.startswith("[error]") or l.startswith("[pageerror]")][:5])
