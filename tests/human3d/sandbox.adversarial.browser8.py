import importlib.util
from pathlib import Path
spec = importlib.util.spec_from_file_location("lib", Path(__file__).with_name("sandbox.adversarial.lib.py")); lib = importlib.util.module_from_spec(spec); spec.loader.exec_module(lib)
from shot import browser
SB, MS = lib.SB, lib.MS
for dark in (False, True):
  for w in (390, 360):
    with browser(w, 800, dark, mobile=True) as (page, logs):
        lib.open_human(page, "scene")
        page.evaluate(f"""async () => {{ const sb = await {SB}; sb.applyTemplate('office'); sb.select(sb.objects.keys().next().value); sb.select([...sb.objects.keys()][2]); }}""")
        page.wait_for_timeout(1200)
        tag = f"{w}-{'dark' if dark else 'light'}"
        # open all sections
        page.evaluate("document.querySelectorAll('.hm-sc details, .hm-ms details').forEach(d => d.open = true)")
        page.wait_for_timeout(600)
        page.screenshot(path=str(lib.OUT / f"mob-scene-{tag}.png"), full_page=True)
        over = page.evaluate("""() => { const out = []; const W = document.documentElement.clientWidth; document.querySelectorAll('.hm-sc *, .hm-ms *').forEach(e => { const r = e.getBoundingClientRect(); if (r.width && (r.right > W + 1 || r.left < -1)) out.push(e.tagName + '.' + e.className + ' ' + Math.round(r.left) + '..' + Math.round(r.right)); }); return out.slice(0, 12); }""")
        print(tag, "scrollW", page.evaluate("document.documentElement.scrollWidth"), "overflowing:", over)
        page.click("#hm-tab-measure"); page.wait_for_timeout(500)
        page.evaluate("document.querySelectorAll('.hm-sc details, .hm-ms details').forEach(d => d.open = true)")
        page.evaluate(f"""async () => {{ const ms = await {MS}; ms.addDistance({{kind:'landmark',id:'eye_mid'}}, {{kind:'object',id:'o3',anchor:'screen_centre'}}); ms.addView({{kind:'object',id:'o3',anchor:'screen_centre'}}); }}""")
        page.wait_for_timeout(600)
        page.screenshot(path=str(lib.OUT / f"mob-measure-{tag}.png"), full_page=True)
        over = page.evaluate("""() => { const out = []; const W = document.documentElement.clientWidth; document.querySelectorAll('.hm-sc *, .hm-ms *').forEach(e => { const r = e.getBoundingClientRect(); if (r.width && (r.right > W + 1 || r.left < -1)) out.push(e.tagName + '.' + e.className + ' ' + Math.round(r.left) + '..' + Math.round(r.right)); }); return out.slice(0, 12); }""")
        print(tag, "measure scrollW", page.evaluate("document.documentElement.scrollWidth"), "overflowing:", over)
