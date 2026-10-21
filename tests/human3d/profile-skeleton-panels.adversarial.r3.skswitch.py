import sys
sys.path.insert(0, 'tests/human3d')
from shot import browser
tab = lambda page, n: page.evaluate("(n)=>[...document.querySelectorAll('[role=tab]')].find(t=>t.textContent.trim()===n).click()", n)
wait = "()=>{const c=window.__human.ctx,b=c.getBody(),p=c.getProfile();return b&&p&&b.profileId===p.id&&!window.__human.state.busy}"
with browser(1280, 800) as (page, logs):
    page.goto(page.base + '/#/human?debug')
    page.wait_for_function("window.__human && window.__human.state.rig", timeout=90000)
    page.wait_for_selector('.hm-pf .hm-pf-dimbtn', timeout=30000)
    tab(page, 'Skeleton'); page.wait_for_selector('.hm-sk .hm-sk-item')
    page.evaluate("window.__human.ctx.select({kind:'joint', id:'knee_L'})"); page.wait_for_timeout(300)
    seg = lambda: page.evaluate("document.querySelector('.hm-sk-insp .hm-sk-seg-line')?.innerText.replace(/\\n/g,' ')")
    print('knee seg', seg())
    tab(page, 'Profile'); page.wait_for_timeout(300)
    print('inspector on profile tab:', page.inner_text('#hm-inspector-title'))
    # change profile through the profile panel (manual 1950) while skeleton hidden
    page.click('.hm-pf-srcseg button:has-text("Manual")'); page.fill('input[id^="hm-pf-mst"]', '1950'); page.click('button:has-text("Build this body")')
    page.wait_for_timeout(500); page.wait_for_function(wait, timeout=60000)
    tab(page, 'Skeleton'); page.wait_for_timeout(500)
    print('inspector after return:', page.inner_text('#hm-inspector-title'), '| knee seg', seg(), '| tree row', page.inner_text('[data-node="j:knee_L"]').replace('\n',' '))
    exp = page.evaluate("Math.hypot(...window.__human.ctx.getBody().joints.knee_L.offset)*1000")
    print('expected knee segment mm', round(exp, 1))
    # units switch while skeleton shown
    page.click('.hm-group button:has-text("in")'); page.wait_for_timeout(300)
    print('in:', seg(), '|', page.inner_text('[data-node="j:knee_L"]').replace('\n',' '), '| lm sample', page.evaluate("(document.querySelector('.hm-sk-lms li')||{}).innerText"))
    print([l for l in logs if l.startswith('[pageerror]') or l.startswith('[error]')][:5])
