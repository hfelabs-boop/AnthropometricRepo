"""Round 5: scene file round trip through the Export tab on a fresh page (Scene tab never opened), then the Scene tab; merge; hostile scene; keyboard use of the panel."""
import importlib.util, json
from pathlib import Path
spec = importlib.util.spec_from_file_location("lib", Path(__file__).with_name("export.adversarial.lib.py")); lib = importlib.util.module_from_spec(spec); spec.loader.exec_module(lib)
tmp = lib.SCRATCH / "adv5-scene.json"
with lib.session() as s:
    p = s.page
    s.open(tab=None)
    p.get_by_role("tab", name="Scene").click()
    p.wait_for_timeout(1200)
    n = s.js("""async () => { const m = await import('/js/human/sandbox.js'); const sb = m.sandboxFor(window.__human.ctx); const ids = [];
      for (const t of ['cabin_seat', 'monitor', 'crate']) { const o = sb.add(t, { position: [0.3, 0, 0.8 + ids.length * 0.5], yaw: 15 * ids.length, name: t === 'crate' ? 'Crate =1+1' : undefined }); ids.push(o.id); } return sb.objects.size; }""")
    print("objects", n)
    p.get_by_role("tab", name="Export").click(); p.wait_for_selector(".hm-ex .hm-ex-card")
    s.js("document.querySelectorAll('.hm-ex details.hm-section').forEach((d) => { d.open = true; })")
    p.wait_for_timeout(500)
    print("state line:", p.locator(".hm-ex-state").inner_text().replace("\n", " | "))
    name, data = s.grab("Download scene file"); tmp.write_bytes(data)
    print("scene file", name, len(data), list(json.loads(data).keys()))
    scene_doc = json.loads(data)
with lib.session() as s:
    p = s.page
    s.open()
    print("fresh page, objects in Export state:", p.locator(".hm-ex-state").inner_text().replace("\n", " | "))
    print("Download scene file disabled?", s.button("Download scene file").is_disabled())
    p.locator(".hm-ex input[type=file]").nth(1).set_input_files(str(tmp))
    p.wait_for_timeout(1500); s.idle()
    print("status:", p.locator(".hm-ex-last").inner_text()[:160], "| msgs:", p.locator(".hm-ex-msgs").inner_text()[:200].replace("\n", " | "))
    print("state line:", p.locator(".hm-ex-state").inner_text().replace("\n", " | "))
    print("scene children in viewport:", s.js("() => window.__human.viewport.scene.children.length"))
    p.get_by_role("tab", name="Scene").click(); p.wait_for_timeout(800)
    print("Scene tab text has objects:", [t for t in ("Cabin seat", "Monitor", "Crate") if t in p.locator("#view-human").inner_text()])
    p.get_by_role("tab", name="Export").click(); p.wait_for_timeout(300)
    # load again with merge
    p.get_by_label("Add to the current scene instead of replacing it").check()
    p.locator(".hm-ex input[type=file]").nth(1).set_input_files(str(tmp)); p.wait_for_timeout(1200); s.idle()
    print("after merge:", p.locator(".hm-ex-state").inner_text().replace("\n", " | "), "|", p.locator(".hm-ex-last").inner_text()[:120])
    # hostile scene files
    for label, content in [("not json", "{{"), ("posture file", json.dumps({"app": "digital-human-posture", "version": 1, "pose": {}})), ("empty obj", "{}"), ("bad type", json.dumps({"objects": [{"type": "nope"}]})), ("huge", "x" * 5_000_000)]:
        tmp.write_text(content)
        p.locator(".hm-ex input[type=file]").nth(1).set_input_files(str(tmp)); p.wait_for_timeout(900); s.idle()
        print(f"  {label:12s}", p.locator(".hm-ex-msgs").inner_text().replace("\n", " | ")[:220], "| last:", p.locator(".hm-ex-last").inner_text()[:80])
    print("errors", s.errors())
