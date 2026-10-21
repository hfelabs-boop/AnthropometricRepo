import importlib.util
from pathlib import Path
spec = importlib.util.spec_from_file_location("lib", Path(__file__).with_name("sandbox.adversarial.lib.py")); lib = importlib.util.module_from_spec(spec); spec.loader.exec_module(lib)
from shot import browser
SB = lib.SB
with browser(1280, 800) as (page, logs):
    lib.open_human(page, "scene")
    page.evaluate("""() => { const vp = window.__human.viewport; vp.camera.position.set(0.5,0.35,4.5); vp.controls.target.set(0,0.3,1.2); vp.controls.update(); vp.requestRender(); }""")
    page.evaluate(f"async () => {{ const s = await {SB}; s.add('box', {{ position: [0, 0, 1.2], params: {{width:0.4,depth:0.4,height:0.4}} }}); }}")
    page.wait_for_timeout(1200)
    p = lib.client(page, [0, 0.2, 1.2]); print(p)
    page.mouse.move(p["x"], p["y"]); page.mouse.down()
    for dy in range(-4, -40, -4):
        page.mouse.move(p["x"], p["y"] + dy); 
        print(dy, page.evaluate(f"async () => [...(await {SB}).objects.values()][0].position.map(v => +v.toFixed(2))"))
    page.mouse.up()
