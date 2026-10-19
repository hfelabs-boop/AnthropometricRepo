"""Round 2: no WebGL at all: do the Profile and Skeleton panels still work (profile/dim table from the fitted body, CSV button message)?"""
import sys, os
sys.path.insert(0, 'tests/human3d')
import shot
from devserver import serve
from playwright.sync_api import sync_playwright
with serve() as base, sync_playwright() as p:
    b = p.chromium.launch(executable_path=shot.CHROME, args=['--disable-gpu', '--disable-webgl', '--disable-3d-apis', '--ignore-certificate-errors'])
    pg = b.new_page(viewport={'width': 1280, 'height': 900}); logs = []
    pg.on('console', lambda m: logs.append(f'[{m.type}] {m.text}')); pg.on('pageerror', lambda e: logs.append(f'[pageerror] {e}'))
    pg.goto(base + '/#/human?debug'); pg.wait_for_timeout(6000)
    print('webgl?', pg.evaluate("!!document.createElement('canvas').getContext('webgl2')"))
    print('view text', pg.inner_text('#view-human')[:400].replace('\n', ' | '))
    print('panels mounted:', pg.locator('.hm-pf').count(), 'dim rows', pg.locator('.hm-pf-dimbtn').count(), 'harness', pg.evaluate("!!window.__human"))
    if pg.locator('.hm-pf').count():
        pg.click('[role=tab]:has-text("Skeleton")'); pg.wait_for_timeout(1500)
        print('skeleton mounted', pg.locator('.hm-sk').count())
        if pg.locator('.hm-sk').count():
            pg.click('summary:has-text("Points for CAD")'); pg.click('button:has-text("Copy as CSV")'); pg.wait_for_timeout(300); print('csv msg:', pg.inner_text('.hm-sk-csv, .hm-sk p[role=status]:not([hidden])')[:100] if pg.locator('.hm-sk p[role=status]').count() else None)
            pg.click('[data-node="j:shoulder_L"]') if pg.locator('[data-node="j:shoulder_L"]').count() else None
    print('errors', [l[:220] for l in logs if l.startswith('[error]') or l.startswith('[pageerror]')][:6])
    b.close()
