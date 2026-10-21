import sys
sys.path.insert(0, 'tests/human3d')
from shot import browser
with browser(1280, 900) as (page, logs):
    page.goto(page.base + '/#/human?debug')
    page.wait_for_function("window.__human && window.__human.state.rig", timeout=90000)
    page.wait_for_selector('.hm-pf .hm-pf-dimbtn', timeout=30000); page.wait_for_timeout(500)
    wait = "()=>{const c=window.__human.ctx,b=c.getBody(),p=c.getProfile();return b&&p&&b.profileId===p.id&&!window.__human.state.busy}"
    page.click('.hm-pf-dimbtn[data-dim="knee_height"]'); page.fill('input.hm-pf-edit', '520'); page.click('.hm-pf-dim.is-open button:has-text("Apply")')
    page.wait_for_function(wait, timeout=60000); page.wait_for_timeout(400)
    print('after knee edit: pid', page.evaluate("window.__human.ctx.getProfile().id"))
    page.click('.hm-pf-dimbtn[data-dim="hip_height"]'); page.wait_for_timeout(300)
    li = page.locator('.hm-pf-dim.is-open')
    print('hip_height row text:', li.inner_text().replace('\n', ' | ')[:300])
    print('has Revert:', li.locator('button:has-text("Revert")').count())
    pid0 = page.evaluate("window.__human.ctx.getProfile().id")
    if li.locator('button:has-text("Revert")').count():
        li.locator('button:has-text("Revert")').click(); page.wait_for_timeout(1500)
        print('pid changed after Revert on hip_height:', page.evaluate("window.__human.ctx.getProfile().id") != pid0, '| status:', page.inner_text('.hm-pf-status'))
        print('still edited?', page.locator('.hm-pf-dim.is-open').inner_text().count('edited'))
