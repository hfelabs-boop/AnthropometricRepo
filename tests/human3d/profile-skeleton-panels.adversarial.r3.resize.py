import sys
sys.path.insert(0, 'tests/human3d')
from shot import browser
with browser(1280, 800) as (page, logs):
    page.goto(page.base + '/#/human?debug')
    page.wait_for_function("window.__human && window.__human.state.rig", timeout=90000)
    page.wait_for_selector('.hm-pf .hm-pf-dimbtn', timeout=30000)
    page.evaluate("[...document.querySelectorAll('[role=tab]')].find(t=>/Skeleton/.test(t.textContent)).click()")
    page.wait_for_selector('.hm-sk .hm-sk-item')
    page.evaluate("window.__human.ctx.select({kind:'joint', id:'knee_L'})"); page.wait_for_timeout(300)
    for w in [600, 1280, 500, 899, 900, 360, 1280]:
        page.set_viewport_size({'width': w, 'height': 800}); page.wait_for_timeout(350)
        r = page.evaluate("()=>({inlineHidden: document.querySelector('.hm-sk-inline').hidden, inlineText: document.querySelector('.hm-sk-inline').innerText.slice(0,40).replace(/\\n/g,' '), inspTitle: document.querySelector('#hm-inspector-title').textContent, dofRows: document.querySelectorAll('.hm-sk-dof').length, sw: document.documentElement.scrollWidth})")
        print(w, r)
    # pose events while hidden tab: switch to Profile, pose, switch back
    page.evaluate("[...document.querySelectorAll('[role=tab]')].find(t=>/^Profile/.test(t.textContent)).click()")
    page.evaluate("window.__human.ctx.getRig().setPose({angles:{knee_L:[77,0]}})"); page.wait_for_timeout(300)
    page.evaluate("[...document.querySelectorAll('[role=tab]')].find(t=>/Skeleton/.test(t.textContent)).click()"); page.wait_for_timeout(500)
    print('knee value shown:', page.evaluate("[...document.querySelectorAll('.hm-sk-dofval')].map(e=>e.textContent)"), 'row angle:', page.evaluate("document.querySelector('[data-node=\"j:knee_L\"] .hm-sk-ang').textContent"))
    print([l for l in logs if l.startswith('[pageerror]') or l.startswith('[error]')])
