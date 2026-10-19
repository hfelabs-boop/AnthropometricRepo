"""Round 3: extreme values in the numeric fields of the Scene inspector (position, yaw), in mm and in inches (type=number sanitises most text, so only valid numeric syntax gets through)."""
import importlib.util
from pathlib import Path
spec = importlib.util.spec_from_file_location("lib", Path(__file__).with_name("sandbox.adversarial.lib.py")); lib = importlib.util.module_from_spec(spec); spec.loader.exec_module(lib)
from shot import browser
SB = lib.SB
VALUES = ["1e999", "1e308", "-1e308", "1e-400", "99999999999999999999", "-0", "0.0000001", "5e2", "1e6", "-5", "12.5"]
SET = """(a) => { const i = document.querySelector(`input[aria-label^="${a.label}"]`); if (!i) return 'nofield'; i.value = a.v; i.dispatchEvent(new Event('input', {bubbles: true})); i.dispatchEvent(new Event('change', {bubbles: true})); return i.value; }"""
with browser(1280, 800) as (page, logs):
    lib.open_human(page, "scene")
    page.evaluate(f"async () => {{ const sb = await {SB}; sb.add('box', {{ position: [0.5, 0, 1.0] }}); sb.select('o1'); }}")
    page.wait_for_timeout(1200)
    for unit in ("mm", "in"):
        page.evaluate(f"window.__human.ctx.setUnits('{unit}')"); page.wait_for_timeout(300)
        for label in ("X position", "Z position", "Y (up) position", "Yaw"):
            for v in VALUES:
                page.evaluate(f"async () => (await {SB}).move('o1', [0.5, 0, 1.0])")
                page.wait_for_timeout(30)
                r = page.evaluate(SET, {"label": label, "v": v}); page.wait_for_timeout(60)
                o = page.evaluate(f"async () => {{ const o = (await {SB}).objects.get('o1'); return {{ p: o.position, yaw: o.yaw }}; }}")
                bad = any((c != c) or abs(c) > 1001 for c in o["p"]) or abs(o["yaw"]) > 360
                shown = page.evaluate(f"document.querySelector('input[aria-label^=\"{label}\"]')?.value")
                if bad or r == "nofield" or (v in ("1e999", "-1e308") and label in ("X position", "Yaw")):
                    print(f"{unit} {label} <- {v!r}: field {r!r}, object {o}, field now {shown!r} {'<<<<< BAD' if bad else ''}")
    print("errors:", [l for l in logs if l.startswith("[error]") or l.startswith("[pageerror]")])
