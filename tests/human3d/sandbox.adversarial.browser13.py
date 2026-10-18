import importlib.util
from pathlib import Path
spec = importlib.util.spec_from_file_location("lib", Path(__file__).with_name("sandbox.adversarial.lib.py")); lib = importlib.util.module_from_spec(spec); spec.loader.exec_module(lib)
from shot import browser
SB, MS = lib.SB, lib.MS
with browser(1280, 800) as (page, logs):
    lib.open_human(page, "scene")
    page.evaluate(f"async () => {{ const s = await {SB}; s.add('stool', {{ position: [0.5, 0, 1] }}); const m = await {MS}; m.addHeight({{kind:'landmark',id:'vertex'}}); }}")
    page.evaluate("location.hash = '#/catalog'"); page.wait_for_timeout(1500)
    page.evaluate("location.hash = '#/human'"); page.wait_for_timeout(2500)
    print("after leave/return (no remember): objects", page.evaluate(f"async () => {{ const s = await {SB}; return s ? s.objects.size : 'none'; }}"), "items", page.evaluate(f"async () => (await {MS}).items.length"))
    # key handling while on another site tab: arrows / delete while Human hidden
    page.evaluate("location.hash = '#/catalog'"); page.wait_for_timeout(1000)
    page.keyboard.press("Delete"); page.keyboard.press("ArrowLeft")
    print("errors", [l for l in logs if l.startswith('[error]') or l.startswith('[pageerror]')])
