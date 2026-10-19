"""Screenshots of the Posture tab (light/dark, 1280x800 and 390x800) for looking at: python3 tests/human3d/editor.adversarial.shots.py [outdir]"""
import importlib.util
import sys
from pathlib import Path

spec = importlib.util.spec_from_file_location("lib", str(Path(__file__).with_name("editor.adversarial.lib.py")))
lib = importlib.util.module_from_spec(spec); spec.loader.exec_module(lib)
ED = lib.ED
out = Path(sys.argv[1]) if len(sys.argv) > 1 else lib.SCRATCH
out.mkdir(parents=True, exist_ok=True)
for name, w, h, dark, mobile in [("l1280", 1280, 800, False, False), ("d1280", 1280, 800, True, False), ("l390", 390, 800, False, True), ("d390", 390, 800, True, True)]:
    with lib.session(w, h, dark, mobile) as (page, logs, ctx):
        lib.open_posture(page)
        page.evaluate(f"{ED}.apply('sit-upright-90', {{animate:false}}); {ED}.setJoint('shoulder_R', 'flex', 60); {ED}.setJoint('elbow_R', 0, 80)")
        page.wait_for_timeout(1200)
        page.screenshot(path=str(out / f"shot-{name}-1.png"))
        for i, sel in enumerate([".hm-pe-sec-cur", ".hm-pe-sec-edit"]):
            page.evaluate("(s) => { const p = document.querySelector('.hm-panels') || document.scrollingElement; const e = document.querySelector(s); const pr = p.getBoundingClientRect(); p.scrollTop += e.getBoundingClientRect().top - pr.top - 4; }", sel)
            page.wait_for_timeout(500)
            page.screenshot(path=str(out / f"shot-{name}-{i + 2}.png"))
        sw = page.evaluate("[document.documentElement.scrollWidth, window.innerWidth, document.querySelector('.hm-panels')?.scrollWidth, document.querySelector('.hm-panels')?.clientWidth]")
        print(name, "scrollWidth/innerWidth/panels", sw, lib.errors(logs))
