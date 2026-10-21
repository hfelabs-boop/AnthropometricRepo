"""Round 5: API data unavailable (profile fetch aborted -> fallback body), localStorage throwing / corrupt options; every download still works and validates."""
import importlib.util, json
from pathlib import Path
spec = importlib.util.spec_from_file_location("lib", Path(__file__).with_name("export.adversarial.lib.py")); lib = importlib.util.module_from_spec(spec); spec.loader.exec_module(lib)

def block(ctx):
    ctx.route("**/api/v1/**", lambda r: r.abort())
with lib.session(route=block) as s:
    p = s.page
    s.open()
    print("state:", p.locator(".hm-ex-state").inner_text().replace("\n", " | "))
    print("profile in shell:", s.js("() => { const st = window.__human.ctx.state; return JSON.stringify({ profile: st.profile && { id: st.profile.id, label: st.profile.label }, notices: st.notices }) }"))
    for btn in ["Download GLB", "Download OBJ", "Download STL", "Download BVH", "Download JSON", "Download posture file"]:
        try:
            name, data = s.grab(btn, timeout=60000); s.idle()
            extra = ""
            if btn == "Download JSON":
                doc = json.loads(data); extra = f"label={doc['profile']['label']!r} id={doc['profile']['id']!r} sex={doc['profile']['sex']} measures={list(doc['profile']['measures'])[:4]} source={doc['profile']['source']}"
            print(f"{btn:22s} {name} {len(data)} {extra}")
        except Exception as e:  # noqa: BLE001
            print(btn, "FAILED", str(e)[:150], "| msgs:", p.locator(".hm-ex-msgs").inner_text()[:200])
    print("errors", [e for e in s.errors() if "ERR_FAILED" not in e][:5])

init = """Object.defineProperty(window, 'localStorage', { get() { throw new Error('SecurityError: denied'); } });"""
def deny(ctx): ctx.add_init_script(init)
with lib.session(route=deny) as s:
    p = s.page
    s.open()
    name, data = s.grab("Download OBJ"); s.idle()
    p.get_by_label("Add a second frame with the neutral standing pose").check()
    name2, data2 = s.grab("Download BVH"); s.idle()
    print("no localStorage:", name, len(data), name2, "frames:", data2.decode().split("Frames:")[1].split()[0], "| errors", [e for e in s.errors()][:3])

def corrupt(ctx): ctx.add_init_script("localStorage.setItem('hm-export-opts', JSON.stringify({ glbFigure: 'none', glbPose: 'x', meshUnit: 'in', meshAxes: '__proto__', bvhUnit: 12, imgScale: '2', glbScene: 'yes', csvHeader: null }))")
with lib.session(route=corrupt) as s:
    s.open()
    print("corrupt prefs: GLB figure seg =", s.js("() => [...document.querySelectorAll('.hm-ex .hm-ex-field')].slice(0,2).map(f => f.innerText.replace(/\\n/g,' ') + ' => ' + [...f.querySelectorAll('button')].filter(b => b.getAttribute('aria-pressed')==='true').map(b=>b.textContent)).join(' ## ')"))
    try:
        name, data = s.grab("Download GLB"); print("   GLB with stored 'none' + no scene:", name, len(data))
    except Exception as e:  # noqa: BLE001
        print("   GLB:", str(e)[:100], "|", s.page.locator(".hm-ex-msgs").inner_text()[:200])
    print("   errors", s.errors()[:3])
