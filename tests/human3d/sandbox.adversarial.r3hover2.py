import importlib.util
from pathlib import Path
spec = importlib.util.spec_from_file_location("lib", Path(__file__).with_name("sandbox.adversarial.lib.py")); lib = importlib.util.module_from_spec(spec); spec.loader.exec_module(lib)
from shot import browser
SB = lib.SB
with browser(1280, 800) as (page, logs):
    lib.open_human(page, "scene")
    page.evaluate(f"async () => {{ const sb = await {SB}; sb.add('box', {{ position: [0.5, 0, 1.0], params: {{ width: 0.5, depth: 0.5, height: 0.5 }} }}); sb.add('crate', {{ position: [-0.8, 0, 1.0] }}); sb.select(null); }}")
    page.wait_for_timeout(2000)
    a = lib.client(page, [0.5, 0.25, 1.0]); b = lib.client(page, [-0.8, 0.2, 1.0])
    print("a", a, "b", b)
    for nm, c in (("a", a), ("b", b)):
        print(nm, "pickAt:", page.evaluate(f"async () => {{ const s = await {SB}; const h = s.pickAt({c['x']}, {c['y']}); return h ? h.obj.id : null; }}"))
    page.mouse.move(a["x"], a["y"]); page.wait_for_timeout(400)
    print("hover after move to a:", page.evaluate(f"async () => (await {SB}).hovered"))
    page.mouse.move(a["x"] + 3, a["y"] + 2); page.wait_for_timeout(400)
    print("hover after 2nd move:", page.evaluate(f"async () => (await {SB}).hovered"))
    page.mouse.move(b["x"], b["y"]); page.wait_for_timeout(400); print("b:", page.evaluate(f"async () => (await {SB}).hovered"))
    page.mouse.move(a["x"], a["y"]); page.wait_for_timeout(400); print("a again:", page.evaluate(f"async () => (await {SB}).hovered"))
    page.mouse.move(a["x"]+4, a["y"]+3); page.wait_for_timeout(400); print("a again 2:", page.evaluate(f"async () => (await {SB}).hovered"))
    page.screenshot(path="/tmp/claude-0/-home-user-AnthropometricRepo/47fa7a9b-9f20-5ccb-be11-268d4792d952/scratchpad/r3/hover.png")
