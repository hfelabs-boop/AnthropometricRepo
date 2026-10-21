"""Browser probes 4: touch (CDP touch events): tap select, one-finger drag on an object, pinch started on an object, two-finger gestures."""
import importlib.util, json, math
from pathlib import Path
spec = importlib.util.spec_from_file_location("lib", Path(__file__).with_name("sandbox.adversarial.lib.py")); lib = importlib.util.module_from_spec(spec); spec.loader.exec_module(lib)
from shot import browser
SB = lib.SB
def objs(page):
    return page.evaluate(f"async () => {{ const sb = await {SB}; return [...sb.objects.values()].map(o => ({{id:o.id,pos:o.position.map(v=>+v.toFixed(4))}})); }}")
def sel(page): return page.evaluate(f"async () => (await {SB}).selected")
def camd(page): return page.evaluate("(() => { const v = window.__human.viewport; return [v.camera.position.distanceTo(v.controls.target), v.camera.position.toArray().map(x=>+x.toFixed(2))]; })()")

with browser(390, 800, mobile=True) as (page, logs):
    lib.open_human(page, "scene")
    cdp = page.context.new_cdp_session(page)
    def touch(kind, pts):
        cdp.send("Input.dispatchTouchEvent", {"type": kind, "touchPoints": [{"x": x, "y": y, "id": i} for i, (x, y) in enumerate(pts)]})
    page.evaluate(f"""async () => {{ const sb = await {SB}; sb.add('box', {{ position: [0, 0, 1.2], params: {{width:0.8,depth:0.8,height:0.8}} }}); sb.select(null);
        const vp = window.__human.viewport; vp.camera.position.set(1.5,1.6,4); vp.controls.target.set(0,0.5,1); vp.controls.update(); vp.requestRender(); }}""")
    page.evaluate("document.querySelector('canvas').scrollIntoView({block:'center'})")
    page.wait_for_timeout(1200)
    p = lib.client(page, [0, 0.4, 1.2]); print("box client", p)
    x, y = p["x"], p["y"]
    # tap
    touch("touchStart", [(x, y)]); touch("touchEnd", []); page.wait_for_timeout(500)
    print("tap selects:", sel(page))
    page.evaluate(f"async () => (await {SB}).select(null)")
    # one-finger drag on the object
    touch("touchStart", [(x, y)])
    for i in range(1, 15): touch("touchMove", [(x + i * 4, y + i)]); page.wait_for_timeout(20)
    touch("touchEnd", []); page.wait_for_timeout(500)
    print("one finger drag: ", objs(page), "selected", sel(page))
    # pinch: first finger on object, second elsewhere
    d0 = camd(page)
    p = lib.client(page, [objs(page)[0]["pos"][0], 0.4, objs(page)[0]["pos"][2]]); x, y = p["x"], p["y"]
    touch("touchStart", [(x, y)]); page.wait_for_timeout(50)
    touch("touchStart", [(x, y), (x + 80, y + 120)]); page.wait_for_timeout(50)
    for i in range(1, 12): touch("touchMove", [(x - i * 4, y - i * 4), (x + 80 + i * 6, y + 120 + i * 8)]); page.wait_for_timeout(20)
    touch("touchEnd", []); page.wait_for_timeout(600)
    d1 = camd(page)
    print("pinch from object: objects", objs(page), "cam distance", d0[0], "->", d1[0], "(zoom happened:", abs(d1[0]-d0[0]) > 0.05, ")")
    # baseline: same pinch with the object hidden (first finger on empty floor)
    page.evaluate(f"async () => (await {SB}).setVisible('o1', false)"); page.wait_for_timeout(300)
    d0 = camd(page)
    touch("touchStart", [(x, y)]); page.wait_for_timeout(50)
    touch("touchStart", [(x, y), (x + 80, y + 120)]); page.wait_for_timeout(50)
    for i in range(1, 12): touch("touchMove", [(x - i * 4, y - i * 4), (x + 80 + i * 6, y + 120 + i * 8)]); page.wait_for_timeout(20)
    touch("touchEnd", []); page.wait_for_timeout(600)
    print("BASELINE pinch from empty floor: cam distance", d0[0], "->", camd(page)[0])
    page.evaluate(f"async () => (await {SB}).setVisible('o1', true)"); page.wait_for_timeout(300)
    # pinch with both fingers off the object
    d0 = camd(page)
    touch("touchStart", [(40, 300), (350, 300)]); 
    for i in range(1, 12): touch("touchMove", [(40 + i * 8, 300), (350 - i * 8, 300)]); page.wait_for_timeout(20)
    touch("touchEnd", []); page.wait_for_timeout(600)
    print("pinch off object: cam distance", d0[0], "->", camd(page)[0])
    print("errors:", [l for l in logs if l.startswith("[error]") or l.startswith("[pageerror]")])
    page.screenshot(path=str(lib.OUT / "touch.png"))
