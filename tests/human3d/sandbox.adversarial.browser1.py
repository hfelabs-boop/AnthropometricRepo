"""Browser probes 1: picking vs the human, drag/orbit interplay, keyboard focus rules, touch."""
import importlib.util, json
from pathlib import Path
spec = importlib.util.spec_from_file_location("lib", Path(__file__).with_name("sandbox.adversarial.lib.py")); lib = importlib.util.module_from_spec(spec); spec.loader.exec_module(lib)
from shot import browser
SB, MS = lib.SB, lib.MS

def objs(page):
    return page.evaluate(f"async () => {{ const sb = await {SB}; return [...sb.objects.values()].map(o => ({{id:o.id,type:o.type,pos:o.position,yaw:o.yaw,params:o.params}})); }}")
def sel(page):
    return page.evaluate(f"async () => (await {SB}).selected")
def hist(page):
    return page.evaluate(f"async () => {{ const s = await {SB}; return {{u: s.canUndo, ul: s.undoLabel, r: s.canRedo}}; }}")

with browser(1280, 800) as (page, logs):
    lib.open_human(page, "scene")
    # --- 1. a box BEHIND the figure chest: click on the figure's chest
    page.evaluate(f"""async () => {{ const sb = await {SB}; sb.add('box', {{ position: [0, 0, -0.6], params: {{ width: 2, depth: 0.3, height: 2 }}, yaw: 0 }}); sb.select(null);
       const vp = window.__human.viewport; vp.camera.position.set(0.3,1.4,4); vp.controls.target.set(0,1.1,0); vp.controls.update(); vp.requestRender(); }}""")
    page.wait_for_timeout(1500)
    chest = page.evaluate("""() => { const rig = window.__human.ctx.getRig(); const p = rig.landmarkWorld('suprasternale'); return [p.x, p.y - 0.12, p.z + 0.12]; }""")
    c = lib.client(page, chest)
    print("chest client", c)
    page.mouse.click(c["x"], c["y"])
    page.wait_for_timeout(500)
    print("after click on chest: sandbox selected =", sel(page), " shell selection =", page.evaluate("JSON.stringify(window.__human.state.selection)"))
    page.screenshot(path=str(lib.OUT / "pick-chest.png"))
    # drag the figure's chest: does the box behind move?
    before = objs(page)[0]["pos"]
    page.mouse.move(c["x"], c["y"]); page.mouse.down(); page.mouse.move(c["x"] + 80, c["y"], steps=8); page.mouse.up(); page.wait_for_timeout(300)
    print("box moved by dragging the figure's chest?", before, "->", objs(page)[0]["pos"])
    page.screenshot(path=str(lib.OUT / "pick-chest-drag.png"))
    print("errors:", [l for l in logs if l.startswith("[error]") or l.startswith("[pageerror]")])
