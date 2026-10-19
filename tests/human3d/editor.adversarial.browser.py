"""ADVERSARIAL browser checks of the Posture tab (panels/posture.js, editor.js) on the real site: real mouse and touch events, hostile storage, a 4 x library, keyboard and
accessibility walks, leaks. Independent of test_posture_panel.py.

    python3 tests/human3d/editor.adversarial.browser.py [session ...]       sessions: drag touch storage library a11y   (default: all; each starts its own Chromium, ~1 to 2 minutes)

Prints one line per check: PASS, FAIL, or DEFECT (a confirmed defect: the check asserts what a user needs and is known to fail; it says FIXED when it starts to pass).
Exit code 1 when a check that is not a known DEFECT fails. Screenshots of the panel in light and dark at 1280x800 and 390x800: editor.adversarial.shots.py.
"""
import importlib.util
import json
import re
import sys
from pathlib import Path

spec = importlib.util.spec_from_file_location("lib", str(Path(__file__).with_name("editor.adversarial.lib.py")))
lib = importlib.util.module_from_spec(spec)
spec.loader.exec_module(lib)
ED, RIG = lib.ED, lib.RIG
RESULTS = []


def check(name, ok, detail="", defect=False):
    status = ("FIXED" if ok else "DEFECT") if defect else ("PASS" if ok else "FAIL")
    RESULTS.append((status, name))
    print(f"{status:6} {name}" + (f"  [{detail}]" if detail and status != "PASS" else ""))
    sys.stdout.flush()


def state(page):
    return page.evaluate(f"({{ dragging: {ED}.dragging, layer: {ED}.handleLayer.dragging, orbit: window.__human.viewport.controls.enabled, hist: {ED}.history, pose: {RIG}.getPose() }})")


def pdist(a, b):
    return max((abs(x - b["angles"][k][i]) for k, v in a["angles"].items() for i, x in enumerate(v)), default=0)


def px(a, b):
    return ((a["x"] - b[0]) ** 2 + (a["y"] - b[1]) ** 2) ** 0.5


def fresh(page, posture="iso-7250-standing"):
    page.evaluate(f"{ED}.apply('{posture}', {{animate:false}})")
    page.wait_for_timeout(300)


# ------------------------------------------------------------------------------------------------------------------------------------------------ drag
def session_drag():
    with lib.session() as (page, logs, ctx):
        lib.open_posture(page)
        m = page.mouse
        fresh(page)
        h = lib.handle_xy(page, "palm_R")
        # a quick flick, then the pointer rests with the button down
        m.move(h["x"], h["y"]); m.down()
        for i in range(1, 4):
            m.move(h["x"] + 40 * i, h["y"] - 70 * i)
        page.wait_for_timeout(3000)
        hh = lib.handle_xy(page, "palm_R")
        d = px(hh, (h["x"] + 120, h["y"] - 210))
        m.up(); page.wait_for_timeout(500)
        check("a flick then a pause with the button down: the handle goes on toward the pointer", d < 40, f"{d:.0f} px short after 3 s", defect=True)

        fresh(page); s0 = state(page); h = lib.handle_xy(page, "palm_R")
        m.move(h["x"], h["y"]); m.down()
        for i in range(1, 9):
            m.move(h["x"] - 25 * i, h["y"] - 8 * i); page.wait_for_timeout(40)
        m.move(100, 400); page.wait_for_timeout(100); m.up(); page.wait_for_timeout(400)
        s = state(page)
        check("released over the left panel: the drag ends, one history step, orbit controls back", not s["dragging"] and not s["layer"] and s["orbit"] and s["hist"]["undoLabel"] == "Move right hand" and s["hist"]["steps"] == s0["hist"]["steps"] + 1)

        fresh(page); h = lib.handle_xy(page, "palm_R")
        m.move(h["x"], h["y"]); m.down()
        for i in range(1, 6):
            m.move(h["x"] + 10 * i, h["y"] - 10 * i); page.wait_for_timeout(40)
        m.move(-30, -30); page.wait_for_timeout(100); m.up(); page.wait_for_timeout(400)
        s = state(page)
        check("released outside the page: the drag ends", not s["dragging"] and not s["layer"] and s["orbit"])

        # a pointerup that never arrives (window lost the focus, a dialog took the button): the next moves without a button must not drag
        fresh(page); h = lib.handle_xy(page, "palm_R")
        page.evaluate("window.__swallow = (e) => e.stopImmediatePropagation(); window.addEventListener('pointerup', window.__swallow, true);")
        m.move(h["x"], h["y"]); m.down()
        for i in range(1, 6):
            m.move(h["x"] + 10 * i, h["y"] - 10 * i); page.wait_for_timeout(40)
        m.up(); page.wait_for_timeout(200)
        page.evaluate("window.removeEventListener('pointerup', window.__swallow, true)")
        p0 = state(page)["pose"]
        for i in range(1, 8):
            m.move(h["x"] + 50 + 15 * i, h["y"] - 50 + 5 * i); page.wait_for_timeout(50)
        page.wait_for_timeout(300)
        p1 = state(page)
        check("a lost pointerup: moving the mouse with no button pressed does not keep dragging the handle", not p1["dragging"] and pdist(p0, p1["pose"]) < 1, f"dragging={p1['dragging']}, pose moved {pdist(p0, p1['pose']):.0f} deg, orbit controls {'on' if p1['orbit'] else 'OFF'}", defect=True)
        m.down(); m.up(); page.wait_for_timeout(300)

        # pointercancel puts everything back
        fresh(page); h = lib.handle_xy(page, "palm_R"); before = state(page)["pose"]
        m.move(h["x"], h["y"]); m.down()
        for i in range(1, 8):
            m.move(h["x"] + 10 * i, h["y"] - 14 * i); page.wait_for_timeout(40)
        page.wait_for_timeout(300)
        page.evaluate("window.__human.viewport.canvas.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 1, bubbles: true }))"); page.wait_for_timeout(300)
        s = state(page); m.up()
        check("pointercancel: the figure is exactly as before, no history step, orbit back", pdist(before, s["pose"]) == 0 and not s["dragging"] and s["orbit"])

        # Escape
        fresh(page); h = lib.handle_xy(page, "palm_R"); before = state(page)["pose"]; steps = state(page)["hist"]["steps"]
        m.move(h["x"], h["y"]); m.down()
        for i in range(1, 6):
            m.move(h["x"] + 10 * i, h["y"] - 14 * i); page.wait_for_timeout(40)
        page.keyboard.press("Escape"); page.wait_for_timeout(300); m.up(); page.wait_for_timeout(300)
        s = state(page)
        check("Escape during a drag cancels it", pdist(before, s["pose"]) == 0 and s["hist"]["steps"] == steps and not s["dragging"])

        # the tab is left in the middle of a drag
        fresh(page); h = lib.handle_xy(page, "palm_R")
        m.move(h["x"], h["y"]); m.down()
        for i in range(1, 7):
            m.move(h["x"] + 8 * i, h["y"] - 12 * i); page.wait_for_timeout(40)
        page.evaluate("[...document.querySelectorAll('[role=tab]')].find(t => t.textContent.trim() === 'Scene').click()"); page.wait_for_timeout(500)
        s = state(page); m.up(); page.wait_for_timeout(300)
        check("switching to another tab in the middle of a drag cancels it and frees the orbit controls", not s["dragging"] and not s["layer"] and s["orbit"])
        page.evaluate("[...document.querySelectorAll('[role=tab]')].find(t => t.textContent.trim() === 'Posture').click()"); page.wait_for_timeout(500)

        # a new profile in the middle of a drag
        fresh(page); h = lib.handle_xy(page, "palm_R")
        m.move(h["x"], h["y"]); m.down()
        for i in range(1, 7):
            m.move(h["x"] + 8 * i, h["y"] - 12 * i); page.wait_for_timeout(40)
        stature = page.evaluate("window.__human.ctx.getBody().stature")
        page.evaluate("""async (k) => { const c = window.__human.ctx, p = JSON.parse(JSON.stringify(c.getProfile())); p.id += ':scaled'; for (const v of Object.values(p.measures)) if (v.unit === 'mm') v.value *= k; await c.setProfile(p, { immediate: true }); }""", 0.9)
        page.wait_for_function("(s) => window.__human.ctx.getBody() && window.__human.ctx.getBody().stature < s - 0.05", arg=stature, timeout=60000)
        page.wait_for_timeout(600)
        s = state(page)
        for i in range(7, 10):
            m.move(h["x"] + 8 * i, h["y"] - 12 * i); page.wait_for_timeout(60)
        m.up(); page.wait_for_timeout(500)
        s2 = state(page)
        info = page.evaluate(f"{ED}.info()")
        check("a new profile in the middle of a drag: the engine drag is cancelled, the figure is grounded on the new body, the handle layer is free after the release",
              not s["dragging"] and abs(info["gaps"]["feet"]) < 1e-6 and not s2["layer"] and s2["orbit"], f"engine dragging={s['dragging']} layer after release={s2['layer']}")
        check("... and the layer stops saying 'dragging' as soon as the engine cancels (the orbit controls stay held until the button is released)", not s["layer"] and s["orbit"], f"layer={s['layer']} orbit={s['orbit']}", defect=True)

        # out and back with the real mouse: the arm must come back
        fresh(page); A0 = page.evaluate(f"JSON.parse(JSON.stringify({RIG}.angles))"); h = lib.handle_xy(page, "palm_R")
        pts = [(h["x"] + 4 * i, h["y"] - 6 * i) for i in range(0, 20)] + [(h["x"] + 4 * (38 - i), h["y"] - 6 * (38 - i)) for i in range(20, 39)]
        m.move(h["x"], h["y"]); m.down()
        for (x, y) in pts:
            m.move(x, y); page.wait_for_timeout(120)
        page.wait_for_timeout(800); m.up(); page.wait_for_timeout(600)
        A1 = page.evaluate(f"JSON.parse(JSON.stringify({RIG}.angles))")
        worst = max(((abs(v - A0[k][i]), f"{k}[{i}]") for k, a in A1.items() for i, v in enumerate(a)))
        h2 = lib.handle_xy(page, "palm_R")
        check("the hand is home after out and back", px(h2, (h["x"], h["y"])) < 6, f"{px(h2, (h['x'], h['y'])):.0f} px")
        check("... and the arm is as it was (no joint more than 8 degrees away)", worst[0] < 8, f"{worst[1]} is {worst[0]:.0f} degrees away", defect=True)

        # Move figure on the horizontal plane in a side-on view
        fresh(page)
        page.evaluate(f"{ED}.setOption('pelvisMode','move'); window.__human.ctx.setView('front')"); page.wait_for_timeout(1500)
        h = lib.handle_xy(page, "pelvis")
        m.move(h["x"], h["y"]); m.down()
        for i in range(1, 9):
            m.move(h["x"], h["y"] + 8 * i / 8); page.wait_for_timeout(120)
        page.wait_for_timeout(500)
        r = page.evaluate(f"[{RIG}.root.x, {RIG}.root.y, {RIG}.root.z]")
        m.up(); page.wait_for_timeout(400)
        check("'Move figure' in the Front view: an 8 pixel drag moves the figure by centimetres, not tens of metres", abs(r[2]) < 3 and abs(r[0]) < 3, f"z = {r[2]:.1f} m", defect=True)
        page.evaluate(f"{ED}.setOption('pelvisMode','bend'); window.__human.ctx.setView('iso')")
        check("no console error in the drag session", lib.errors(logs) == [], str(lib.errors(logs)[:2]))


def session_touch():
    with lib.session(390, 800, False, True) as (page, logs, ctx):
        lib.open_posture(page)
        fresh(page)
        page.evaluate("window.scrollTo(0, 0)"); page.wait_for_timeout(800)
        h = lib.handle_xy(page, "palm_R")
        cdp = ctx.new_cdp_session(page)

        def touch(kind, x, y):
            cdp.send("Input.dispatchTouchEvent", {"type": kind, "touchPoints": [] if kind == "touchEnd" else [{"x": x, "y": y, "id": 1}]})
        touch("touchStart", h["x"], h["y"]); page.wait_for_timeout(100)
        for i in range(1, 11):
            touch("touchMove", h["x"] + 4 * i, h["y"] - 6 * i); page.wait_for_timeout(60)
        page.wait_for_timeout(400)
        during = page.evaluate(f"{ED}.dragging")
        touch("touchEnd", 0, 0); page.wait_for_timeout(600)
        h2 = lib.handle_xy(page, "palm_R")
        check("touch: a handle can be dragged with a finger (no pointercancel from the browser), one history step", during and page.evaluate(f"{ED}.history.undoLabel") == "Move right hand" and abs(h2["y"] - h["y"]) > 30 and page.evaluate("scrollY") == 0)
        check("no horizontal scroll at 390 px", page.evaluate("document.documentElement.scrollWidth") <= 390)
        check("no console error in the touch session", lib.errors(logs) == [])


# ------------------------------------------------------------------------------------------------------------------------------------------------ storage
def session_storage():
    good = lambda i, name: {"id": f"custom-p{i}", "name": name, "category": "Standing", "tags": ["a"], "description": "<b>d</b>", "source": "<script>window.__xss=1</script>", "support": "feet", "joints": {"elbow_LR": [30]}}
    posts = [good(i, f"P{i}") for i in range(150)]
    posts[0]["name"] = "<img src=x onerror=window.__xss=2>"
    posts[1]["description"] = "<img src=x onerror=window.__xss=3>"
    posts[2] = {"id": "custom-evil", "name": "evil", "support": "feet", "joints": {"__proto__": [1]}}
    init = "try { localStorage.setItem('hm-custom-postures-v1', %s); } catch (e) {}" % json.dumps(json.dumps({"version": 1, "postures": posts}))
    with lib.session(init=[init]) as (page, logs, ctx):
        lib.open_posture(page)
        page.wait_for_timeout(800)
        chip = page.evaluate("document.querySelector('.hm-pe-chip[data-value=custom] .hm-pe-n')?.textContent")
        check("150 hostile stored postures: 100 are listed, no script ran, names are text", page.evaluate("window.__xss") is None and chip == "100" and page.locator(".hm-pe-list img").count() == 0, f"chip={chip}")
        page.locator(".hm-pe-chip[data-value=custom]").click(); page.wait_for_timeout(500)
        page.evaluate("document.querySelector('.hm-pe-list').scrollTop = 99999"); page.wait_for_timeout(800)
        check("the Custom list scrolls to its end", "P100" in page.evaluate("[...document.querySelectorAll('.hm-pe-card-title')].map(e => e.textContent).join(' ')"))
        check("the problems found in the store are told to the person", page.evaluate(f"{ED}.customProblems().length") > 0 and page.locator("text=/could not be loaded|were ignored|were dropped|dropped/i").count() > 0, "customProblems() has entries, nothing in the panel shows them", defect=True)
        check("no console error with a hostile store", lib.errors(logs) == [], str(lib.errors(logs)[:2]))
    quota = "const _s = Storage.prototype.setItem; Storage.prototype.setItem = function (k, v) { if (k === 'hm-custom-postures-v1') throw new DOMException('quota', 'QuotaExceededError'); return _s.call(this, k, v); };"
    with lib.session(init=[quota]) as (page, logs, ctx):
        lib.open_posture(page)
        page.evaluate(f"{ED}.apply('iso-7250-sitting', {{animate:false}}); {ED}.setJoint('shoulder_R','flex',50)"); page.wait_for_timeout(500)
        page.evaluate("document.querySelector('.hm-pe-sec-cur').scrollIntoView()")
        page.get_by_role("button", name="Save as custom…").click()
        page.fill(".hm-pe-form input[type=text]", "Quota test"); page.locator(".hm-pe-form button[type=submit]").click(); page.wait_for_timeout(800)
        check("quota exceeded: the posture is kept for the session and the person is told", page.evaluate(f"{ED}.listCustom().length") == 1 and page.locator("text=/would not store them/").count() > 0 and page.evaluate(f"{ED}.customPersistent") is False)
        check("no console error with a full store", lib.errors(logs) == [])
    with lib.session() as (page, logs, ctx):
        lib.open_posture(page)

        def save(name):
            page.evaluate("document.querySelector('.hm-pe-sec-cur').scrollIntoView()")
            page.get_by_role("button", name="Save as custom…").click()
            page.fill(".hm-pe-form input[type=text]", name); page.locator(".hm-pe-form button[type=submit]").click(); page.wait_for_timeout(500)
        page.evaluate(f"{ED}.apply('iso-7250-standing', {{animate:false}}); {ED}.setJoint('shoulder_R','flex',50)"); page.wait_for_timeout(300)
        save("Alpha")
        page.evaluate(f"{ED}.setJoint('shoulder_R','flex',90)"); page.wait_for_timeout(300)
        save("Beta")
        page.evaluate(f"{ED}.apply('custom-alpha', {{animate:false}}); {ED}.setJoint('shoulder_R','flex',10)"); page.wait_for_timeout(300)
        save("Beta")
        names = page.evaluate(f"{ED}.listCustom().map(p => p.id + ':' + p.name)")
        check("'Save as custom' with the name of ANOTHER saved posture while editing 'Alpha' does not silently destroy 'Alpha' or leave two 'Beta'",
              "custom-alpha:Alpha" in names or sorted(n.split(":")[1] for n in names).count("Beta") == 1 and len(names) == 2 and "custom-beta:Beta" not in names, f"saved postures now: {names}", defect=True)


# ------------------------------------------------------------------------------------------------------------------------------------------------ library
def session_library():
    src = Path(lib.HERE.parent.parent / "site/js/human/postures.js").read_text()
    needle = "export const POSTURES = Object.freeze(GROUPS.flatMap((g) => g.postures));"
    assert needle in src
    patched = src.replace(needle, "const BASE_P = GROUPS.flatMap((g) => g.postures);\nexport const POSTURES = Object.freeze([...BASE_P, ...Array.from({ length: 3 }, (_, k) => BASE_P.map((p) => Object.freeze({ ...p, id: `${p.id}-x${k}`, name: `${p.name} #${k + 2}` }))).flat()]);")
    longtask = "window.__lt = []; new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__lt.push(Math.round(e.duration)); }).observe({ entryTypes: ['longtask'] });"
    with lib.session(init=[longtask]) as (page, logs, ctx):
        page.route("**/js/human/postures.js", lambda route: route.fulfill(status=200, content_type="text/javascript", body=patched))
        lib.open_posture(page)
        total = page.evaluate("import('/js/human/postures.js').then(m => m.POSTURES.length)")
        n = page.evaluate("document.querySelector('.hm-pe-count').textContent")
        check(f"a library of {total} postures (4 x the real one): all counted, the list is windowed (few rows in the DOM)", n.startswith(f"{total} of {total}") and page.evaluate("document.querySelectorAll('.hm-pe-card').length") <= 20, n)
        page.wait_for_timeout(1500)
        page.evaluate("window.__lt.length = 0")
        page.focus(".hm-pe-list")
        page.keyboard.press("End"); page.wait_for_timeout(300)
        last = page.evaluate("document.querySelector('.hm-pe-card.is-active')?.dataset.index")
        page.keyboard.press("Home")
        for _ in range(40):
            page.keyboard.press("PageDown")
        page.wait_for_timeout(500)
        mid = page.evaluate("document.querySelector('.hm-pe-card.is-active')?.dataset.index")
        check("keyboard on a long list: End goes to the last row, Page Down moves by a page, the active row is in the DOM with aria-activedescendant",
              last == str(total - 1) and int(mid) > 100 and page.evaluate("!!document.getElementById(document.querySelector('.hm-pe-list').getAttribute('aria-activedescendant'))"), f"last={last} mid={mid}")
        for k in range(10):
            page.evaluate(f"document.querySelector('.hm-pe-list').scrollTop = {k} * 3000"); page.wait_for_timeout(30)
        page.wait_for_timeout(6000)
        drawn = page.evaluate("[...document.querySelectorAll('.hm-pe-card')].every(c => c.querySelector('canvas').dataset.state === 'drawn' && c.querySelector('.hm-pe-valid').dataset.state !== 'pending')")
        long = page.evaluate("window.__lt")
        check("fast scrolling over the whole list: the rows in view end up drawn and validated; no main-thread task over 300 ms", drawn and max(long or [0]) < 300, f"drawn={drawn} longtasks={long}")
        page.evaluate("window.__lt.length = 0")
        page.fill(".hm-pe-searchbox", "sit"); page.wait_for_timeout(1200)
        check("search in a 4 x library is quick (no task over 300 ms)", max(page.evaluate("window.__lt") or [0]) < 300 and page.locator(".hm-pe-count").inner_text().startswith("2"))
        check("no console error with a long library", lib.errors(logs) == [])


# ------------------------------------------------------------------------------------------------------------------------------------------------ keys, names, leaks
NAMES = """() => { const out = []; const name = (el) => { const lb = el.getAttribute('aria-labelledby'); if (lb) { const t = lb.split(/\\s+/).map(i => document.getElementById(i)?.textContent ?? '').join(' ').trim(); if (t) return t; }
  const al = el.getAttribute('aria-label'); if (al) return al; if (el.labels && el.labels.length) return [...el.labels].map(l => l.textContent).join(' ').trim(); const t = el.textContent.trim(); return t || el.getAttribute('title') || ''; };
  for (const el of document.querySelectorAll('#view-human button, #view-human input, #view-human select, #view-human [role=option], #view-human [role=listbox], #view-human summary')) { if (el.closest('[hidden]') || el.type === 'file') continue; if (!name(el)) out.push(el.outerHTML.slice(0, 100)); } return out; }"""


def session_a11y():
    leak = re.search(r'LEAK_INIT = """(.*?)"""', Path(lib.HERE / "test_posture_panel.py").read_text(), re.S).group(1)
    with lib.session(init=[leak]) as (page, logs, ctx):
        lib.open_posture(page)
        fresh(page)
        page.evaluate("document.querySelectorAll('#view-human details').forEach(d => d.open = true)"); page.wait_for_timeout(400)
        unnamed = []
        for t in ["Spine", "Head", "L arm", "R arm", "L hand", "R hand", "L leg", "R leg"]:
            page.evaluate("(t) => [...document.querySelectorAll('.hm-pe-tabs [role=tab]')].find(b => b.textContent.trim() === t)?.click()", t); page.wait_for_timeout(250)
            page.evaluate("document.querySelectorAll('#view-human details').forEach(d => d.open = true)"); page.wait_for_timeout(150)
            unnamed += page.evaluate(NAMES)
        check("every button, field, select, option and summary has an accessible name (all 8 tabs, every detail open)", unnamed == [], str(unnamed[:3]))
        check("no duplicate ids", page.evaluate("(() => { const ids = {}; for (const e of document.querySelectorAll('[id]')) ids[e.id] = (ids[e.id] || 0) + 1; return Object.values(ids).filter(v => v > 1).length; })()") == 0)
        dangling = page.evaluate("(() => { const out = []; for (const e of document.querySelectorAll('[aria-labelledby],[aria-describedby],[aria-controls],[aria-activedescendant]')) for (const a of ['aria-labelledby','aria-describedby','aria-controls','aria-activedescendant']) { const v = e.getAttribute(a); if (v) for (const id of v.split(/\\s+/)) if (!document.getElementById(id)) out.push(a + '=' + id); } return out; })()")
        check("every aria-controls / labelledby / describedby points at an element that exists (the 7 inactive region tabs point at panels that do not)", dangling == [], str(dangling[:2]) + f" ({len(dangling)})", defect=True)
        # keyboard tour: a visible focus ring everywhere
        page.focus(".hm-pe-searchbox")
        bare = []
        for _ in range(120):
            page.keyboard.press("Tab")
            f = page.evaluate("() => { const e = document.activeElement, c = getComputedStyle(e), r = e.getBoundingClientRect(); return { out: !e.closest('.hm-pe'), tag: e.tagName, cls: String(e.className).slice(0, 30), none: c.outlineStyle === 'none' && c.boxShadow === 'none', vis: r.width > 0 }; }")
            if f["out"]:
                break
            if f["none"] and f["vis"]:
                bare.append((f["tag"], f["cls"]))
        check("a visible focus indicator on every tab stop of the panel", bare == [], str(bare[:3]))
        # sliders: arrows 1, Shift 10, Alt 0.1
        page.evaluate("[...document.querySelectorAll('.hm-pe-tabs [role=tab]')].find(b => b.textContent.trim() === 'R arm').click()"); page.wait_for_timeout(300)
        r = page.locator(".hm-pe-tabpanel .hm-pe-joint[data-joint=elbow_R] .hm-pe-range")
        r.scroll_into_view_if_needed(); r.focus()
        v = lambda: page.evaluate(f"{RIG}.angles.elbow_R[0]")
        seq = [v()]
        for key in ["ArrowRight", "Shift+ArrowRight", "Alt+ArrowRight", "PageUp", "ArrowLeft", "Home", "End", "ArrowRight"]:
            page.keyboard.press(key); page.wait_for_timeout(60); seq.append(v())
        check("slider keys: arrows 1 degree, Shift 10, Alt 0.1, Page 10, Home and End are the limits (-5 and 150), nothing goes past", [round(b - a, 1) for a, b in zip(seq[:5], seq[1:5])] == [1, 10, 0.1, 10] and seq[6:8] == [-5, 150] and seq[8] == 150, str(seq))
        num = page.locator(".hm-pe-tabpanel .hm-pe-joint[data-joint=elbow_R] .hm-pe-num")

        def typ(t):
            num.fill(t); page.keyboard.press("Enter"); page.wait_for_timeout(150)
            return v()
        check("number field: 999 is limited to 150, -999 to -5, an empty field and 1e400 change nothing", [typ("999"), typ("-999"), typ("45"), typ(""), typ("1e400")] == [150, -5, 45, 45, 45])
        # leaks
        page.wait_for_timeout(1500)
        stats = "() => ({ raf: window.__raf.size, listeners: window.__nl, canvases: document.querySelectorAll('canvas').length, nodes: document.querySelectorAll('*').length })"

        def go(t):
            page.evaluate("(t) => [...document.querySelectorAll('[role=tab]')].find(x => x.textContent.trim() === t).click()", t); page.wait_for_timeout(120)
        for t in ["Scene", "Measure", "Skeleton", "Analysis", "Export", "Profile", "Posture"]:
            go(t); page.wait_for_timeout(400)
        page.wait_for_timeout(1500)
        base = page.evaluate(stats)
        ids = page.evaluate("import('/js/human/postures.js').then(m => m.POSTURES.map(p => p.id))")
        for i in range(50):
            page.locator(".hm-pe-card").nth(i % 6).click(); page.wait_for_timeout(50)
        page.evaluate("""async (ids) => { const ed = window.__human.state.postureEditor; for (let i = 0; i < 50; i++) { ed.apply(ids[(i * 7) % ids.length]); await new Promise(r => setTimeout(r, 40)); } }""", ids)
        for i in range(15):
            go("Scene"); go("Posture")
        for i in range(5):
            h = lib.handle_xy(page, "palm_R"); m = page.mouse; m.move(h["x"], h["y"]); m.down()
            for k in range(1, 6):
                m.move(h["x"] + 6 * k, h["y"] - 6 * k); page.wait_for_timeout(30)
            m.up(); page.wait_for_timeout(200)
        page.wait_for_timeout(2500)
        after = page.evaluate(stats)
        check("100 posture switches (50 clicks, 50 animated), 15 tab round trips, 5 drags: no frame pending, no listener, canvas or node left over",
              after["raf"] <= base["raf"] and after["listeners"] == base["listeners"] and after["canvases"] == base["canvases"] and after["nodes"] <= base["nodes"] + 20, f"{base} -> {after}")
        check("no console error in the keyboard and leak session", lib.errors(logs) == [], str(lib.errors(logs)[:2]))
    init = "localStorage.setItem('hm-posture-prefs-v1', JSON.stringify({ open: 'x', pelvisMode: 'evil', footPoint: 5 }));"
    with lib.session(init=[init]) as (page, logs, ctx):
        lib.open_posture(page)
        page.wait_for_timeout(300)
        for s in [".hm-pe-sec-lib > summary", ".hm-pe-sec-cur > summary", ".hm-pe-sec-edit > summary"]:
            page.locator(s).click(); page.wait_for_timeout(100)
        check("hostile saved preferences (open: 'x') raise no page error when a section is toggled", lib.errors(logs) == [], str(lib.errors(logs)[:1]), defect=True)


SESSIONS = {"drag": session_drag, "touch": session_touch, "storage": session_storage, "library": session_library, "a11y": session_a11y}

if __name__ == "__main__":
    want = sys.argv[1:] or list(SESSIONS)
    for name in want:
        print(f"--- {name}")
        SESSIONS[name]()
    bad = [r for r in RESULTS if r[0] == "FAIL"]
    print(f"\n{sum(r[0] == 'PASS' for r in RESULTS)} pass, {sum(r[0] == 'DEFECT' for r in RESULTS)} known defects, {sum(r[0] == 'FIXED' for r in RESULTS)} fixed, {len(bad)} fail")
    sys.exit(1 if bad else 0)
