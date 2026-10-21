import sys
sys.path.insert(0, 'tests/human3d')
from shot import browser
wait = "()=>{const c=window.__human.ctx,b=c.getBody(),p=c.getProfile();return b&&p&&b.profileId===p.id&&!window.__human.state.busy}"
def st(page): return page.evaluate("(()=>{const p=window.__human.ctx.getProfile(); const b=window.__human.ctx.getBody(); return [p.id, p.measures.stature?.value, p.measures.mass?.value, b.stature*1000, b.mass]})()")
with browser(1280, 900) as (page, logs):
    page.goto(page.base + '/#/human?debug')
    page.wait_for_function("window.__human && window.__human.state.rig", timeout=90000)
    page.wait_for_selector('.hm-pf .hm-pf-dimbtn', timeout=30000)
    page.click('.hm-pf-srcseg button:has-text("Manual")'); page.wait_for_timeout(300)
    print('prefill', page.evaluate("[...document.querySelectorAll('.hm-pf-view input[id^=hm-pf-m]')].map(e=>e.value)"))
    sel = lambda i: page.locator(f'select[id^="hm-pf-m{i}"]')
    page.locator('input[id^="hm-pf-mst"]').fill('69'); sel('stu').select_option('in')
    page.locator('input[id^="hm-pf-mms"]').fill('176'); sel('msu').select_option('lb')
    print('slider after typing', page.evaluate("[...document.querySelectorAll('.hm-pf-mansliders input[type=range]')].map(e=>e.value)"))
    page.click('button:has-text("Build this body")'); page.wait_for_timeout(400); page.wait_for_function(wait, timeout=60000)
    print('69 in / 176 lb ->', st(page))
    # unit change without converting
    sel('stu').select_option('cm'); page.wait_for_timeout(200)
    print('after unit->cm (field unchanged 69): slider', page.evaluate("document.querySelector('.hm-pf-mansliders input[type=range]').value"), 'field', page.locator('input[id^="hm-pf-mst"]').input_value())
    page.locator('input[id^="hm-pf-mst"]').fill('180,5'); page.keyboard.press('Enter'); page.wait_for_timeout(300)
    try: page.wait_for_function(wait, timeout=60000)
    except Exception: print('busy')
    print('180,5 cm + Enter ->', st(page), 'err:', page.inner_text('.hm-pf-msg-error'))
    # slider drag via keyboard
    page.locator('.hm-pf-mansliders input[type=range]').first.focus(); page.keyboard.press('ArrowRight'); page.keyboard.press('ArrowRight'); page.wait_for_timeout(2500)
    try: page.wait_for_function(wait, timeout=60000)
    except Exception: print('busy')
    print('after 2 ArrowRight on stature slider ->', st(page), 'field', page.locator('input[id^="hm-pf-mst"]').input_value())
    # empty mass
    page.locator('input[id^="hm-pf-mms"]').fill(''); page.click('button:has-text("Build this body")'); page.wait_for_timeout(300); page.wait_for_function(wait, timeout=60000)
    print('empty mass ->', st(page), page.inner_text('.hm-pf-status'))
    # garbage
    for g in ['abc', '', '-1750', '1e3', '17 55', '١٧٥٠']:
        page.locator('input[id^="hm-pf-mst"]').fill(g); page.click('button:has-text("Build this body")'); page.wait_for_timeout(200)
        print(repr(g), '->', page.inner_text('.hm-pf-msg-error')[:100] or ('built ' + str(st(page)[3])))
        page.wait_for_timeout(300)
    print([l for l in logs if l.startswith('[pageerror]') or l.startswith('[error]')][:5])
