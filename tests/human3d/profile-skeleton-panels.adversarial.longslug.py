import sys, json
sys.path.insert(0, 'tests/human3d')
from shot import browser
with browser(1280, 800) as (page, logs):
    page.goto(page.base + '/#/human?debug')
    page.wait_for_function("window.__human && window.__human.state.rig", timeout=90000)
    page.wait_for_selector('.hm-pf-view select', timeout=30000)
    slug = "multiple-bolivia-brazil-colombia-chile-dominican-republic-ecuador-el-salvador-guatemala-honduras-nicaragua-panama-paraguay-peru-uruguay-venezuela"
    page.select_option('.hm-pf-view select >> nth=0', slug)
    for t in (0, 100, 400, 1500):
        page.wait_for_timeout(t)
        print(t, page.evaluate("()=>[document.querySelector('.hm-pf-view select').value.slice(0,25), window.__human.state.profile.source.country_id.slice(0,25), document.querySelector('.hm-pf-status').textContent.slice(0,60)]"))
    print(page.evaluate("()=>[...document.querySelectorAll('.hm-pf-view select')].slice(0,3).map(s=>[s.value.slice(0,20),[...s.options].map(o=>o.value.slice(0,30))])"))
    page.wait_for_function("!window.__human.state.busy", timeout=60000)
    page.wait_for_timeout(1500)
    def snap(tag):
        print(tag, json.dumps(page.evaluate("""()=>({sel:[...document.querySelectorAll('.hm-pf-view select')].slice(0,3).map(s=>s.value.slice(0,30)+'|'+s.selectedOptions[0]?.text.slice(0,40)), pid: window.__human.state.profile.id.slice(0,60), cid: window.__human.state.profile.source.country_id.length, label: window.__human.state.profile.label.slice(0,70), status: document.querySelector('.hm-pf-status').textContent.slice(0,100)})""")))
    snap('after select')
    # now drag the percentile: should stay in the same population
    page.click('button:has-text("P95")')
    page.wait_for_timeout(2500)
    snap('after P95')
    print([l for l in logs if 'error' in l][:5])
