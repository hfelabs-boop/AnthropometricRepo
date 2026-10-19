"""Round 3: does the camera stay still while an object is dragged (with orbit damping), is the object under the pointer all along (grab offset), is the pick over the
figure's mesh ignored, does a drag that ends outside the canvas end cleanly?"""
import importlib.util, json
from pathlib import Path
spec = importlib.util.spec_from_file_location("lib", Path(__file__).with_name("sandbox.adversarial.lib.py")); lib = importlib.util.module_from_spec(spec); spec.loader.exec_module(lib)
from shot import browser
SB = lib.SB
CAM = "() => { const v = window.__human.viewport; return [...v.camera.position.toArray(), ...v.controls.target.toArray()].map(x => +x.toFixed(5)); }"
with browser(1280, 800) as (page, logs):
    lib.open_human(page, "scene")
    page.evaluate(f"async () => {{ const sb = await {SB}; sb.add('box', {{ position: [0.5, 0, 1.0], params: {{ width: 0.5, depth: 0.5, height: 0.5 }}, yaw: 0 }}); sb.select(null); }}")
    page.wait_for_timeout(2500)  # let any framing animation / damping settle
    c0 = page.evaluate(CAM)
    p = lib.client(page, [0.5, 0.5, 1.0])
    # grab at a point away from the centre: the box must not jump
    q = lib.client(page, [0.5 + 0.2, 0.5, 1.0])
    print("grab at +0.2 m from centre; screen dx", round(q["x"] - p["x"], 1))
    page.mouse.move(q["x"], q["y"]); page.mouse.down()
    page.mouse.move(q["x"] + 2, q["y"], steps=2)
    first = page.evaluate(f"async () => (await {SB}).objects.get('o1').position")
    print("after 2px: pos", first)
    page.mouse.move(q["x"] + 100, q["y"] + 30, steps=15)
    mid = page.evaluate(CAM)
    page.mouse.up(); page.wait_for_timeout(1200)
    c1 = page.evaluate(CAM)
    print("camera before", c0, "\ncamera mid-drag", mid, "\ncamera after  ", c1, "\nchanged during drag:", mid != c0, "after:", c1 != c0)
    # drag ending outside the canvas (over the side panel) then release
    q = lib.client(page, [page.evaluate(f"async () => (await {SB}).objects.get('o1').position")[0], 0.5, page.evaluate(f"async () => (await {SB}).objects.get('o1').position")[2]])
    page.mouse.move(q["x"], q["y"]); page.mouse.down(); page.mouse.move(100, 400, steps=10); page.mouse.up(); page.wait_for_timeout(300)
    st = page.evaluate(f"async () => {{ const s = await {SB}; return {{ pos: s.objects.get('o1').position, drag: !!s.dragging, en: window.__human.viewport.controls.enabled, undo: s.undoLabel }}; }}")
    print("drag released over the side panel:", st)
    # drag, then Escape mid-drag
    q = lib.client(page, [st["pos"][0], 0.5, st["pos"][2]])
    before = st["pos"]
    page.mouse.move(q["x"], q["y"]); page.mouse.down(); page.mouse.move(q["x"] + 50, q["y"], steps=6); page.keyboard.press("Escape"); page.mouse.move(q["x"] + 90, q["y"], steps=4); page.mouse.up(); page.wait_for_timeout(300)
    st2 = page.evaluate(f"async () => {{ const s = await {SB}; return {{ pos: s.objects.get('o1').position, sel: s.selected, undo: s.undoLabel }}; }}")
    print("escape mid-drag: before", before, "->", st2)
    # window blur / alt-tab mid drag
    q = lib.client(page, [st2["pos"][0], 0.5, st2["pos"][2]])
    page.mouse.move(q["x"], q["y"]); page.mouse.down(); page.mouse.move(q["x"] + 40, q["y"], steps=4)
    page.evaluate("window.dispatchEvent(new Event('blur'))"); page.mouse.move(q["x"] + 80, q["y"], steps=4); page.mouse.up(); page.wait_for_timeout(300)
    print("after blur mid-drag: controls.enabled", page.evaluate("window.__human.viewport.controls.enabled"))
    print("errors:", [l for l in logs if l.startswith("[error]") or l.startswith("[pageerror]")])
