"""Adversarial: stale loads, slider races, 404 / offline paths of the population source in the real tab."""
import sys, json, time
sys.path.insert(0, 'tests/human3d')
from shot import browser

def state(page):
    return page.evaluate("""()=>({pid: window.__human.state.profile?.id, label: window.__human.state.profile?.label, busy: window.__human.state.busy, body: window.__human.state.body?.profileId, sel:[...document.querySelectorAll('.hm-pf-view select')].slice(0,3).map(s=>s.value), status: document.querySelector('.hm-pf-status')?.textContent, scls: document.querySelector('.hm-pf-status')?.className, notices: window.__human.state.notices.map(n=>n.level+': '+n.text.slice(0,120))})""")

with browser(1280, 800) as (page, logs):
    # delay france (A), serve germany (B) at once
    def slow(route):
        time.sleep(0)  # playwright sync routes cannot sleep without blocking: use a flag instead
        route.continue_()
    page.goto(page.base + '/#/human?debug')
    page.wait_for_function("window.__human && window.__human.state.rig", timeout=90000)
    page.wait_for_selector('.hm-pf-view select', timeout=30000)
    # --- race 1: hold the france file until we release it
    held = []
    def hold(route):
        held.append(route)
    page.route("**/populations/france/**", hold)
    page.select_option('.hm-pf-view select >> nth=0', 'france')
    page.wait_for_timeout(600)
    print('france requested, held:', len(held))
    page.route("**/populations/germany/**", lambda r: r.continue_())
    page.select_option('.hm-pf-view select >> nth=0', 'germany')
    page.wait_for_function("window.__human.state.profile?.source?.country_id==='germany' && !window.__human.state.busy", timeout=60000)
    s1 = state(page); print('germany built', s1['pid'])
    for r in held: r.continue_()
    page.wait_for_timeout(2500)
    s2 = state(page); print('after france released:', s2['pid'], s2['sel'], s2['status'][:80])
    if s2['pid'] != s1['pid']: print('RACE FAIL: stale france load replaced germany')
    # --- race 2: hold germany P5? percentiles are same file (cached). rapid slider
    page.unroute("**/populations/france/**")
    # rapid slider moves
    page.evaluate("""()=>{const r=document.querySelector('.hm-pf-slider input[type=range]'); for (const v of [10,90,20,80,30,70,40]) {r.value=v; r.dispatchEvent(new Event('input',{bubbles:true}));} r.dispatchEvent(new Event('change',{bubbles:true}));}""")
    page.wait_for_timeout(3500)
    s3 = state(page); print('after slider storm:', s3['pid'], 'body', s3['body'] == s3['pid'], s3['busy'])
    # --- 404 path
    page.route("**/populations/united-states/army/F.json", lambda r: r.fulfill(status=404, body="nope"))
    page.select_option('.hm-pf-view select >> nth=0', 'united-states')
    page.wait_for_timeout(500)
    page.select_option('.hm-pf-view select >> nth=1', 'army')
    page.select_option('.hm-pf-view select >> nth=2', 'F')
    page.wait_for_timeout(2500)
    s4 = state(page); print('404:', s4['status'], s4['scls'], 'pid still', s4['pid'])
    print('retry button present:', page.locator('.hm-pf-status button:has-text("Retry")').count())
    page.unroute("**/populations/united-states/army/F.json")
    page.click('.hm-pf-status button:has-text("Retry")')
    page.wait_for_function("window.__human.state.profile?.source?.sex==='F' && !window.__human.state.busy", timeout=60000)
    s5 = state(page); print('after retry:', s5['pid'], s5['status'][:70])
    # --- offline: abort everything under populations
    page.route("**/populations/**", lambda r: r.abort())
    page.select_option('.hm-pf-view select >> nth=2', 'M')
    page.wait_for_timeout(2000)
    s6 = state(page); print('offline:', s6['status'][:150], s6['scls'], s6['pid'])
    # invalid JSON
    page.unroute("**/populations/**")
    page.route("**/populations/united-states/army/M.json", lambda r: r.fulfill(status=200, body="{not json"))
    page.select_option('.hm-pf-view select >> nth=2', 'F'); page.wait_for_timeout(300); page.select_option('.hm-pf-view select >> nth=2', 'M')
    page.wait_for_timeout(2000)
    s7 = state(page); print('bad json:', s7['status'][:150], s7['scls'])
    # a population file with wrong shape
    page.unroute("**/populations/united-states/army/M.json")
    page.route("**/populations/united-states/army/M.json", lambda r: r.fulfill(status=200, content_type="application/json", body='{"measures":[{"key":"stature","p5":"x"}],"population":{}}'))
    page.select_option('.hm-pf-view select >> nth=2', 'F'); page.wait_for_timeout(300); page.select_option('.hm-pf-view select >> nth=2', 'M')
    page.wait_for_timeout(2500)
    s8 = state(page); print('hostile file:', s8['status'][:200], s8['scls'], s8['pid'], s8['notices'])
    # index offline on fresh load
    errs = [l for l in logs if l.startswith('[pageerror]')]
    print('pageerrors', errs[:5])
    print('console errors (non network):', [l[:200] for l in logs if l.startswith('[error]') and 'Failed to load resource' not in l][:8])

with browser(1280, 800) as (page, logs):
    page.route("**/api/v1/index.json", lambda r: r.fulfill(status=404, body="x"))
    page.goto(page.base + '/#/human?debug')
    page.wait_for_function("window.__human && window.__human.state.rig", timeout=90000)
    page.wait_for_selector('.hm-pf-view', timeout=30000)
    page.wait_for_timeout(1500)
    print('index 404 view:', page.inner_text('.hm-pf-view')[:300].replace('\n', ' | '))
    print('profile label:', page.evaluate("window.__human.state.profile?.label"), page.evaluate("window.__human.state.notices.map(n=>n.text.slice(0,100))"))
    page.unroute("**/api/v1/index.json")
    page.click('.hm-pf-view button:has-text("Retry")')
    page.wait_for_selector('.hm-pf-view select', timeout=20000)
    print('retry gives selects:', page.locator('.hm-pf-view select').count())
