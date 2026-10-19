import sys
sys.path.insert(0, 'tests/human3d')
from shot import browser
wait = "()=>{const c=window.__human.ctx,b=c.getBody(),p=c.getProfile();return b&&p&&b.profileId===p.id&&!window.__human.state.busy}"
with browser(1280, 900) as (page, logs):
    page.goto(page.base + '/#/human?debug')
    page.wait_for_function("window.__human && window.__human.state.rig", timeout=90000)
    page.wait_for_selector('.hm-pf .hm-pf-dimbtn', timeout=30000); page.wait_for_timeout(500)
    for unit, val in [('in', '7.5'), ('cm', '19,5'), ('mm', '1,95')]:
        page.click(f'.hm-group button:has-text("{unit}")'); page.wait_for_timeout(300)
        page.click('.hm-pf-dimbtn[data-dim="hand_length"]'); page.wait_for_timeout(200)
        li = page.locator('.hm-pf-dim.is-open')
        shown = li.locator('input.hm-pf-edit').input_value(); print(unit, 'field shows', shown, '| row', li.locator('.hm-pf-dimval').inner_text())
        li.locator('input.hm-pf-edit').fill(val); li.locator('button:has-text("Apply")').click()
        page.wait_for_timeout(300)
        try: page.wait_for_function(wait, timeout=30000)
        except Exception: print('busy')
        page.wait_for_timeout(400)
        m = page.evaluate("(()=>{const p=window.__human.ctx.getProfile(); return [p.measures.hand_length.value, p.measures.hand_length.status, window.__human.ctx.getBody().dims.find(d=>d.id==='hand_length').value]})()")
        print('  after edit', val, unit, '->', m, '| msg:', page.evaluate("document.querySelector('.hm-pf-dim.is-open .hm-pf-msg')?.textContent"), '|status', page.inner_text('.hm-pf-status')[:80])
        page.locator('.hm-pf-dim.is-open button:has-text("Revert")').click(); page.wait_for_timeout(300)
        try: page.wait_for_function(wait, timeout=30000)
        except Exception: print('busy')
        page.wait_for_timeout(300)
        print('  after revert', page.evaluate("[window.__human.ctx.getProfile().measures.hand_length.value, window.__human.ctx.getProfile().measures.hand_length.status, window.__human.ctx.getProfile().id]"))
        page.click('.hm-pf-dimbtn[data-dim="hand_length"]')
    print([l for l in logs if l.startswith('[pageerror]') or l.startswith('[error]')])
