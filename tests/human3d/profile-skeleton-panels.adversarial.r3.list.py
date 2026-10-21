import sys
sys.path.insert(0, 'tests/human3d')
from shot import browser
out = sys.argv[1]
with browser(360, 800, dark=True, mobile=True) as (page, logs):
    page.goto(page.base + '/#/human?debug')
    page.wait_for_function("window.__human && window.__human.state.rig", timeout=90000)
    page.wait_for_selector('.hm-pf .hm-pf-dimbtn', timeout=30000)
    page.click('.hm-pf-srcseg button:has-text("Individual")'); page.wait_for_selector('.hm-pf-view select', timeout=30000); page.wait_for_timeout(1000)
    page.click('button:has-text("From a list")'); page.wait_for_selector('.hm-pf-person'); page.wait_for_timeout(300)
    page.locator('.hm-pf-viewhost').scroll_into_view_if_needed(); page.evaluate("window.scrollBy(0,-70)")
    page.screenshot(path=f'{out}/r3-list360.png')
    print(page.evaluate("[document.documentElement.scrollWidth, innerWidth]"), page.evaluate("[...document.querySelectorAll('.hm-pf-person')].filter(b=>b.scrollWidth>b.clientWidth+1).length"))
    page.click('button:has-text("By number")'); page.wait_for_timeout(300)
    page.screenshot(path=f'{out}/r3-num360.png')
