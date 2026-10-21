import sys, json
sys.path.insert(0, 'tests/human3d')
from shot import browser
with browser(1280, 800) as (page, logs):
    page.goto(page.base + '/#/human?debug')
    page.wait_for_function("window.__human && window.__human.state.rig", timeout=90000)
    page.click('.hm-pf-srcseg button:has-text("Manual")')
    page.wait_for_selector('.hm-pf-form')
    def S(): return page.evaluate("()=>({label:window.__human.state.profile.label, id:window.__human.state.profile.id, st:window.__human.state.body?.stature, ms:window.__human.state.body?.mass, form:window.__human.state.body?.form, err:document.querySelector('.hm-pf-form .hm-pf-msg-error')?.textContent, status:document.querySelector('.hm-pf-status').textContent.slice(0,100), sex:window.__human.state.profile.sex, nm: Object.keys(window.__human.state.profile.measures).length})")
    print('prefill', page.evaluate("[...document.querySelectorAll('.hm-pf-form input, .hm-pf-form select')].map(e=>e.value)"))
    def build(sex, st, stu, ms, msu, wait=True):
        page.select_option('.hm-pf-form select >> nth=0', sex)
        for sel, v in (('.hm-pf-form input >> nth=0', st), ('.hm-pf-form input >> nth=1', ms)):
            loc = page.locator(sel); loc.fill(''); loc.press_sequentially(v)
        page.select_option('.hm-pf-form select >> nth=1', stu); page.select_option('.hm-pf-form select >> nth=2', msu)
        page.click('button:has-text("Build this body")')
        page.wait_for_timeout(400)
        try: page.wait_for_function("!window.__human.state.busy", timeout=40000)
        except Exception: print('busy!')
        page.wait_for_timeout(100)
        return S()
    for args in [("F", "165", "cm", "132", "lb"), ("M", "1.80", "m", "85", "kg"), ("both", "70", "in", "", "kg"), ("M", "1755", "mm", "80", "kg"), ("M", "1,755.5", "mm", "", "kg"), ("M", "175,5", "cm", "", "kg"),
                 ("M", "1299", "mm", "80", "kg"), ("M", "2501", "mm", "80", "kg"), ("M", "abc", "mm", "80", "kg"), ("M", "", "mm", "80", "kg"), ("M", "1755", "mm", "abc", "kg"), ("M", "1755", "mm", "-5", "kg"), ("M", "1755", "mm", "5", "kg"), ("M", "1755", "mm", "900", "kg"),
                 ("M", "1e3", "mm", "", "kg"), ("M", "1755", "mm", "0", "kg"), ("M", "1300", "mm", "30", "kg"), ("M", "2500", "mm", "250", "kg"), ("F", "1300", "mm", "", "kg")]:
        r = build(*args)
        print(args, '->', r['label'][:40], 'stature', None if r['st'] is None else round(r['st'] * 1000, 1), 'mass', r['ms'] and round(r['ms'], 1), r['form'], 'err:', r['err'], 'notices:', page.evaluate("window.__human.state.notices.map(n=>n.id+':'+n.text.slice(0,60))"))
    # change-trigger path: type stature and blur
    page.fill('.hm-pf-form input >> nth=0', '1850'); page.press('.hm-pf-form input >> nth=0', 'Tab'); page.wait_for_timeout(1500)
    print('blur applies:', S()['label'], round(S()['st'] * 1000))
    print('errors', [l[:150] for l in logs if l.startswith('[error]') or l.startswith('[pageerror]')])
