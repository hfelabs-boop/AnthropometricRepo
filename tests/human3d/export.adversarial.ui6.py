"""Round 5: PNG content (opaque, transparent with and without grid/shadow, 4 views) decoded with Pillow, in light and dark theme; saved for looking at."""
import importlib.util, io, json
from pathlib import Path
from PIL import Image
spec = importlib.util.spec_from_file_location("lib", Path(__file__).with_name("export.adversarial.lib.py")); lib = importlib.util.module_from_spec(spec); spec.loader.exec_module(lib)
for dark in (False, True):
    with lib.session(dark=dark) as s:
        s.open()
        s.js("""() => { const r = window.__human.ctx.getRig(); r.setPose({ root: { x: 0, y: 0.5, z: 0, heading: 20, flex: 0, lat: 0, rot: 0 }, angles: { hip_L: [100, 0, 0], hip_R: [100, 0, 0], knee_L: [110], knee_R: [110], shoulder_L: [80, 0, 0], shoulder_R: [80, 0, 0], elbow_L: [60], elbow_R: [60] } }, { clamp: true }); window.__human.ctx.emit('pose', {}); }""")
        s.page.wait_for_timeout(600)
        tag = "dark" if dark else "light"
        def png(btn, name):
            fn, data = s.grab(btn, timeout=180000); s.idle()
            im = Image.open(io.BytesIO(data)); im.save(lib.SCRATCH / f"adv5-{tag}-{name}.png")
            a = im.getchannel("A") if im.mode == "RGBA" else None
            stat = None if a is None else (min(a.getdata()), max(a.getdata()), sum(1 for v in a.getdata() if 0 < v < 255))
            print(tag, name, fn, im.size, im.mode, "alpha(min,max,partial)=", stat)
        png("Download PNG", "opaque")
        s.page.locator(".hm-ex .seg button", has_text="Transparent").click()
        png("Download PNG", "transp")
        s.page.get_by_label("Grid and axes").uncheck(); s.page.get_by_label("Floor shadow").uncheck()
        png("Download PNG", "transp-nogrid-noshadow")
        png("Download 4 views", "views-transp")
        s.page.locator(".hm-ex .seg button", has_text="Scene").first.click()
        s.page.get_by_label("Grid and axes").check()
        png("Download 4 views", "views")
        print("errors", s.errors())
