"""Round 5: keyboard: Tab through every control of the Export tab (all sections open), is the focus ring visible, in what order, is the focused control in view; Enter/Space on seg buttons and checkboxes;
reduced motion (spinner); busy cursor; aria-busy; live regions."""
import importlib.util, json
from pathlib import Path
spec = importlib.util.spec_from_file_location("lib", Path(__file__).with_name("export.adversarial.lib.py")); lib = importlib.util.module_from_spec(spec); spec.loader.exec_module(lib)
for dark in (False, True):
    with lib.session(dark=dark, width=420, height=800, reduced=True) as s:
        p = s.page
        s.open()
        s.js("document.activeElement.blur(); document.querySelector('.hm-ex').scrollIntoView()")
        s.js("() => { const first = document.querySelector('.hm-ex button, .hm-ex summary'); first.focus(); }")
        seen = []; bad = []
        for i in range(120):
            info = s.js("""() => { const e = document.activeElement; if (!e || !e.closest('.hm-ex')) return null; const cs = getComputedStyle(e); const r = e.getBoundingClientRect();
              const ring = (cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0) || (cs.boxShadow && cs.boxShadow !== 'none');
              return { tag: e.tagName, text: (e.getAttribute('aria-label') || e.textContent || e.value || '').trim().slice(0, 28), ring, outline: cs.outlineStyle + ' ' + cs.outlineWidth + ' ' + cs.outlineColor, shadow: cs.boxShadow.slice(0, 40), type: e.type || '', inView: r.top >= 0 && r.bottom <= innerHeight + 1 }; }""")
            if info is None: break
            seen.append(info)
            if not info["ring"]: bad.append(info)
            p.keyboard.press("Tab")
        print("dark" if dark else "light", "focus stops:", len(seen), "without ring:", [(b["tag"], b["text"], b["type"]) for b in bad][:12])
        print("   not in view after focus:", [(b["tag"], b["text"]) for b in seen if not b["inView"]][:6])
        # spinner under reduced motion
        s.button("Download BVH").click(no_wait_after=True)
        p.wait_for_timeout(5)
        print("   spinner animation under reduced motion:", s.js("() => { const e = document.querySelector('.hm-ex-busy .spinner'); return e ? getComputedStyle(e).animationName + ' ' + getComputedStyle(e).animationDuration : 'none' }"))
        s.idle()
        # Space on a checkbox and on a seg button
        cb = p.get_by_label("Add a second frame with the neutral standing pose")
        cb.focus(); p.keyboard.press("Space"); print("   checkbox after Space:", cb.is_checked())
        seg = p.locator(".hm-ex .seg button", has_text="mm").first
        seg.focus(); p.keyboard.press("Enter"); print("   seg aria-pressed/checked after Enter:", seg.get_attribute("aria-pressed"), seg.get_attribute("aria-checked"), seg.get_attribute("role"))
        print("   errors", s.errors())
