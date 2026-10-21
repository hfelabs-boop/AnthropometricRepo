"""Round 3: in the unpatched tab, what happens when the person edits a derived dimension or picks a body form? (shell.js passes only { form: formOf(profile) } to fitBody)"""
import sys
sys.path.insert(0, 'tests/human3d')
from shot import browser
out = sys.argv[1]
with browser(1280, 900) as (page, logs):
    page.goto(page.base + '/#/human?debug')
    page.wait_for_function("window.__human && window.__human.state.rig", timeout=90000)
    page.wait_for_selector('.hm-pf .hm-pf-dimbtn', timeout=30000); page.wait_for_timeout(500)
    page.click('.hm-pf-dimbtn[data-dim="forearm_length"]'); page.wait_for_timeout(300)
    page.fill('input.hm-pf-edit', '300'); page.click('button:has-text("Apply")')
    page.wait_for_function("()=>{const c=window.__human.ctx,b=c.getBody(),p=c.getProfile();return b&&p&&b.profileId===p.id&&!window.__human.state.busy}", timeout=60000); page.wait_for_timeout(500)
    print('status:', page.inner_text('.hm-pf-status'))
    print('result:', page.evaluate("document.querySelector('.hm-pf-result')?.innerText"))
    print('notices:', page.evaluate("window.__human.state.notices.map(n=>n.level+': '+n.text)"))
    print('forearm dim now', page.evaluate("window.__human.ctx.getBody().dims.find(d=>d.id==='forearm_length').value"))
    print('profile label', page.evaluate("window.__human.ctx.getProfile().label"), '| edited count chip', page.inner_text('.hm-pf-metertext'))
    page.screenshot(path=f'{out}/r3-inert-edit.png')
    # form
    page.click('summary:has-text("Body form")'); page.click('.hm-pf-formseg button:has-text("Female")'); page.wait_for_timeout(2500)
    print('form status:', page.inner_text('.hm-pf-status'))
    print('notices:', page.evaluate("window.__human.state.notices.map(n=>n.level+': '+n.text)"))
    print('name:', page.inner_text('.hm-pf-name'), '| facts', page.inner_text('.hm-pf-facts'))
    page.screenshot(path=f'{out}/r3-inert-form.png')
