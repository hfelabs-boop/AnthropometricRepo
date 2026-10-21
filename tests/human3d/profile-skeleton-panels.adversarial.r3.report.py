"""Round 3: fit report neutral and posed, real tab. python ...r3.report.py OUTDIR [dark]"""
import sys, json
sys.path.insert(0, 'tests/human3d')
from shot import browser
out = sys.argv[1]; dark = 'dark' in sys.argv
with browser(1280, 900, dark=dark) as (page, logs):
    page.goto(page.base + '/#/human?debug')
    page.wait_for_function("window.__human && window.__human.state.rig", timeout=90000)
    page.wait_for_selector('.hm-pf .hm-pf-dimbtn', timeout=30000); page.wait_for_timeout(500)
    page.evaluate("[...document.querySelectorAll('.hm-pf details.hm-section')].find(d=>/Fit report/.test(d.textContent)).open=true")
    page.wait_for_timeout(200)
    neutral = page.evaluate("""()=>[...document.querySelectorAll('.hm-pf-rrow')].map(r=>({id:r.dataset.id,status:r.dataset.status,t:r.innerText.replace(/\\n+/g,' | ')}))""")
    print('neutral rows', len(neutral)); 
    for r in neutral[:60]: print(' ', r['status'], r['t'][:150])
    print('summary:', page.inner_text('.hm-pf-repsum'))
    # seated pose
    page.evaluate("""()=>{const r=window.__human.ctx.getRig(); r.setPose({angles:{hip_L:[90,0,0],hip_R:[90,0,0],knee_L:[90,0],knee_R:[90,0]}, root:{y:0.5, z:-0.3}})}""")
    page.wait_for_timeout(300)
    page.click('button:has-text("Recompute in current pose")'); page.wait_for_timeout(500)
    posed = page.evaluate("""()=>[...document.querySelectorAll('.hm-pf-rrow')].map(r=>r.innerText.replace(/\\n+/g,' | '))""")
    bad = [p for p in posed if re.search(r'NaN|undefined|Infinity', p)] if False else [p for p in posed if any(x in p for x in ('NaN','undefined','Infinity','null'))]
    print('posed rows', len(posed), 'bad', bad[:3])
    for p in posed[:12]: print(' ', p[:200])
    print('detail:', page.inner_text('.hm-pf-repsum + p'))
    page.locator('.hm-pf-rep').first.scroll_into_view_if_needed()
    page.screenshot(path=f"{out}/r3-report-posed{'-dark' if dark else ''}.png")
    # pose change drops the columns
    page.evaluate("()=>window.__human.ctx.getRig().setPose({angles:{hip_L:[40,0,0]}})"); page.wait_for_timeout(300)
    print('after pose change in-pose cols:', page.locator('.hm-pf-rnums >> text=in this pose').count())
    print([l for l in logs if l.startswith('[pageerror]') or l.startswith('[error]')][:5])
