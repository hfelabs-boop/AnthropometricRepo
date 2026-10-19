"""Round 3: no WebGL at all: do the Scene and Measure panels mount (or say plainly why not) without throwing?"""
import sys
sys.path.insert(0, 'tests/human3d')
import shot
from devserver import serve
from playwright.sync_api import sync_playwright
with serve() as base, sync_playwright() as p:
    b = p.chromium.launch(executable_path=shot.CHROME, args=['--disable-gpu', '--disable-webgl', '--disable-3d-apis', '--ignore-certificate-errors'])
    pg = b.new_page(viewport={'width': 1280, 'height': 900}); logs = []
    pg.on('console', lambda m: logs.append(f'[{m.type}] {m.text}')); pg.on('pageerror', lambda e: logs.append(f'[pageerror] {e}'))
    pg.goto(base + '/#/human?debug'); pg.wait_for_timeout(6000)
    for tab in ("scene", "measure"):
        pg.click(f'#hm-tab-{tab}'); pg.wait_for_timeout(2500)
        print(tab, 'mounted:', pg.locator('.hm-sc').count(), pg.locator('.hm-ms').count(), '| panel text:', pg.inner_text('[role=tabpanel]:visible')[:200].replace('\n', ' | '))
    pg.click('#hm-tab-scene'); pg.wait_for_timeout(500)
    pg.click('.hm-obj-card >> nth=0'); pg.click('.hm-obj-detail button.primary'); pg.wait_for_timeout(800)
    print('rows after add', pg.locator('.hm-ol-row').count())
    pg.click('#hm-tab-measure'); pg.wait_for_timeout(500)
    pg.screenshot(path='/tmp/claude-0/-home-user-AnthropometricRepo/47fa7a9b-9f20-5ccb-be11-268d4792d952/scratchpad/r3/nogl.png')
    print('errors', [l[:260] for l in logs if (l.startswith('[error]') or l.startswith('[pageerror]')) and 'WebGLRenderer' not in l][:8])
    b.close()
