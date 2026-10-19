"""Round 2: 'Remember this scene' must also bring back the measurements (they are in the scene file) after a reload, and must not overwrite them with an empty list."""
import importlib.util, json
from pathlib import Path
spec = importlib.util.spec_from_file_location("lib", Path(__file__).with_name("sandbox.adversarial.lib.py")); lib = importlib.util.module_from_spec(spec); spec.loader.exec_module(lib)
from shot import browser
SB, MS = lib.SB, lib.MS
with browser(1280, 800) as (page, logs):
    lib.open_human(page, "scene")
    page.evaluate(f"""async () => {{ const sb = await {SB}, ms = await {MS};
      const o = sb.add('monitor', {{ position: [0, 0, 1.5] }}); sb.setRemember(true);
      ms.addDistance({{ kind: 'landmark', id: 'eye_mid' }}, {{ kind: 'object', id: o.id, anchor: 'screen_centre' }}, {{ label: 'Eye to screen' }});
      ms.addHeight({{ kind: 'landmark', id: 'vertex' }});
      sb.add('stool'); sb.saveLocal(); }}""")
    page.wait_for_timeout(1000)
    stored = json.loads(page.evaluate("localStorage.getItem('hm-scene')"))
    print("stored before reload: objects", len(stored["objects"]), "measurements", len(stored.get("measurements", [])))
    page.reload(); page.wait_for_function("window.__human && window.__human.state.rig", timeout=180000); page.wait_for_timeout(2500)
    page.click("#hm-tab-scene"); page.wait_for_selector(".hm-sc", timeout=60000); page.wait_for_timeout(1500)
    r = page.evaluate(f"""async () => {{ const sb = await {SB}, ms = await {MS}; return {{ objects: [...sb.objects.values()].map(o => o.type), items: ms ? ms.items.map(i => i.label) : null }}; }}""")
    print("after reload:", r)
    page.wait_for_timeout(1500)
    stored2 = json.loads(page.evaluate("localStorage.getItem('hm-scene')"))
    print("stored after reload: objects", len(stored2["objects"]), "measurements", len(stored2.get("measurements", [])))
    print("errors:", [l for l in logs if l.startswith("[error]") or l.startswith("[pageerror]")])
