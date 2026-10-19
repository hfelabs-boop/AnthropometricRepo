"""200 scene objects in the real page: how long does each export block the main thread (long tasks, rAF gaps), busy state, memory (object URLs), result sizes."""
import importlib.util, json, sys, time
from pathlib import Path
spec = importlib.util.spec_from_file_location("lib", Path(__file__).with_name("export.adversarial.lib.py")); lib = importlib.util.module_from_spec(spec); spec.loader.exec_module(lib)

PROBE = """() => { window.__lt = []; window.__gaps = []; try { new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__lt.push(Math.round(e.duration)); }).observe({ entryTypes: ['longtask'] }); } catch (e) {}
  let last = performance.now(); const loop = () => { const n = performance.now(); window.__gaps.push(Math.round(n - last)); last = n; requestAnimationFrame(loop); }; requestAnimationFrame(loop); }"""

with lib.session() as s:
    p = s.page
    s.open()
    n = s.js("""async () => { const m = await import('/js/human/sandbox.js'); const sb = m.sandboxFor(window.__human.ctx); const kinds = ['crate','monitor','chair-seat'].filter(Boolean); let c = 0;
      const types = (await import('/js/human/catalog.js')).CATALOG.map((t) => t.type); window.__types = types;
      for (let i = 0; i < 200; i++) { const t = types[i % types.length]; try { sb.add(t, { position: [(i % 20) * 0.6 - 6, 0, Math.floor(i / 20) * 0.6 + 1.5], name: 'Object ' + i }); c++; } catch (e) { window.__err = String(e); } }
      return c; }""")
    print("objects added", n, s.js("window.__types.length"), s.js("window.__err"))
    p.wait_for_timeout(1500)
    print("panel state:", p.locator(".hm-ex-state").inner_text().replace("\n", " | "))
    s.js(PROBE)
    for btn in ["Download GLB", "Download OBJ", "Download STL", "Download JSON", "Download 4 views"]:
        s.js("window.__lt.length = 0; window.__gaps.length = 0")
        t0 = time.time()
        try:
            name, data = s.grab(btn, timeout=180000)
        except Exception as e:  # noqa: BLE001
            print(btn, "failed", str(e)[:200]); s.idle(); continue
        dt = time.time() - t0
        s.idle()
        lt = s.js("window.__lt"); gaps = s.js("window.__gaps")
        print(f"{btn:18s} {name[:60]:60s} {len(data)/1e6:7.2f} MB  total {dt:5.1f}s  longtasks {sorted(lt)[-3:]}  max rAF gap {max(gaps) if gaps else None} ms")
        p.wait_for_timeout(2500)
    print("status:", p.locator(".hm-ex-last").inner_text()[:200])
    u = s.js("0")
    print("errors", s.errors())
