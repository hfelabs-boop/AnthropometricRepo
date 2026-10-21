import importlib.util
from pathlib import Path
spec = importlib.util.spec_from_file_location("lib", Path(__file__).with_name("sandbox.adversarial.lib.py")); lib = importlib.util.module_from_spec(spec); spec.loader.exec_module(lib)
from shot import browser
SB, MS = lib.SB, lib.MS
with browser(1280, 800) as (page, logs):
    lib.open_human(page, "scene")
    page.click("#hm-tab-measure"); page.wait_for_timeout(500)
    r = page.evaluate(f"""async () => {{ const sb = await {SB}, ms = await {MS}; const cat = await import('/js/human/catalog.js'); const T = cat.CATALOG.map(t=>t.type);
      for (let i = 0; i < 60; i++) sb.add(T[i % T.length], {{ position: [(i % 10) * 1.2 - 5, 0, Math.floor(i / 10) * 1.2 + 1.5] }});
      const ids = [...sb.objects.keys()];
      for (let i = 0; i < 200; i++) ms.addDistance({{ kind: 'landmark', id: 'eye_mid' }}, {{ kind: 'object', id: ids[i % ids.length], local: [0, 0.1, 0] }}, {{ label: 'M' + i }});
      ms.flush();
      const vp = window.__human.viewport;
      let t0 = performance.now(); for (let i = 0; i < 10; i++) {{ vp.requestRender(); vp.renderNow(); }} const frame = (performance.now() - t0) / 10;
      t0 = performance.now(); for (let i = 0; i < 10; i++) ms.flush(); const flush = (performance.now() - t0) / 10;
      t0 = performance.now(); ms.toCSV(); ms.toResultsJSON(); const exp = performance.now() - t0;
      return {{ frame, flush, exp, items: ms.items.length, root: ms.root.children.length }}; }}""")
    print({k: round(v, 1) for k, v in r.items()})
    page.wait_for_timeout(800)
    t = page.evaluate("() => { const t0 = performance.now(); document.querySelectorAll('.hm-ms-item').length; return document.querySelectorAll('.hm-ms-item').length; }")
    print("rows in DOM", t)
    page.screenshot(path=str(lib.OUT / "measure-200.png"))
    print("errors:", [l for l in logs if l.startswith('[error]') or l.startswith('[pageerror]')])
