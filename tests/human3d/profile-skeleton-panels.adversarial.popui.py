import sys, json
sys.path.insert(0, 'tests/human3d')
from shot import browser
with browser(1280, 800) as (page, logs):
    page.goto(page.base + '/#/human?debug')
    page.wait_for_function("window.__human && window.__human.state.rig", timeout=90000)
    page.wait_for_selector('.hm-pf-view select')
    def settle():
        page.wait_for_timeout(500); page.wait_for_function("!window.__human.state.busy", timeout=60000); page.wait_for_timeout(100)
    def info(): return page.evaluate("""()=>{const p=window.__human.state.profile; return {id:p.id, label:p.label, st:Math.round(window.__human.state.body.stature*1000), notes:p.notes.length, sel:[...document.querySelectorAll('.hm-pf-view select')].map(s=>s.value), slider:document.querySelector('.hm-pf-slider input[type=range]')?.value, pressed:[...document.querySelectorAll('.hm-pf-quick button[aria-pressed=true]')].map(b=>b.textContent), ext:document.querySelector('.hm-pf-quick input[type=checkbox]')?.checked, radio:[...document.querySelectorAll('input[name=hm-pf-scaling]')].map(r=>r.checked), status:document.querySelector('.hm-pf-status').textContent.slice(0,90)}}""")
    print('start', info())
    page.click('button:has-text("P5")'); settle(); print('P5', info())
    page.click('button:has-text("P95")'); settle(); print('P95', info())
    page.check('.hm-pf-quick input[type=checkbox]'); page.wait_for_timeout(300)
    print('ext on', info())
    # slider to 99 via numeric field
    num = page.locator('.hm-pf-slider .hm-num'); num.fill('99'); num.press('Enter'); settle(); print('P99', info()['label'], info()['st'], info()['slider'])
    num.fill('150'); num.press('Enter'); settle(); print('150 typed', info()['label'], info()['slider'])
    num.fill('0'); num.press('Enter'); settle(); print('0 typed', info()['label'], info()['slider'])
    num.fill('37.6'); num.press('Enter'); settle(); print('37.6 typed', info()['label'], info()['slider'])
    page.uncheck('.hm-pf-quick input[type=checkbox]'); settle(); print('ext off from P38', info()['label'], info()['slider'])
    num.fill('99') if False else None
    page.check('.hm-pf-quick input[type=checkbox]'); num.fill('99'); num.press('Enter'); settle()
    page.uncheck('.hm-pf-quick input[type=checkbox]'); settle(); print('P99 then ext off', info()['label'], info()['slider'], info()['ext'])
    page.check('input[name=hm-pf-scaling][value=proportional]'); settle(); print('proportional', info()['label'], info()['st'], info()['radio'])
    page.check('input[name=hm-pf-scaling][value=percentile]'); settle()
    page.select_option('.hm-pf-view select >> nth=3', 'high'); settle(); print('high', info()['label'], info()['st'], page.evaluate("Object.keys(window.__human.state.profile.measures).length"))
    page.select_option('.hm-pf-view select >> nth=3', 'low'); settle(); print('low', info()['label'], page.evaluate("Object.keys(window.__human.state.profile.measures).length"))
    page.select_option('.hm-pf-view select >> nth=3', 'medium'); settle()
    page.click('.hm-pf-survey button:has-text("Latest survey")'); settle(); print('latest', info()['label'], info()['sel'], info()['st'])
    page.click('.hm-pf-survey button:has-text("Combined surveys")'); settle(); print('combined', info()['label'])
    # external profile change from elsewhere
    page.evaluate("""async()=>{const a=await import('/js/human/anthro.js'); const idx=await a.loadIndex(); const e=idx.populations.find(p=>p.country_id==='united-kingdom'); const f=await a.loadPopulation(e); await window.__human.ctx.setProfile(a.percentileProfile(f,{percentile:80, meanStature:true}),{immediate:true});}""")
    settle(); print('external', info())
    page.click('button:has-text("P50")'); settle(); print('P50 after external', info()['label'])
    print('errors', [l[:200] for l in logs if l.startswith('[error]') or l.startswith('[pageerror]')])
