"""Export tab opened before any figure exists (profile data delayed): disabled buttons, message, no errors; then the figure arrives and everything enables by itself."""
import importlib.util, json, time
from pathlib import Path
spec = importlib.util.spec_from_file_location("lib", Path(__file__).with_name("export.adversarial.lib.py")); lib = importlib.util.module_from_spec(spec); spec.loader.exec_module(lib)
def route(ctx):
    def h(r):
        time.sleep(0)  # handled below
        r.continue_()
    def slow(r):
        import threading
        threading.Timer(6.0, lambda: (r.continue_() if True else None)).start()
    ctx.route("**/api/v1/populations/**", slow)
with lib.session(route=route) as s:
    p = s.page
    s.open(wait_rig=False, tab="Export", sections=True)
    print("state:", p.locator(".hm-ex-state").inner_text().replace("\n", " | "))
    print("rig now:", s.js("!!window.__human?.state?.rig"))
    dis = s.js("[...document.querySelectorAll('.hm-ex button.hm-ex-btn')].map(b => [b.textContent.trim(), b.disabled])")
    print("buttons disabled:", sum(1 for _, d in dis if d), "of", len(dis), [t for t, d in dis if not d])
    # click a disabled button: nothing happens
    s.button("Download GLB").click(force=True, timeout=2000) if False else None
    p.wait_for_function("window.__human && window.__human.state.rig && !window.__human.state.busy", timeout=120000)
    p.wait_for_timeout(800)
    print("state after:", p.locator(".hm-ex-state").inner_text().replace("\n", " | "))
    dis = s.js("[...document.querySelectorAll('.hm-ex button.hm-ex-btn')].map(b => [b.textContent.trim(), b.disabled])")
    print("buttons disabled after:", [t for t, d in dis if d])
    name, data = s.grab("Download GLB"); print(name, len(data))
    print("errors", s.errors()[:5])
