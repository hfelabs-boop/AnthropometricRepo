"""Focus ring of the section summaries of the Export tab (keyboard focus via Tab), and the panel's first Tab stop."""
import importlib.util, json
from pathlib import Path
spec = importlib.util.spec_from_file_location("lib", Path(__file__).with_name("export.adversarial.lib.py")); lib = importlib.util.module_from_spec(spec); spec.loader.exec_module(lib)
with lib.session() as s:
    s.open(sections=False)
    p = s.page
    p.evaluate("document.querySelector('.hm-ex .hm-ex-intro').scrollIntoView()")
    p.keyboard.press("Tab")
    for i in range(14):
        info = p.evaluate("""() => { const e = document.activeElement; const cs = getComputedStyle(e); return { tag: e.tagName, txt: (e.textContent||'').trim().slice(0,30), outline: cs.outlineStyle + ' ' + cs.outlineWidth + ' ' + cs.outlineColor, shadow: cs.boxShadow.slice(0,60), fv: e.matches(':focus-visible'), inPanel: !!e.closest('.hm-ex') } }""")
        print(i, info)
        p.keyboard.press("Tab")
