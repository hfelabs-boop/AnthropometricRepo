import importlib.util
from pathlib import Path
spec = importlib.util.spec_from_file_location("lib", Path(__file__).with_name("sandbox.adversarial.lib.py")); lib = importlib.util.module_from_spec(spec); spec.loader.exec_module(lib)
from shot import browser
SB, MS = lib.SB, lib.MS
with browser(1280, 800) as (page, logs):
    lib.open_human(page, "scene")
    page.evaluate(f"""async () => {{ const sb = await {SB}; const cat = await import('/js/human/catalog.js'); const T = cat.CATALOG.map(t=>t.type);
       for (let i = 0; i < 200; i++) sb.add(T[i % T.length], {{ position: [(i % 14) * 1.5 - 9, 0, Math.floor(i / 14) * 1.5 + 1.5] }}); }}""")
    page.wait_for_timeout(1000)
    def t(label):
        r = page.evaluate(f"""async () => {{ const sb = await {SB}; const c = window.__human.ctx; const id = [...sb.objects.keys()][3];
          let t0 = performance.now(); for (let i = 0; i < 20; i++) c.emit('scene', {{ op: 'move', id, live: true }}); const emit = (performance.now() - t0) / 20;
          t0 = performance.now(); for (let i = 0; i < 20; i++) sb.move(id, {{ x: 0.01 * i }}, {{ snap: false }}); const mv = (performance.now() - t0) / 20;
          t0 = performance.now(); for (let i = 0; i < 20; i++) JSON.stringify([...sb.objects.values()].map(o => ({{ ...o.params }}))); const js = (performance.now() - t0) / 20;
          return {{ emit, move: mv, stringify: js }}; }}""")
        print(label, {k: round(v, 2) for k, v in r.items()})
    t("200 objects, Scene tab only mounted")
    page.click("#hm-tab-measure"); page.wait_for_timeout(800); page.click("#hm-tab-scene"); page.wait_for_timeout(500)
    t("200 objects, Measure panel mounted too (hidden)")
    page.click("#hm-tab-measure"); page.wait_for_timeout(500)
    page.select_option("#hm-ms-kind-1, .hm-ms select", "view"); page.wait_for_timeout(300) 
    page.click("#hm-tab-scene"); page.wait_for_timeout(500)
    t("view form selected")
