"""Rapid clicks, URL.revokeObjectURL, keyboard, busy state, console errors, layout at 360 px, dark theme of the Export tab (real site, headless Chromium)."""
import importlib.util, json, sys, time
from pathlib import Path
spec = importlib.util.spec_from_file_location("lib", Path(__file__).with_name("export.adversarial.lib.py")); lib = importlib.util.module_from_spec(spec); spec.loader.exec_module(lib)
SHOTS = lib.SCRATCH

HOOK = """() => { window.__urls = { made: [], revoked: [] }; const c = URL.createObjectURL.bind(URL), r = URL.revokeObjectURL.bind(URL);
  URL.createObjectURL = (b) => { const u = c(b); window.__urls.made.push([u, b.size, b.type]); return u; }; URL.revokeObjectURL = (u) => { window.__urls.revoked.push(u); return r(u); };
  window.__clicks = []; const oc = HTMLAnchorElement.prototype.click; HTMLAnchorElement.prototype.click = function () { window.__clicks.push(this.download); return oc.call(this); }; }"""

with lib.session() as s:
    p = s.page
    s.open()
    s.js(HOOK)
    # --- rapid clicks on one button: how many downloads?
    downloads = []
    p.on("download", lambda d: downloads.append(d.suggested_filename))
    btn = s.button("Download GLB")
    for _ in range(6):
        btn.click(force=True, no_wait_after=True)
    s.idle(); p.wait_for_timeout(1500)
    print("6 rapid clicks on Download GLB -> downloads:", len(downloads), downloads)
    # --- a click on a second button while the first is busy
    downloads.clear()
    s.button("Download OBJ").click(no_wait_after=True)
    s.button("Download STL").click(force=True, no_wait_after=True)
    s.button("Download Joint angles as CSV").click(force=True, no_wait_after=True)
    s.idle(); p.wait_for_timeout(1500)
    print("OBJ then STL, CSV while busy ->", downloads)
    # --- revoke
    p.wait_for_timeout(2600)
    u = s.js("window.__urls")
    print("object URLs made", len(u["made"]), "revoked", len(u["revoked"]), "sizes", [m[1] for m in u["made"]])
    # --- focus during busy: does keyboard focus stay on the button?
    s.button("Download BVH").focus()
    p.keyboard.press("Enter")
    p.wait_for_timeout(50)
    print("focused element during/after BVH:", s.js("document.activeElement?.textContent?.trim().slice(0,30) + ' / ' + document.activeElement?.tagName"))
    s.idle(); p.wait_for_timeout(800)
    print("focused after:", s.js("document.activeElement?.textContent?.trim().slice(0,30)"))
    print("status line:", p.locator(".hm-ex-last").inner_text())
    # --- keyboard only: tab through all focusable elements of the panel, report the ones without visible focus style or an accessible name
    s.js("document.activeElement.blur()")
    names = s.js("""() => [...document.querySelectorAll('.hm-ex button, .hm-ex input, .hm-ex select, .hm-ex summary, .hm-ex pre')].map((e) => {
      const lab = e.getAttribute('aria-label') || e.textContent.trim() || (e.labels && e.labels[0]?.textContent.trim()) || e.title || '';
      return [e.tagName, lab.slice(0, 40), e.disabled, e.offsetParent !== null, getComputedStyle(e).outlineStyle]; })""")
    nameless = [n for n in names if not n[1] and n[3]]
    print("controls:", len(names), "without a name:", nameless)
    print("console errors:", s.errors())
    p.screenshot(path=str(SHOTS / "adv-ui1-desktop.png"))
