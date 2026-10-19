import sys, json
sys.path.insert(0, 'tests/human3d')
from shot import browser
with browser(1280, 800) as (page, logs):
    page.add_init_script("try{localStorage.setItem('hm-profile-last', JSON.stringify({country:'germany',role:'aircrew',sex:'both'}))}catch(e){}")
    page.goto(page.base + '/#/human?debug')
    page.wait_for_function("window.__human && window.__human.state.rig", timeout=90000)
    page.wait_for_selector('.hm-pf-view select'); page.wait_for_timeout(1500)
    print(page.evaluate("({sel:[...document.querySelectorAll('.hm-pf-view select')].slice(0,3).map(s=>s.value), prof:window.__human.state.profile.label, status:document.querySelector('.hm-pf-status').textContent})"))
    page.click('button:has-text("P95")'); page.wait_for_timeout(2500)
    print(page.evaluate("({sel:[...document.querySelectorAll('.hm-pf-view select')].slice(0,3).map(s=>s.value), prof:window.__human.state.profile.label})"))
with browser(1280, 800) as (page, logs):
    # storage that throws
    page.add_init_script("Object.defineProperty(window,'localStorage',{get(){throw new Error('blocked')}})")
    page.goto(page.base + '/#/human?debug')
    page.wait_for_function("window.__human && window.__human.state.rig", timeout=90000)
    page.wait_for_selector('.hm-pf-view select'); page.click('button:has-text("P95")'); page.wait_for_timeout(2000)
    print('blocked storage ok:', page.evaluate("window.__human.state.profile.label"), [l[:150] for l in logs if l.startswith('[pageerror]')])
