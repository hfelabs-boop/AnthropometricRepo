"""Round 5: human-export.css fails to load (offline / 404): the panel must still mount and work, with no horizontal scroll at 360 px."""
import importlib.util, json
from pathlib import Path
spec = importlib.util.spec_from_file_location("lib", Path(__file__).with_name("export.adversarial.lib.py")); lib = importlib.util.module_from_spec(spec); spec.loader.exec_module(lib)
def block(ctx): ctx.route("**/human-export.css*", lambda r: r.abort())
with lib.session(width=360, height=700, mobile=True, route=block) as s:
    p = s.page
    s.open()
    print("scrollW", s.js("document.documentElement.scrollWidth"), "innerW", s.js("innerWidth"))
    name, data = s.grab("Download BVH"); print(name, len(data))
    p.screenshot(path=str(lib.SCRATCH / "adv5-nocss-360.png"), full_page=False)
    print("errors", [e for e in s.errors()][:4])
