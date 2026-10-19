"""Round 2: the in-browser database fails (abort, 404, corrupt gz) and recovers on Retry; the other sources keep working."""
import sys
sys.path.insert(0, 'tests/human3d')
from shot import browser
for name, h in [('abort', lambda r: r.abort()), ('404', lambda r: r.fulfill(status=404, body='nf')), ('corrupt', lambda r: r.fulfill(status=200, body=b'not gzip at all', content_type='application/gzip')), ('cdn-abort', None)]:
  with browser(1280, 900) as (page, logs):
    if h: page.route('**/db/anthro.sqlite.gz', h)
    else: page.route('**/cdnjs.cloudflare.com/**', lambda r: r.abort())
    page.goto(page.base + '/#/human?debug')
    page.wait_for_function("window.__human && window.__human.state.rig", timeout=90000)
    page.wait_for_selector('.hm-pf .hm-pf-dimbtn', timeout=30000)
    page.click('.hm-pf-srcseg button:has-text("Individual")')
    page.wait_for_timeout(4000)
    print(name, '->', page.inner_text('.hm-pf-view')[:250].replace('\n', ' | '), '| retry buttons', page.locator('.hm-pf-view button:has-text("Retry")').count())
    page.unroute_all() if hasattr(page, 'unroute_all') else None
    if page.locator('.hm-pf-view button:has-text("Retry")').count():
        page.click('.hm-pf-view button:has-text("Retry")')
        try:
            page.wait_for_selector('.hm-pf-view select', timeout=40000); print('  recovered after Retry')
        except Exception as e: print('  not recovered:', page.inner_text('.hm-pf-view')[:200])
    page.click('.hm-pf-srcseg button:has-text("Manual")'); page.fill('.hm-pf-view input[type=text] >> nth=0', '1800'); page.press('.hm-pf-view input[type=text] >> nth=0', 'Enter')
    page.wait_for_function("window.__human.ctx.getBody()?.profileId===window.__human.ctx.getProfile()?.id && !window.__human.state.busy", timeout=40000)
    print('  manual still works:', page.evaluate("window.__human.ctx.getBody().stature"), [l[:160] for l in logs if l.startswith('[pageerror]')])
