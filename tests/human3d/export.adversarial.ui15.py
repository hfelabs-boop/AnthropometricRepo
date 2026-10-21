"""Round 5: PNG on a phone-sized page (360 x 700), and when the 3D view is hidden by the page (display none): message, nothing left changed."""
import importlib.util, io
from pathlib import Path
from PIL import Image
spec = importlib.util.spec_from_file_location("lib", Path(__file__).with_name("export.adversarial.lib.py")); lib = importlib.util.module_from_spec(spec); spec.loader.exec_module(lib)
with lib.session(width=360, height=700, mobile=True) as s:
    p = s.page
    s.open()
    print("view size:", s.js("() => { const c = window.__human.viewport.renderer.domElement; const r = c.getBoundingClientRect(); return [r.width, r.height, c.width, c.height] }"))
    for btn in ("Download PNG", "Download 4 views"):
        try:
            name, data = s.grab(btn, timeout=60000); s.idle()
            im = Image.open(io.BytesIO(data)); print(btn, name, im.size)
        except Exception as e:  # noqa: BLE001
            print(btn, "no download:", p.locator(".hm-ex-msgs").inner_text().replace("\n", " | ")[:200])
    s.js("() => { window.__human.viewport.container.style.display = 'none'; }")
    p.wait_for_timeout(300)
    for btn in ("Download PNG", "Download 4 views"):
        try:
            name, data = s.grab(btn, timeout=15000); s.idle()
            im = Image.open(io.BytesIO(data)); print("hidden view:", btn, name, im.size)
        except Exception as e:  # noqa: BLE001
            print("hidden view:", btn, "->", p.locator(".hm-ex-msgs").inner_text().replace("\n", " | ")[:200])
    print("errors", s.errors()[:3])
