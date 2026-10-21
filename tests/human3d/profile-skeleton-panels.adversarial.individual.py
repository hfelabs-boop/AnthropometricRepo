import sys, json, time
sys.path.insert(0, 'tests/human3d')
from shot import browser
with browser(1280, 800) as (page, logs):
    page.goto(page.base + '/#/human?debug')
    page.wait_for_function("window.__human && window.__human.state.rig", timeout=90000)
    page.click('.hm-pf-srcseg button:has-text("Individual")')
    page.wait_for_selector('.hm-pf-view select', timeout=90000); page.wait_for_timeout(800)
    def prof(): return page.evaluate("()=>({label:window.__human.state.profile.label, id:window.__human.state.profile.id, src:window.__human.state.profile.source, st:window.__human.state.body?.stature, ms:window.__human.state.body?.mass, busy:window.__human.state.busy, msg:[...document.querySelectorAll('.hm-pf-view .hm-pf-msg')].map(e=>e.textContent), status:document.querySelector('.hm-pf-status').textContent.slice(0,120), nm:Object.keys(window.__human.state.profile.measures).length})")
    def settle(): 
        page.wait_for_timeout(300); page.wait_for_function("!window.__human.state.busy", timeout=60000); page.wait_for_timeout(150)
    # closest: units
    for units, st in [('mm', '1850'), ('cm', '170'), ('in', '66')]:
        page.evaluate(f"window.__human.ctx.setUnits('{units}')"); page.wait_for_timeout(200)
        page.fill('.hm-pf-view input[type=number] >> nth=0', st)
        page.fill('.hm-pf-view input[type=number] >> nth=1', '')
        page.click('button:has-text("Find the closest person")'); settle()
        p = prof(); print(units, st, '->', round(p['st'] * 1000), p['msg'], p['src'].get('kind'), p['nm'], p['label'])
    page.evaluate("window.__human.ctx.setUnits('mm')")
    # invalid
    page.fill('.hm-pf-view input[type=number] >> nth=0', ''); page.click('button:has-text("Find the closest person")'); page.wait_for_timeout(300)
    print('empty ->', prof()['msg'], page.locator('.hm-pf-msg-error[role=alert]').count())
    # extremes
    page.fill('.hm-pf-view input[type=number] >> nth=0', '3000'); page.fill('.hm-pf-view input[type=number] >> nth=1', '5000'); page.click('button:has-text("Find the closest person")'); settle(); p = prof(); print('extreme ->', round(p['st']*1000), p['ms'], p['msg'])
    # list
    page.click('.hm-pf-view button:has-text("From a list")'); page.wait_for_timeout(1500)
    print('list:', page.inner_text('.hm-pf-view p.small.muted >> nth=1')[:100], page.locator('.hm-pf-person').count())
    first = page.locator('.hm-pf-person').first.inner_text(); print('first', first)
    page.locator('.hm-pf-person').nth(2).click(); settle(); p = prof(); print('picked', p['label'], round(p['st']*1000), p['msg'], 'stature in label?')
    # next to the last page
    for i in range(3): page.click('button:has-text("Next")'); page.wait_for_timeout(500)
    print('page text', page.inner_text('.hm-pf-pager'))
    # go to the last page by hammering
    for i in range(200):
        b = page.locator('button:has-text("Next")')
        if b.is_disabled(): break
        b.click(); page.wait_for_timeout(60)
    print('last page', page.inner_text('.hm-pf-pager'), page.locator('.hm-pf-person').count(), page.inner_text('.hm-pf-view p.small.muted >> nth=1'))
    # missing-mass person?
    page.evaluate("[...document.querySelectorAll('.hm-pf-view select')][0].value")
    # dataset/sex switch
    for ds in range(4):
        page.select_option('.hm-pf-view select >> nth=0', index=ds); page.wait_for_timeout(1200)
        sx = page.evaluate("[...document.querySelectorAll('.hm-pf-view select')].map(s=>[s.value,[...s.options].map(o=>o.text)])")
        print('dataset', ds, sx[0][0], 'sex', sx[1], 'branch', sx[2][1][:4] if len(sx) > 2 else None, page.inner_text('.hm-pf-view p.small.muted >> nth=0')[:50], 'rows', page.locator('.hm-pf-person').count())
    # random
    page.click('.hm-pf-view button:has-text("Random")'); page.wait_for_timeout(500)
    page.click('button:has-text("Pick a random person")'); settle(); p = prof(); print('random', p['label'], p['msg'])
    # race: click two persons quickly
    page.click('.hm-pf-view button:has-text("From a list")'); page.wait_for_timeout(1500)
    page.evaluate("()=>{const b=document.querySelectorAll('.hm-pf-person'); b[3].click(); b[7].click();}")
    settle(); p = prof(); print('race ->', p['label'], p['msg'], 'wanted #' , page.evaluate("[...document.querySelectorAll('.hm-pf-person')][7]?.textContent"))
    print('errors', [l[:200] for l in logs if l.startswith('[error]') or l.startswith('[pageerror]')])
