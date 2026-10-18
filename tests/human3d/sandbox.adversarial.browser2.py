"""Browser probes 2: keyboard and focus rules, drag semantics with the real orbit controls."""
import importlib.util, json
from pathlib import Path
spec = importlib.util.spec_from_file_location("lib", Path(__file__).with_name("sandbox.adversarial.lib.py")); lib = importlib.util.module_from_spec(spec); spec.loader.exec_module(lib)
from shot import browser
SB, MS = lib.SB, lib.MS
def objs(page):
    return page.evaluate(f"async () => {{ const sb = await {SB}; return [...sb.objects.values()].map(o => ({{id:o.id,type:o.type,pos:o.position.map(v=>+v.toFixed(4)),yaw:o.yaw}})); }}")
def sel(page): return page.evaluate(f"async () => (await {SB}).selected")
def cam(page): return page.evaluate("(() => { const v = window.__human.viewport; return [v.camera.position.toArray().map(x=>+x.toFixed(3)), v.controls.target.toArray().map(x=>+x.toFixed(3))]; })()")
def hist(page): return page.evaluate(f"async () => {{ const s = await {SB}; return [s.canUndo, s.undoLabel, s.canRedo]; }}")

with browser(1280, 800) as (page, logs):
    lib.open_human(page, "scene")
    page.evaluate("""() => { const vp = window.__human.viewport; vp.camera.position.set(2.5,2.2,4); vp.controls.target.set(0,0.6,1); vp.controls.update(); vp.requestRender(); }""")
    page.evaluate(f"""async () => {{ const sb = await {SB}; sb.add('box', {{ position: [0, 0, 1.2], params: {{width:0.5,depth:0.5,height:0.5}}, select: true }}); }}""")
    page.wait_for_timeout(600)
    print("start", objs(page), hist(page))
    # A. focus canvas, arrows
    page.focus("canvas") if page.locator("canvas").count() else None
    ae = page.evaluate("document.activeElement?.tagName + '.' + (document.activeElement?.className||'')")
    print("active after focus canvas:", ae)
    c0 = cam(page)
    page.keyboard.press("ArrowRight"); page.keyboard.press("ArrowRight"); page.keyboard.press("ArrowUp")
    print("after 3 arrows (selected):", objs(page)[0]["pos"], "camera moved?", cam(page) != c0, hist(page))
    page.keyboard.press("Escape"); page.wait_for_timeout(200)
    print("after Esc selected:", sel(page))
    c0 = cam(page)
    page.keyboard.press("ArrowRight"); page.wait_for_timeout(400)
    print("arrow with nothing selected moves camera:", cam(page) != c0, " box pos", objs(page)[0]["pos"])
    # B. Delete with focus in inputs
    page.evaluate(f"async () => (await {SB}).select('o1')"); page.wait_for_timeout(300)
    page.focus(".hm-sc input[type=search]"); page.keyboard.type("lad"); page.keyboard.press("Delete"); page.keyboard.press("Backspace")
    print("typing in search keeps object:", len(objs(page)))
    page.fill(".hm-sc input[type=search]", "")
    # Delete with focus on a card (button)
    page.click(".hm-obj-cats button:has-text('Seating')")
    page.focus(".hm-obj-card[data-type='stool']"); page.keyboard.press("Delete"); page.wait_for_timeout(300)
    print("Delete with focus on a catalogue card removed object?", len(objs(page)) == 0)
    page.keyboard.press("Control+z"); page.wait_for_timeout(300)
    print("ctrl+z with focus on card undoes:", len(objs(page)))
    # slider focus: arrows move the slider not the object
    page.evaluate(f"async () => (await {SB}).select('o1')"); page.wait_for_timeout(500)
    sl = page.locator(".hm-ed input[type=range]").first
    sl.focus(); before = objs(page)[0]; page.keyboard.press("ArrowRight"); page.keyboard.press("Delete"); page.wait_for_timeout(300)
    print("slider arrow/Delete keeps object:", len(objs(page)), objs(page)[0]["pos"] == before["pos"])
    # number input: ctrl+z
    num = page.locator(".hm-ed input[type=number]").first
    num.focus(); page.keyboard.press("Control+z"); page.wait_for_timeout(200)
    print("ctrl+z in a number input -> objects", len(objs(page)), hist(page))
    # C. measure tab: Delete does nothing
    page.click("#hm-tab-measure"); page.wait_for_timeout(500)
    page.evaluate(f"async () => (await {SB}).select('o1')")
    page.keyboard.press("Delete"); page.keyboard.press("ArrowLeft"); page.wait_for_timeout(200)
    print("measure tab Delete keeps object:", len(objs(page)))
    page.click("#hm-tab-scene"); page.wait_for_timeout(500)
    # E. real drag with orbit controls
    box = objs(page)[0]; p = lib.client(page, [box["pos"][0], 0.5, box["pos"][2]])
    c0 = cam(page); h0 = hist(page)
    page.mouse.move(p["x"], p["y"]); page.mouse.down(); page.mouse.move(p["x"]+60, p["y"]+20, steps=12); page.mouse.move(p["x"]+120, p["y"]+10, steps=12); page.mouse.up(); page.wait_for_timeout(300)
    print("drag: pos", objs(page)[0]["pos"], "camera unchanged:", cam(page) == c0, "history", hist(page), "controls.enabled", page.evaluate("window.__human.viewport.controls.enabled"))
    page.keyboard.press("Control+z"); page.wait_for_timeout(200)
    print("undo drag -> pos", objs(page)[0]["pos"], hist(page))
    # F. drag locked
    page.evaluate(f"async () => (await {SB}).setLocked('o1', true)"); page.wait_for_timeout(200)
    p = lib.client(page, [objs(page)[0]["pos"][0], 0.5, objs(page)[0]["pos"][2]]); c0 = cam(page)
    page.mouse.move(p["x"], p["y"]); page.mouse.down(); page.mouse.move(p["x"]+100, p["y"], steps=10); page.mouse.up(); page.wait_for_timeout(300)
    print("drag locked object: stays", objs(page)[0]["pos"], "camera orbited:", cam(page) != c0)
    # G. hidden object not pickable; mouse down outside; right button drag
    page.evaluate(f"async () => {{ const s = await {SB}; s.setLocked('o1', false); }}")
    p = lib.client(page, [objs(page)[0]["pos"][0], 0.5, objs(page)[0]["pos"][2]])
    page.mouse.move(p["x"], p["y"]); page.mouse.down(button="right"); page.mouse.move(p["x"]+100, p["y"], steps=10); page.mouse.up(button="right"); page.wait_for_timeout(300)
    print("right-drag on object: moved?", objs(page)[0]["pos"])
    # H. shift = vertical drag
    page.mouse.move(p["x"], p["y"]); page.keyboard.down("Shift"); page.mouse.down(); page.mouse.move(p["x"], p["y"]-80, steps=10); page.mouse.up(); page.keyboard.up("Shift"); page.wait_for_timeout(300)
    print("shift drag up:", objs(page)[0]["pos"])
    print("errors:", [l for l in logs if l.startswith("[error]") or l.startswith("[pageerror]")])
