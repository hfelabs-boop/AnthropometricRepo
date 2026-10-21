import sys
sys.path.insert(0, 'tests/human3d')
from shot import browser
out = sys.argv[1]
with browser(1280, 800, dark=True) as (page, logs):
    page.goto(page.base + '/#/human?debug')
    page.wait_for_function("window.__human && window.__human.state.rig", timeout=90000)
    page.wait_for_selector('.hm-pf-view select')
    page.evaluate("""()=>{const set=(el,v)=>{el.value=v;el.dispatchEvent(new Event('change',{bubbles:true}))}; const q=()=>[...document.querySelectorAll('.hm-pf-view select')]; set(q()[0],'belarus'); }""")
    page.wait_for_function("window.__human.state.profile.source.country_id==='belarus' && !window.__human.state.busy", timeout=40000)
    page.wait_for_timeout(500)
    page.click('summary:has-text("Fit report")'); page.wait_for_timeout(300)
    page.locator('.hm-pf-repsum').scroll_into_view_if_needed(); page.wait_for_timeout(200)
    page.screenshot(path=f'{out}/D-sparse-report.png')
    print(page.inner_text('.hm-pf-repsum'), '|', page.inner_text('.hm-pf-repsum + p'))
    page.locator('summary:has-text("Warnings and notes")').scroll_into_view_if_needed(); page.wait_for_timeout(200)
    page.screenshot(path=f'{out}/D-sparse-notes.png')
    print(page.evaluate("window.__human.state.body.warnings"))
