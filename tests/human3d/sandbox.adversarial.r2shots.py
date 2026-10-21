"""Round 2 screenshots: Scene and Measure panels, light/dark, 1280x800 and 390x800, with a populated scene and crowded measurement labels. Output: argv[1]."""
import importlib.util, sys
from pathlib import Path
spec = importlib.util.spec_from_file_location("lib", Path(__file__).with_name("sandbox.adversarial.lib.py")); lib = importlib.util.module_from_spec(spec); spec.loader.exec_module(lib)
from shot import browser
OUT = Path(sys.argv[1]); OUT.mkdir(parents=True, exist_ok=True)
SETUP = """async () => {
  const sb = await %s, ms = await %s;
  sb.applyTemplate('cockpit');
  const o = [...sb.objects.values()];
  sb.add('crate', { position: [0.8, 0, 0.6], params: { mass: 25 } });
  sb.setShowNames(true);
  sb.select(o[0].id);
  const lm = (id) => ({ kind: 'landmark', id });
  ms.addView({ kind: 'object', id: o.find(x => x.type==='triple_monitor').id, anchor: 'screen_centre' });
  ms.addDistance(lm('eye_mid'), { kind: 'object', id: o.find(x => x.type==='hud_panel').id, anchor: 'glass_centre' });
  ms.addHeight(lm('vertex'));
  ms.addAngle({ kind: 'joint', id: 'shoulder_L' }, { kind: 'joint', id: 'elbow_L' }, { kind: 'joint', id: 'wrist_L' });
  // crowded: five measurements between nearly the same points
  for (const id of ['palm_centre_L','palm_centre_R','grip_centre_L','grip_centre_R','wrist_L'.replace('wrist_L','palm_centre_L')]) ms.addDistance(lm(id), lm('eye_mid'));
  for (const id of ['vertex','eye_mid','suprasternale']) ms.addHeight(lm(id));
  ms.select(ms.items[1].id);
  sb.frameObjects(null);
}""" % (lib.SB, lib.MS)
for (w, h) in [(1280, 800), (390, 800)]:
    for dark in (False, True):
        with browser(w, h, dark, mobile=(w < 500)) as (page, logs):
            lib.open_human(page, "scene")
            page.evaluate(SETUP)
            page.wait_for_timeout(1800)
            tag = f"{w}-{'dark' if dark else 'light'}"
            page.screenshot(path=str(OUT / f"scene-{tag}.png"))
            page.click("#hm-tab-measure"); page.wait_for_timeout(1000)
            page.screenshot(path=str(OUT / f"measure-{tag}.png"))
            sw = page.evaluate("[document.documentElement.scrollWidth, document.documentElement.clientWidth]")
            print(tag, "scrollWidth/clientWidth", sw, [l for l in logs if l.startswith("[error]") or l.startswith("[pageerror]")][:5])
