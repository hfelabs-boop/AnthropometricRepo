import sys, json
sys.path.insert(0, 'tests/human3d')
from shot import browser
with browser(1280, 800) as (page, logs):
    page.goto(page.base + '/#/human?debug')
    page.wait_for_function("window.__human && window.__human.state.rig", timeout=90000)
    page.wait_for_selector('.hm-pf-dimbtn')
    st = lambda: page.evaluate("()=>({sel:window.__human.state.selection, disp:window.__human.state.rig.display, kids:window.__human.viewport.scene.children.length, userd:window.__human.state.display})")
    base = st(); print('base kids', base['kids'], base['disp']['landmarks'], base['disp']['xray'])
    for dim in ['hand_length', 'stature', 'ring_waist', 'hip_to_seat', 'ball_length']:
        page.evaluate("(d)=>{const b=document.querySelector(`.hm-pf-dimbtn[data-dim=\"${d}\"]`); b.scrollIntoView({block:'center'}); b.click()}", dim)
        page.wait_for_timeout(200)
        s = st(); print(dim, s['sel'], 'flash on:', s['disp']['landmarks'], s['disp']['xray'], 'kids', s['kids'])
    # rapid
    page.wait_for_timeout(2600)
    s = st(); print('after 2.6s', s['disp']['landmarks'], s['disp']['xray'], 'kids', s['kids'], 'user', s['userd']['landmarks'], s['userd']['xray'])
    # tab switching leak
    for i in range(10):
        page.click('[role=tab]:has-text("Skeleton")'); page.click('[role=tab]:has-text("Profile")')
    print('css links', page.evaluate("document.querySelectorAll('link[data-hm-profile-css]').length"), 'dim rows', page.locator('.hm-pf-dimbtn').count())
    # hide the whole view while flash pending then return
    page.evaluate("document.querySelector('.hm-pf-dimbtn[data-dim=\"stature\"]').click()")
    page.click('nav a:has-text("Tables"), a[href="#/tables"]') if page.locator('a[href="#/tables"]').count() else None
    page.wait_for_timeout(2600)
    page.goto(page.base + '/#/human?debug'); page.wait_for_timeout(1000)
    s = st(); print('after leaving+return', s['disp']['landmarks'], s['disp']['xray'], 'kids', s['kids'])
    # edit while flash pending (rig replaced): marker leak?
    page.evaluate("document.querySelector('.hm-pf-dimbtn[data-dim=\"hand_length\"]').click()"); page.wait_for_timeout(100)
    inp = page.locator('.hm-pf-dimdetail input.hm-pf-edit'); inp.fill('200'); inp.press('Enter')
    page.wait_for_function("window.__human.state.body.dims.find(d=>d.id==='hand_length').value>0.199", timeout=30000)
    page.wait_for_timeout(2800)
    s = st(); print('after edit during flash', s['disp']['landmarks'], s['disp']['xray'], 'kids', s['kids'], 'base kids', base['kids'])
    print('errors', [l[:200] for l in logs if l.startswith('[error]') or l.startswith('[pageerror]')])
