"""Round 2: is the outcome of a dimension edit visible where the user is working? (patched shell so the edit is applied and held)"""
import sys
from pathlib import Path
sys.path.insert(0, 'tests/human3d')
from shot import browser
t = Path('site/js/human/shell.js').read_text().replace("return m.fitBody(profile, { form: formOf(profile) });", "return m.fitBody(profile, { form: profile?.form ?? formOf(profile), overrides: profile?.overrides });")
out = sys.argv[1]
with browser(1280, 800) as (page, logs):
    page.route('**/js/human/shell.js', lambda r: r.fulfill(body=t, content_type='text/javascript'))
    page.goto(page.base + '/#/human?debug')
    page.wait_for_function("window.__human && window.__human.state.rig", timeout=90000)
    page.wait_for_selector('.hm-pf .hm-pf-dimbtn', timeout=30000); page.wait_for_timeout(500)
    page.locator('.hm-pf-dimbtn[data-dim="c7_height"]').scroll_into_view_if_needed(); page.locator('.hm-pf-dimbtn[data-dim="c7_height"]').click(); page.wait_for_timeout(200)
    inp = page.locator('.hm-pf-dimbtn[data-dim="c7_height"] ~ .hm-pf-dimdetail input.hm-pf-edit'); inp.fill('1700'); inp.press('Enter')
    page.wait_for_function("window.__human.ctx.getBody()?.profileId===window.__human.ctx.getProfile()?.id && !window.__human.state.busy", timeout=40000); page.wait_for_timeout(500)
    r = page.evaluate("""()=>{const s=document.querySelector('.hm-pf-status').getBoundingClientRect(); const sc=document.querySelector('.hm-panels').getBoundingClientRect(); const b=document.querySelector('.hm-pf-dimbtn[data-dim="c7_height"]').getBoundingClientRect();
      return {status:document.querySelector('.hm-pf-status').innerText, statusTop:s.top, statusBottom:s.bottom, panelTop:sc.top, panelBottom:sc.bottom, rowTop:b.top, inView: s.bottom>sc.top && s.top<sc.bottom, notices: window.__human.state.notices.map(n=>n.text.slice(0,100))}}""")
    print(r)
    page.screenshot(path=out + '/feedback.png')
