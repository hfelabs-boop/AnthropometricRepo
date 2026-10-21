import sys, os
sys.path.insert(0, 'tests/human3d')
from shot import browser
D = sys.argv[1]
with browser(1280, 800) as (page, logs):
    page.goto(page.base + '/#/human?debug')
    page.wait_for_function("window.__human && window.__human.state.rig", timeout=90000)
    page.click('.hm-pf-srcseg button:has-text("Import")'); page.wait_for_selector('.hm-pf-paste')
    for f in ['pop.csv', 'popF.latest.json', 'mann.json', 'x.xlsx', 'noext', 't.txt', 'big.csv', 'utf16.csv', 'empty.json', 'dir.json']:
        before = page.evaluate("window.__human.state.profile.id")
        page.set_input_files('input[type=file]', os.path.join(D, f))
        page.wait_for_timeout(400)
        try: page.wait_for_function("!window.__human.state.busy", timeout=40000)
        except Exception: print(f, 'BUSY')
        page.wait_for_timeout(200)
        r = page.evaluate("()=>({err:document.querySelector('.hm-pf-importerr')?.innerText.replace(/\\n/g,' ').slice(0,260), ok: document.querySelector('.hm-pf-view .hm-pf-msg-ok')?.textContent, label: window.__human.state.profile.label.slice(0,60), id: window.__human.state.profile.id})")
        print(f.ljust(18), 'changed' if r['id'] != before else 'same   ', r['label'][:50].ljust(50), '| err:', r['err'], '| ok:', r['ok'])
    print([l for l in logs if l.startswith('[pageerror]')])
