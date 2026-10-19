"""Round 5: how long does each PNG option block the main thread on software rendering (default scene)."""
import importlib.util, time
from pathlib import Path
spec = importlib.util.spec_from_file_location("lib", Path(__file__).with_name("export.adversarial.lib.py")); lib = importlib.util.module_from_spec(spec); spec.loader.exec_module(lib)
PROBE = """() => { window.__lt = []; try { new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__lt.push(Math.round(e.duration)); }).observe({ entryTypes: ['longtask'] }); } catch (e) {} }"""
with lib.session() as s:
    p = s.page
    s.open()
    s.js(PROBE)
    for scale, transp in [("1×", False), ("1×", True), ("2×", False), ("2×", True)]:
        p.locator(".hm-ex .seg button", has_text=scale).click()
        p.locator(".hm-ex .seg button", has_text="Transparent" if transp else "Scene").first.click()
        for btn in ("Download PNG", "Download 4 views"):
            s.js("window.__lt.length = 0")
            t0 = time.time(); name, data = s.grab(btn, timeout=300000); dt = time.time() - t0; s.idle()
            print(f"{scale} {'transparent' if transp else 'opaque     '} {btn:17s} {len(data)/1e3:8.0f} kB  total {dt:5.1f}s  longest task {max(s.js('window.__lt') or [0])} ms")
    print("errors", s.errors()[:3])
