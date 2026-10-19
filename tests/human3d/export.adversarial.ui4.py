"""Tables card at 360 px: is the 'Joint centres and landmarks' row legible (the element screenshot of ui2 showed a clipped row)?"""
import importlib.util
from pathlib import Path
spec = importlib.util.spec_from_file_location("lib", Path(__file__).with_name("export.adversarial.lib.py")); lib = importlib.util.module_from_spec(spec); spec.loader.exec_module(lib)
with lib.session(width=360, height=700, mobile=True, dark=True) as s:
    s.open()
    row = s.page.locator(".hm-ex-row").first
    row.scroll_into_view_if_needed()
    s.page.wait_for_timeout(300)
    print(s.js("(() => { const r = document.querySelector('.hm-ex-row'); const b = r.getBoundingClientRect(); const nav = document.querySelector('header, .site-header, nav'); return { row: [b.top, b.bottom, b.height], text: r.innerText.slice(0, 120), navPos: nav && getComputedStyle(nav).position, navBottom: nav && nav.getBoundingClientRect().bottom }; })()"))
    s.page.screenshot(path=str(lib.SCRATCH / "adv-ui4-tables.png"))
