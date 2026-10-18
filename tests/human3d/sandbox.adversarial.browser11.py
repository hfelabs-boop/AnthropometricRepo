"""Browser probes 11: scene file UI (hostile files), remember-in-browser across a reload, leaving and re-entering the tab (listeners, errors)."""
import importlib.util, json, os
from pathlib import Path
spec = importlib.util.spec_from_file_location("lib", Path(__file__).with_name("sandbox.adversarial.lib.py")); lib = importlib.util.module_from_spec(spec); spec.loader.exec_module(lib)
from shot import browser
SB, MS = lib.SB, lib.MS
T = lib.OUT
def errs(logs): return [l for l in logs if l.startswith("[error]") or l.startswith("[pageerror]")]
files = {
 "bad.json": "{not json",
 "newer.json": json.dumps({"version": 99, "objects": []}),
 "mixed.json": json.dumps({"version": 1, "objects": [{"type": "nope"}, {"type": "crate", "position": [1e9, -5, "x"], "params": {"width": 1e9, "mass": -4}, "name": "<b>x</b>"}, 5, {"type": "monitor", "attachedTo": {"kind": "joint", "id": "ghost", "offset": [0, 0, 0]}}],
        "measurements": [{"kind": "distance", "a": {"kind": "object", "id": "zzz", "anchor": "a"}, "b": {"kind": "landmark", "id": "vertex"}}, {"kind": "bogus"}]}),
}
for n, c in files.items(): (T / n).write_text(c)
with browser(1280, 800) as (page, logs):
    lib.open_human(page, "scene")
    page.click("summary:has-text('Scene file')"); page.wait_for_timeout(300)
    for n in files:
        page.set_input_files(".hm-sc input[type=file]", str(T / n)); page.wait_for_timeout(900)
        txt = page.locator(".hm-sc-msgs").inner_text()
        print(n, "->", txt.replace("\n", " | ")[:300], "| objects:", page.evaluate(f"async () => (await {SB}).objects.size"), "| items:", page.evaluate(f"async () => (await {MS}).items.length"))
    page.screenshot(path=str(T / "file-warn.png"))
    print("crate params:", page.evaluate(f"async () => [...(await {SB}).objects.values()].map(o => [o.name, o.position, o.params.width, o.params.mass, o.attachError])"))
    # attached object with missing joint: list row shows?
    print("errors:", errs(logs))
    # remember
    page.evaluate(f"async () => (await {SB}).clear()")
    page.evaluate(f"async () => {{ const s = await {SB}; s.add('stool', {{ position: [0.5, 0, 1] }}); }}")
    page.check(".hm-sc label:has-text('Remember this scene') input"); page.wait_for_timeout(900)
    print("localStorage keys:", page.evaluate("Object.keys(localStorage).filter(k => k.startsWith('hm-'))"))
    page.reload(); page.wait_for_function("window.__human && window.__human.state.rig", timeout=120000); page.wait_for_timeout(2500)
    page.click("#hm-tab-scene"); page.wait_for_timeout(800)
    print("after reload objects:", page.evaluate(f"async () => [...(await {SB}).objects.values()].map(o => o.type)"), "remember cb:", page.is_checked(".hm-sc label:has-text('Remember this scene') input"))
    print("canUndo after restore (should be False):", page.evaluate(f"async () => (await {SB}).canUndo"))
    # leave and come back
    page.evaluate("location.hash = '#/catalog'"); page.wait_for_timeout(1200)
    page.evaluate("location.hash = '#/human'"); page.wait_for_timeout(2500)
    print("after leaving/returning: objects", page.evaluate(f"async () => {{ const s = await {SB}; return s ? s.objects.size : 'no sandbox'; }}"), "errors", errs(logs))
    page.click("#hm-tab-scene"); page.wait_for_timeout(600)
    page.click("#hm-tab-measure"); page.wait_for_timeout(600)
    print("tabs ok, errors", errs(logs))
    # remember off clears
    page.click("#hm-tab-scene"); page.wait_for_timeout(300)
    page.uncheck(".hm-sc label:has-text('Remember this scene') input"); page.wait_for_timeout(300)
    print("keys after uncheck:", page.evaluate("Object.keys(localStorage).filter(k => k.startsWith('hm-'))"))
