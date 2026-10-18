import sys, json
sys.path.insert(0, 'tests/human3d')
from shot import browser
def st(page):
    return page.evaluate("""()=>({pid: window.__human.state.profile?.id, status: document.querySelector('.hm-pf-status')?.textContent, scls: document.querySelector('.hm-pf-status')?.className, role: document.querySelector('.hm-pf-status')?.getAttribute('role'), live: document.querySelector('.hm-pf-status')?.getAttribute('aria-live'), notices: window.__human.state.notices.map(n=>n.level+': '+n.text.slice(0,140))})""")
with browser(1280, 800) as (page, logs):
    page.goto(page.base + '/#/human?debug')
    page.wait_for_function("window.__human && window.__human.state.rig", timeout=90000)
    page.wait_for_selector('.hm-pf-view select', timeout=30000)
    base = st(page)['pid']
    for name, handler in [("abort", lambda r: r.abort()), ("bad json", lambda r: r.fulfill(status=200, body="{not json")),
                          ("wrong shape", lambda r: r.fulfill(status=200, content_type="application/json", body='{"measures":[{"key":"stature","p5":"x"}],"population":{}}')),
                          ("empty measures", lambda r: r.fulfill(status=200, content_type="application/json", body='{"measures":[],"population":{"country":"x"}}')),
                          ("500", lambda r: r.fulfill(status=500, body="boom")),
                          ("html", lambda r: r.fulfill(status=200, content_type="text/html", body="<html>login</html>"))]:
        page.route("**/populations/**", handler)
        # fresh combos not cached: use france/ various
        combos = {"abort": "france", "bad json": "italy", "wrong shape": "japan", "empty measures": "canada", "500": "sweden", "html": "poland"}
        page.select_option('.hm-pf-view select >> nth=0', combos[name])
        page.wait_for_timeout(2500)
        s = st(page)
        print(f"{name}: [{s['scls'].split('-')[-1]}] {s['status'][:170]!r}; profile unchanged={s['pid']==base or s['pid']!=base} pid={s['pid'][:40]} notices={s['notices']}")
        page.unroute("**/populations/**")
    print('pageerrors', [l for l in logs if l.startswith('[pageerror]')])
    print('status aria', st(page)['role'], st(page)['live'])
# index failing, population source
with browser(1280, 800) as (page, logs):
    page.route("**/api/v1/index.json", lambda r: r.fulfill(status=500, body="x"))
    page.goto(page.base + '/#/human?debug')
    page.wait_for_function("window.__human && window.__human.state.rig", timeout=90000)
    page.wait_for_selector('.hm-pf-view', timeout=30000)
    page.click('.hm-pf-srcseg button:has-text("Population")')
    page.wait_for_timeout(1500)
    print('index500 view:', page.inner_text('.hm-pf-view')[:300].replace('\n', ' | '))
    page.unroute("**/api/v1/index.json")
    page.click('.hm-pf-view button:has-text("Retry")')
    page.wait_for_selector('.hm-pf-view select', timeout=20000)
    print('retry gives selects:', page.locator('.hm-pf-view select').count())
