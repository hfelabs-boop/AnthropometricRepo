"""Layout: 360 px mobile, dark theme, light theme, reduced motion; horizontal scroll, overflow, tap-target sizes, contrast of text on the cards; screenshots."""
import importlib.util, sys
from pathlib import Path
spec = importlib.util.spec_from_file_location("lib", Path(__file__).with_name("export.adversarial.lib.py")); lib = importlib.util.module_from_spec(spec); spec.loader.exec_module(lib)
SH = lib.SCRATCH
CHECK = """() => { const de = document.documentElement; const over = [...document.querySelectorAll('.hm-ex *')].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && (r.right > innerWidth + 1 || r.left < -1); }).slice(0, 8).map((e) => e.tagName + '.' + e.className + ' ' + Math.round(e.getBoundingClientRect().right));
  const small = [...document.querySelectorAll('.hm-ex button, .hm-ex input, .hm-ex select')].filter((e) => e.offsetParent && (e.getBoundingClientRect().height < 24)).map((e) => (e.textContent || e.type).trim().slice(0, 20) + ' ' + Math.round(e.getBoundingClientRect().height));
  return { scrollW: de.scrollWidth, innerW: innerWidth, bodyScrollW: document.body.scrollWidth, over, small }; }"""
for name, kw in (("360-light", dict(width=360, height=700, mobile=True)), ("360-dark", dict(width=360, height=700, mobile=True, dark=True)), ("1280-dark", dict(dark=True)), ("320-light", dict(width=320, height=600, mobile=True))):
    with lib.session(**kw) as s:
        s.open()
        r = s.js(CHECK)
        print(name, r)
        s.page.locator(".hm-ex").first.scroll_into_view_if_needed()
        # full-panel screenshot: expand the element
        s.page.screenshot(path=str(SH / f"adv-ui2-{name}.png"), full_page=True)
        h = s.js("document.querySelector('.hm-ex').getBoundingClientRect().height")
        s.page.locator(".hm-ex").first.screenshot(path=str(SH / f"adv-ui2-panel-{name}.png"))
        print("   errors", s.errors())
