import sys, json
sys.path.insert(0, 'tests/human3d')
from shot import browser
with browser(1280, 800) as (page, logs):
    page.goto(page.base + '/#/human?debug')
    page.wait_for_function("window.__human && window.__human.state.rig", timeout=90000)
    dialogs = []; page.on('dialog', lambda d: (dialogs.append(d.message), d.dismiss()))
    page.click('.hm-pf-srcseg button:has-text("Import")')
    payload = json.dumps({"label": "<img src=x onerror=alert(1)><b>L</b>", "sex": "M", "stature": 1755, "<img src=x onerror=alert(2)>": 300, "mass": 80, "notes": ["<script>alert(3)</script>"]})
    page.fill('.hm-pf-paste', payload); page.click('button:has-text("Use the pasted text")')
    page.wait_for_function("!window.__human.state.busy", timeout=40000); page.wait_for_timeout(500)
    page.evaluate("document.querySelectorAll('.hm-pf details').forEach(d=>d.open=true)")
    print('injected nodes in panel/stage/status:', page.evaluate("document.querySelectorAll('#view-human img[src=x], #view-human script, #view-human b').length"), 'label:', page.evaluate("window.__human.state.profile.label"))
    # filename xss via file
    open('/tmp/claude-0/-home-user-AnthropometricRepo/47fa7a9b-9f20-5ccb-be11-268d4792d952/scratchpad/imp/<img src=x onerror=alert(4)>.csv', 'w').write("key,value,unit\nstature,1755,mm\n")
    page.set_input_files('input[type=file]', '/tmp/claude-0/-home-user-AnthropometricRepo/47fa7a9b-9f20-5ccb-be11-268d4792d952/scratchpad/imp/<img src=x onerror=alert(4)>.csv')
    page.wait_for_timeout(1500)
    print('after filename', page.evaluate("document.querySelectorAll('#view-human img[src=x]').length"), page.evaluate("window.__human.state.profile.label"), 'dialogs', dialogs)
    # exported json round trip
    with page.expect_download() as d: page.click('button:has-text("Download JSON")')
    txt = open(d.value.path()).read(); print('export json ok', json.loads(txt)['format'], d.value.suggested_filename)
    with page.expect_download() as d: page.click('button:has-text("Download CSV")')
    print('export csv name', d.value.suggested_filename, open(d.value.path()).read()[:150].replace('\n', ' | '))
