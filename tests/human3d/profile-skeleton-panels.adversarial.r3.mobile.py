import sys
sys.path.insert(0, 'tests/human3d')
from shot import browser
out = sys.argv[1]
for dark in (False, True):
  with browser(390, 800, dark=dark, mobile=True) as (page, logs):
    page.goto(page.base + '/#/human?debug')
    page.wait_for_function("window.__human && window.__human.state.rig", timeout=90000)
    page.wait_for_selector('.hm-pf .hm-pf-dimbtn', timeout=30000); page.wait_for_timeout(600)
    t = 'd' if dark else 'l'
    page.evaluate("document.querySelectorAll('.hm-pf details.hm-section').forEach(d=>d.open=true)")
    page.click('.hm-pf-dimbtn[data-dim="hand_length"]'); page.wait_for_timeout(300)
    for name, sel in [('pf-head', '.hm-pf-card'), ('pf-source', '.hm-pf-srcseg'), ('pf-dim', '.hm-pf-dim.is-open'), ('pf-rep', '.hm-pf-repsum'), ('pf-notes', '.hm-pf-notes')]:
        page.locator(sel).first.scroll_into_view_if_needed(); page.evaluate("window.scrollBy(0,-70)"); page.wait_for_timeout(150)
        page.screenshot(path=f'{out}/r3m-{t}-{name}.png')
    print(t, 'doc scrollWidth', page.evaluate("[document.documentElement.scrollWidth, innerWidth]"), [l for l in logs if l.startswith('[pageerror]')])
    page.evaluate("[...document.querySelectorAll('[role=tab]')].find(t=>/Skeleton/.test(t.textContent)).click()")
    page.wait_for_selector('.hm-sk .hm-sk-item'); page.evaluate("document.querySelectorAll('.hm-sk details.hm-section').forEach(d=>d.open=true)"); page.wait_for_timeout(400)
    page.locator('.hm-sk-tree').scroll_into_view_if_needed(); page.evaluate("window.scrollBy(0,-70)"); page.wait_for_timeout(150)
    page.screenshot(path=f'{out}/r3m-{t}-sk-tree.png')
    page.locator('.hm-sk-lms').scroll_into_view_if_needed(); page.evaluate("window.scrollBy(0,-70)"); page.wait_for_timeout(150)
    page.screenshot(path=f'{out}/r3m-{t}-sk-lm.png')
    print(t, 'sk doc scrollWidth', page.evaluate("[document.documentElement.scrollWidth, innerWidth]"))
