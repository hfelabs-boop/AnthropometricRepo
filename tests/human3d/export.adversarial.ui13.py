"""Round 5: the window between a profile change and the rebuilt figure: how long, what does the Export tab say and what do the files hold (profile of the NEW selection, body of the OLD one?)."""
import importlib.util, json, time
from pathlib import Path
spec = importlib.util.spec_from_file_location("lib", Path(__file__).with_name("export.adversarial.lib.py")); lib = importlib.util.module_from_spec(spec); spec.loader.exec_module(lib)
with lib.session() as s:
    p = s.page
    s.open()
    t0 = time.time()
    s.js("""async () => { const a = await import('/js/human/anthro.js'); window.__t0 = performance.now(); window.__done = null; window.__human.ctx.on('rig', () => { window.__done = performance.now() - window.__t0; }); window.__human.ctx.setProfile(a.manualProfile({ sex: 'F', stature: 1500, statureUnit: 'mm', mass: 50, massUnit: 'kg' })); }""")
    p.wait_for_timeout(150)
    print("150 ms after setProfile: rig stature", s.js("() => window.__human.ctx.getRig().body.stature"), "profile", s.js("() => window.__human.ctx.getProfile().label"), "busy", s.js("() => window.__human.state.busy"), "| panel state line:", p.locator(".hm-ex-state").inner_text().replace("\n", " | "))
    name, data = s.grab("Download JSON"); s.idle()
    doc = json.loads(data)
    print("JSON taken in the window:", name, "| profile.label", doc["profile"]["label"], "| profile stature measure", doc["profile"]["measures"]["stature"]["value"], "| body.stature_mm", doc["body"]["stature_mm"], "| mass", doc["body"]["mass_kg"], doc["profile"]["measures"].get("mass", {}).get("value"))
    p.wait_for_function("() => window.__done !== null", timeout=120000)
    print("rig rebuilt after", round(s.js("() => window.__done")), "ms")
    print("errors", s.errors()[:3])
