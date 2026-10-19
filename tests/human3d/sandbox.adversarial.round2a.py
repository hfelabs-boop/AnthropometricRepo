"""Round 2 probes A: display units in the Scene panel fields and sliders (in / cm), theme change of the selection outline, tab-switch interaction rules."""
import importlib.util, json
from pathlib import Path
spec = importlib.util.spec_from_file_location("lib", Path(__file__).with_name("sandbox.adversarial.lib.py")); lib = importlib.util.module_from_spec(spec); spec.loader.exec_module(lib)
from shot import browser
SB, MS = lib.SB, lib.MS

with browser(1280, 800) as (page, logs):
    lib.open_human(page, "scene")
    page.evaluate(f"async () => {{ const sb = await {SB}; sb.add('desk', {{ position: [0, 0, 1.2], select: true }}); }}")
    page.wait_for_timeout(500)
    for unit in ["in", "cm", "mm"]:
        page.evaluate(f"window.__human.ctx.setUnits('{unit}')"); page.wait_for_timeout(400)
        # type X = 10 (display unit) -> metres
        f = page.locator(".hm-ed input[type=number]").first
        f.fill("10"); f.dispatch_event("change"); page.wait_for_timeout(200)
        pos = page.evaluate(f"async () => (await {SB}).objects.get((await {SB}).selected).position")
        want = {"in": 0.254, "cm": 0.10, "mm": 0.010}[unit]
        print(unit, "typed 10 ->", pos[0], "expected", want, "OK" if abs(pos[0] - want) < 1e-6 else "MISMATCH")
        shown = f.input_value()
        print("   field shows", shown)
        # slider: set the desk height field to a value
        sl = page.locator(".hm-ed .hm-slider-ctl").first
        print("   first slider ctl text:", sl.inner_text()[:80].replace("\n", " | "))
    # width param via the numeric box of the slider row
    page.evaluate("window.__human.ctx.setUnits('in')"); page.wait_for_timeout(400)
    rows = page.locator(".hm-ed .hm-slider-row, .hm-ed .slider-row")
    print("slider rows:", rows.count())
    html = page.evaluate("document.querySelector('.hm-ed .hm-slider-ctl')?.parentElement?.outerHTML.slice(0,600)")
    print(html)
    # theme: outline colour follows
    c0 = page.evaluate(f"async () => {{ const sb = await {SB}; const o = sb.objects.get(sb.selected); return o._outline.material.color.getHexString(); }}")
    page.emulate_media(color_scheme="dark"); page.wait_for_timeout(600)
    c1 = page.evaluate(f"async () => {{ const sb = await {SB}; const o = sb.objects.get(sb.selected); return o._outline.material.color.getHexString(); }}")
    th = page.evaluate("document.documentElement.dataset.theme || getComputedStyle(document.documentElement).getPropertyValue('--accent')")
    print("outline colour light/dark:", c0, c1, "theme attr/accent:", th)
    print("errors:", [l for l in logs if l.startswith("[error]") or l.startswith("[pageerror]")])
