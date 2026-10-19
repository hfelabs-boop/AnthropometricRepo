import sys, json
sys.path.insert(0, 'tests/human3d')
from shot import browser
out = sys.argv[1]
OVER = """(root)=>{const W=document.documentElement.clientWidth, res=[]; for (const e of document.querySelector(root).querySelectorAll('*')) {const r=e.getBoundingClientRect(); if (r.width>0 && (r.right>W+1||r.left<-1) && getComputedStyle(e).visibility!=='hidden' && e.offsetParent!==null) res.push([e.tagName, e.className.toString().slice(0,40), Math.round(r.left), Math.round(r.right)]);} return {sw:document.documentElement.scrollWidth, W, over:res.slice(0,8), n:res.length}}"""
for dark in (False, True):
  with browser(360, 740, dark=dark, mobile=True) as (page, logs):
    page.goto(page.base + '/#/human?debug')
    page.wait_for_function("window.__human && window.__human.state.rig", timeout=90000)
    page.wait_for_selector('.hm-pf-dimbtn')
    tag = 'D' if dark else 'L'
    page.evaluate("document.querySelectorAll('.hm-pf details').forEach(d=>d.open=true)")
    page.click('summary:has-text("Fit report")'); page.click('summary:has-text("Body form")')
    for d in ['upper_arm_length', 'hand_length', 'ring_chest', 'trunk_length']:
        page.evaluate("(d)=>document.querySelector(`.hm-pf-dimbtn[data-dim=\"${d}\"]`).click()", d)
    print(tag, 'population view open', page.evaluate(OVER, '.hm-pf'))
    for src in ['Individual', 'Import', 'Manual']:
        page.click(f'.hm-pf-srcseg button:has-text("{src}")'); page.wait_for_timeout(1500)
        print(tag, src, page.evaluate(OVER, '.hm-pf'))
        page.locator('.hm-pf-srcseg').scroll_into_view_if_needed()
        page.screenshot(path=f'{out}/{tag}-360-{src}.png')
    page.click('[role=tab]:has-text("Skeleton")'); page.wait_for_selector('.hm-sk-tree')
    page.click('button:has-text("Expand all")'); page.click('summary:has-text("Landmarks")'); page.click('summary:has-text("Points for CAD")')
    page.evaluate("window.__human.ctx.select({kind:'joint', id:'index_pip_L'})"); page.wait_for_timeout(500)
    print(tag, 'skeleton', page.evaluate(OVER, '.hm-sk'))
    page.locator('.hm-sk-inline').scroll_into_view_if_needed(); page.screenshot(path=f'{out}/{tag}-360-sk.png')
