"""Screenshots of the Scene and Measure panels (light / dark, 1280x800 and 390x800) with a populated scene."""
import importlib.util, sys
from pathlib import Path
spec = importlib.util.spec_from_file_location("lib", Path(__file__).with_name("sandbox.adversarial.lib.py")); lib = importlib.util.module_from_spec(spec); spec.loader.exec_module(lib)
from shot import browser

SETUP = """async () => {
  const sb = await %s, ms = await %s;
  sb.applyTemplate('cockpit');
  const o = [...sb.objects.values()];
  sb.select(o[0].id);
  ms.addView({ kind: 'object', id: o.find(x => x.type==='triple_monitor').id, anchor: 'screen_centre' });
  ms.addDistance({ kind: 'landmark', id: 'eye_mid' }, { kind: 'object', id: o.find(x => x.type==='hud_panel').id, anchor: 'glass_centre' });
  ms.addHeight({ kind: 'landmark', id: 'vertex' });
  ms.addAngle({ kind: 'joint', id: 'shoulder_L' }, { kind: 'joint', id: 'elbow_L' }, { kind: 'joint', id: 'wrist_L' });
  ms.select(ms.items[1].id);
  sb.frameObjects(null);
  return o.map(x => x.id);
}""" % (lib.SB, lib.MS)

for (w, h) in [(1280, 800), (390, 800)]:
    for dark in (False, True):
        with browser(w, h, dark, mobile=(w < 500)) as (page, logs):
            lib.open_human(page, "scene")
            page.evaluate(SETUP)
            page.wait_for_timeout(1500)
            tag = f"{w}-{'dark' if dark else 'light'}"
            page.screenshot(path=str(lib.OUT / f"scene-{tag}.png"))
            page.click("#hm-tab-measure"); page.wait_for_timeout(900)
            page.screenshot(path=str(lib.OUT / f"measure-{tag}.png"))
            if w < 500:
                page.screenshot(path=str(lib.OUT / f"measure-{tag}-full.png"), full_page=True)
            sw = page.evaluate("[document.documentElement.scrollWidth, document.documentElement.clientWidth]")
            print(tag, "scrollWidth/clientWidth", sw, [l for l in logs if l.startswith("[error]") or l.startswith("[pageerror]")][:5])
