import sys
sys.path.insert(0, 'tests/human3d')
from shot import browser
out = sys.argv[1]
for (w, dark, tag) in [(1280, False, 'l'), (360, True, 'd360')]:
  with browser(w, 800, dark=dark) as (page, logs):
    page.goto(page.base + '/#/human?debug')
    page.wait_for_function("window.__human && window.__human.state.rig", timeout=90000)
    page.wait_for_selector('.hm-pf .hm-pf-dimbtn', timeout=30000)
    page.click('.hm-pf-srcseg button:has-text("Individual")'); page.wait_for_selector('.hm-pf-view select', timeout=30000); page.wait_for_timeout(1500)
    print(page.evaluate("""()=>{const root=document.querySelector('.hm-pf-viewhost').getBoundingClientRect(); return [...document.querySelectorAll('.hm-pf-view button, .hm-pf-view .seg, .hm-pf-view select')].map(e=>{const r=e.getBoundingClientRect(); return [e.tagName, e.textContent.slice(0,20), Math.round(r.left), Math.round(r.right), Math.round(root.left), Math.round(root.right)]}).filter(x=>x[3]>x[5]+0)}"""))
    page.locator('.hm-pf-viewhost').scroll_into_view_if_needed()
    page.locator('.hm-pf-viewhost').screenshot(path=f'{out}/r3-indiv-{tag}.png')
