"""Round 2: full-height element screenshots of the Scene and Measure panels at 390 and 360 px, light and dark, with a selected object and a selected measurement."""
import importlib.util, sys
from pathlib import Path
spec = importlib.util.spec_from_file_location("lib", Path(__file__).with_name("sandbox.adversarial.lib.py")); lib = importlib.util.module_from_spec(spec); spec.loader.exec_module(lib)
from shot import browser
OUT = Path(sys.argv[1]); OUT.mkdir(parents=True, exist_ok=True)
SETUP = """async () => {
  const sb = await %s, ms = await %s;
  sb.applyTemplate('office');
  const o = [...sb.objects.values()];
  sb.select(o.find(x => x.type === 'monitor').id);
  ms.addView({ kind: 'object', id: o.find(x => x.type==='monitor').id, anchor: 'screen_centre' });
  ms.addDistance({ kind: 'landmark', id: 'eye_mid' }, { kind: 'object', id: o.find(x => x.type==='keyboard_mouse').id, anchor: 'top_centre' });
  ms.addAngle({ kind: 'joint', id: 'shoulder_L' }, { kind: 'joint', id: 'elbow_L' }, { kind: 'joint', id: 'wrist_L' });
  ms.select(ms.items[0].id);
  sb.remove(o.find(x => x.type === 'keyboard_mouse').id); // leaves a grey measurement
}""" % (lib.SB, lib.MS)
for w, dark in [(390, False), (360, True)]:
    with browser(w, 800, dark, mobile=True) as (page, logs):
        lib.open_human(page, "scene")
        page.evaluate(SETUP); page.wait_for_timeout(1500)
        tag = f"{w}-{'dark' if dark else 'light'}"
        for sec in ("Templates", "Move, snap and gizmo", "Scene file"):
            page.click(f"summary:has-text('{sec}')"); page.wait_for_timeout(100)
        page.locator(".hm-sc").screenshot(path=str(OUT / f"scenepanel-{tag}.png"))
        page.click("#hm-tab-measure"); page.wait_for_timeout(900)
        for sec in ("Export",):
            page.click(f"summary:has-text('{sec}')"); page.wait_for_timeout(100)
        page.locator(".hm-ms").screenshot(path=str(OUT / f"measurepanel-{tag}.png"))
        print(tag, page.evaluate("[document.documentElement.scrollWidth, document.documentElement.clientWidth]"), [l for l in logs if l.startswith("[error]") or l.startswith("[pageerror]")][:3])
