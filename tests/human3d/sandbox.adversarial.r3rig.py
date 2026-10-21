"""Round 3: a new profile (new rig) while measurements, an attached object and a sit-on-surface object exist: values follow the new figure, nothing is stale, no errors, no leaked meshes."""
import importlib.util, json
from pathlib import Path
spec = importlib.util.spec_from_file_location("lib", Path(__file__).with_name("sandbox.adversarial.lib.py")); lib = importlib.util.module_from_spec(spec); spec.loader.exec_module(lib)
from shot import browser
SB, MS = lib.SB, lib.MS
with browser(1280, 800) as (page, logs):
    lib.open_human(page, "scene")
    page.evaluate(f"""async () => {{ const sb = await {SB}, ms = await {MS};
      sb.add('crate', {{ position: [0.4, 0, 0.5] }}); sb.attach('o1', {{ kind: 'joint', id: 'wrist_L' }});
      ms.addHeight({{ kind: 'landmark', id: 'vertex' }}); ms.addDistance({{ kind: 'landmark', id: 'eye_mid' }}, {{ kind: 'object', id: 'o1', anchor: 'top_centre' }}); }}""")
    page.wait_for_timeout(800)
    def snap():
        return page.evaluate(f"""async () => {{ const sb = await {SB}, ms = await {MS}, rig = window.__human.ctx.getRig(); ms.flush?.();
          const w = rig.jointWorld('wrist_L', new rig.group.position.constructor()); const o = sb.objects.get('o1');
          const og = o.group.getWorldPosition(new rig.group.position.constructor());
          return {{ vertexY: rig.landmarkWorld('vertex', new rig.group.position.constructor()).y, items: ms.items.map(i => [i.label, +(ms.evaluate(i).value ?? NaN).toFixed(4)]), crate: og.toArray().map(v => +v.toFixed(3)), wrist: w.toArray().map(v => +v.toFixed(3)), meshes: (() => {{ let n = 0; window.__human.viewport.scene.traverse(x => {{ if (x.isMesh) n++; }}); return n; }})(), geoms: window.__human.viewport.renderer.info.memory.geometries }}; }}""")
    print("before", json.dumps(snap()))
    prof = page.evaluate("JSON.parse(JSON.stringify(window.__human.ctx.getProfile()))")
    prof["measures"]["stature"]["value"] += 150
    for i in range(3):
        prof["id"] = f"edited{i}"; prof["measures"]["stature"]["value"] += 10
        page.evaluate("(p) => window.__human.ctx.setProfile(p)", prof)
        page.wait_for_function("(id) => window.__human.ctx.getProfile().id === id", arg=prof["id"], timeout=60000)
        page.wait_for_timeout(1200)
        print("after profile", i, json.dumps(snap()))
    print("errors:", [l for l in logs if l.startswith("[error]") or l.startswith("[pageerror]")][:5])
