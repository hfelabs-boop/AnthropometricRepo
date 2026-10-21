"""Round 5: 'Use high quality' from the Export tab; profile change from outside while the panel is open and during an export; the file names/content follow the new profile."""
import importlib.util, json
from pathlib import Path
spec = importlib.util.spec_from_file_location("lib", Path(__file__).with_name("export.adversarial.lib.py")); lib = importlib.util.module_from_spec(spec); spec.loader.exec_module(lib)
with lib.session() as s:
    p = s.page
    s.open()
    print("quality note visible:", p.locator(".hm-ex-quality").is_visible(), "|", p.locator(".hm-ex-quality").inner_text().replace("\n", " ")[:160])
    s.button("Use high quality").click()
    p.wait_for_function("() => window.__human.ctx.getRig() && window.__human.ctx.getRig().quality === 'high' && !window.__human.state.busy", timeout=120000)
    p.wait_for_timeout(600)
    print("after: note visible", p.locator(".hm-ex-quality").is_visible(), "| GLB size text:", p.locator(".hm-ex-size").first.inner_text())
    name, data = s.grab("Download GLB"); s.idle(); print(name, len(data))
    # profile swap during export: start the OBJ, then change profile through the shell right away
    rig_before = s.js("() => window.__human.ctx.getRig().body.stature")
    s.button("Download GLB").click(no_wait_after=True)
    p.wait_for_timeout(30)
    s.js("""async () => { const { manualProfile } = await import('/js/anthro.js').catch(() => ({})); }""") if False else None
    res = s.js("""async () => { const a = await import('/js/human/anthro.js'); const prof = a.manualProfile({ sex: 'F', stature: 1600, statureUnit: 'mm', mass: 60, massUnit: 'kg' }); const c = window.__human.ctx; if (c.setProfile) { c.setProfile(prof); return 'setProfile'; } return Object.keys(c).join(','); }""")
    print("profile change via:", res)
    try:
        with p.expect_download(timeout=60000) as d: pass
        print("download:", d.value.suggested_filename)
    except Exception as e:  # noqa: BLE001
        print("no download within 60 s;", p.locator(".hm-ex-msgs").inner_text()[:200].replace("\n", " | "), "| last:", p.locator(".hm-ex-last").inner_text()[:150])
    s.idle(); p.wait_for_timeout(2500)
    print("state line:", p.locator(".hm-ex-state").inner_text().replace("\n", " | "), "| stature", s.js("() => window.__human.ctx.getRig()?.body.stature"))
    print("errors", s.errors()[:3])
