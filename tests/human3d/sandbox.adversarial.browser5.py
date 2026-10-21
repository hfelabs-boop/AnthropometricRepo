"""Browser probes 5: draw-call / memory budget with 100 objects, GPU resource leaks over add/remove/measure cycles, cost of a drag step with both panels mounted."""
import importlib.util, json
from pathlib import Path
spec = importlib.util.spec_from_file_location("lib", Path(__file__).with_name("sandbox.adversarial.lib.py")); lib = importlib.util.module_from_spec(spec); spec.loader.exec_module(lib)
from shot import browser
SB, MS = lib.SB, lib.MS
INFO = """() => { const r = window.__human.viewport.renderer; window.__human.viewport.renderNow(); const i = r.info; return { calls: i.render.calls, tris: i.render.triangles, geoms: i.memory.geometries, tex: i.memory.textures, programs: i.programs?.length }; }"""

with browser(1280, 800) as (page, logs):
    lib.open_human(page, "scene")
    page.click("#hm-tab-measure"); page.wait_for_timeout(500); page.click("#hm-tab-scene"); page.wait_for_timeout(500)
    print("base", page.evaluate(INFO))
    page.evaluate("""() => { window.__human.viewport.renderer.shadowMap && console.log('shadows', window.__human.viewport.renderer.shadowMap.enabled); }""")
    page.evaluate(f"""async () => {{ const sb = await {SB}; const cat = await import('/js/human/catalog.js'); const T = cat.CATALOG.map(t=>t.type);
       for (let i = 0; i < 100; i++) sb.add(T[i % T.length], {{ position: [(i % 10) * 1.5 - 7, 0, Math.floor(i / 10) * 1.5 + 1.5] }}); }}""")
    page.wait_for_timeout(1500)
    page.evaluate(f"async () => {{ const vp = window.__human.viewport; vp.camera.position.set(0, 14, 16); vp.controls.target.set(0, 0, 5); vp.controls.update(); }}")
    page.wait_for_timeout(500)
    print("100 objects", page.evaluate(INFO))
    t = page.evaluate("""() => { const vp = window.__human.viewport; const t0 = performance.now(); for (let i = 0; i < 10; i++) vp.renderNow(); return (performance.now() - t0) / 10; }""")
    print("renderNow ms (SwiftShader):", round(t, 1))
    # labels with names shown
    page.evaluate(f"async () => (await {SB}).setShowNames(true)"); page.wait_for_timeout(800)
    page.evaluate("() => window.__human.viewport.frame(new (window.__human.viewport.camera.position.constructor)().constructor ? undefined : undefined)") if False else None
    page.evaluate(f"async () => (await {SB}).frameObjects(null)"); page.wait_for_timeout(1500)
    page.screenshot(path=str(lib.OUT / "100objects-names.png"))
    # cost of a scene 'move' emit with both panels mounted
    ms_t = page.evaluate(f"""async () => {{ const sb = await {SB}; const ctx = window.__human.ctx; const id = [...sb.objects.keys()][3];
        const t0 = performance.now(); for (let i = 0; i < 20; i++) {{ sb.move(id, {{ x: i * 0.01 }}, {{ snap: false }}); }} return (performance.now() - t0) / 20; }}""")
    print("sb.move() incl. synchronous listeners ms:", round(ms_t, 2))
    # time of the panel handler path (scene emit) alone
    print("emit scene ms:", round(page.evaluate("""() => { const c = window.__human.ctx; const t0 = performance.now(); for (let i = 0; i < 20; i++) c.emit('scene', { op: 'move', id: 'o4', live: true }); return (performance.now() - t0) / 20; }"""), 2))
    # clear and measure leak
    page.evaluate(f"async () => {{ const sb = await {SB}; sb.clear(); }}"); page.wait_for_timeout(800)
    base = page.evaluate(INFO); print("after clear", base)
    for rnd in range(3):
        page.evaluate(f"""async () => {{ const sb = await {SB}, ms = await {MS}; const cat = await import('/js/human/catalog.js'); const T = cat.CATALOG.map(t=>t.type);
          for (let i = 0; i < 59; i++) {{ const o = sb.add(T[i], {{ select: true }}); const ps = cat.byType(T[i]).params.find(p => p.kind === 'number'); if (ps) sb.setParam(o.id, ps.key, ps.max);
            const it = ms.addDistance({{ kind: 'landmark', id: 'vertex' }}, {{ kind: 'object', id: o.id, local: [0, 0.1, 0] }}); ms.flush(); window.__human.viewport.renderNow(); sb.remove(o.id); ms.flush(); ms.remove(it.id); window.__human.viewport.renderNow(); }}
        }}""")
        page.wait_for_timeout(600)
        print(f"cycle {rnd}", page.evaluate(INFO))
    print("canvases in document:", page.evaluate("document.querySelectorAll('canvas').length"))
    print("errors:", [l for l in logs if l.startswith("[error]") or l.startswith("[pageerror]")][:5])
