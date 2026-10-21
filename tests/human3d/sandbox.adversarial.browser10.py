import importlib.util
from pathlib import Path
spec = importlib.util.spec_from_file_location("lib", Path(__file__).with_name("sandbox.adversarial.lib.py")); lib = importlib.util.module_from_spec(spec); spec.loader.exec_module(lib)
from shot import browser
SB = lib.SB
with browser(1280, 800) as (page, logs):
    lib.open_human(page, "scene")
    page.evaluate("""() => { const vp = window.__human.viewport; vp.camera.position.set(0.0,3.0,3.6); vp.controls.target.set(0,0.2,1.2); vp.controls.update(); vp.requestRender(); }""")
    page.evaluate(f"""async () => {{ const sb = await {SB}; sb.add('box', {{ position: [0, 0, 1.2], params: {{width:0.4,depth:0.4,height:0.4}}, select: true }}); sb.setGizmoMode('rotate'); sb.setSnap({{ angleDeg: 45 }}); }}""")
    page.wait_for_timeout(1500)
    page.screenshot(path=str(lib.OUT / "gizmo-rotate2.png"))
    o = lib.client(page, [0, 0, 1.2]); print(o)
    page.mouse.move(o["x"] + 60, o["y"]) 
    for dx in range(30, 140, 6):
        page.mouse.move(o["x"] + dx, o["y"] + 0); 
    # find ring by probing: use viewport gizmo picker
    page.mouse.move(o["x"], o["y"])
    for r in range(40, 140, 4):
        page.mouse.move(o["x"] + r, o["y"] + 1); page.wait_for_timeout(30)
        ax = page.evaluate("window.__human.viewport.gizmo.axis")
        if ax: print("ring axis", ax, "at r", r); break
    page.mouse.down(); page.mouse.move(o["x"] + r, o["y"] + 25, steps=5); page.mouse.move(o["x"] + r - 20, o["y"] + 50, steps=5); page.mouse.up(); page.wait_for_timeout(400)
    print(page.evaluate(f"async () => {{ const o = [...(await {SB}).objects.values()][0]; return [o.position, o.yaw, o.group.rotation.toArray()]; }}"))
    page.evaluate(f"async () => (await {SB}).setSnap({{ angleDeg: 45 }})"); page.wait_for_timeout(300)
    for r2 in range(40, 140, 4):
        page.mouse.move(o["x"] + r2, o["y"] + 1); page.wait_for_timeout(30)
        if page.evaluate("window.__human.viewport.gizmo.axis"): break
    page.mouse.down(); page.mouse.move(o["x"] + r2, o["y"] + 15, steps=5); page.mouse.up(); page.wait_for_timeout(300)
    print("snapped yaw", page.evaluate(f"async () => [...(await {SB}).objects.values()][0].yaw"))
