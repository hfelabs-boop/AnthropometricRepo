"""Round 2: what does selecting a dimension row show in the 3D view? python ...r2.sel.py OUTDIR [dark]"""
import sys
sys.path.insert(0, 'tests/human3d')
from shot import browser
out = sys.argv[1]; dark = 'dark' in sys.argv
with browser(1280, 800, dark=dark) as (page, logs):
    page.goto(page.base + '/#/human?debug')
    page.wait_for_function("window.__human && window.__human.state.rig", timeout=90000)
    page.wait_for_selector('.hm-pf .hm-pf-dimbtn', timeout=30000); page.wait_for_timeout(500)
    page.click('button:has-text("Front")'); 
    for d in ['upper_arm_length', 'hand_length', 'knee_height', 'stature', 'foot_breadth', 'hip_halfwidth', 'ring_waist']:
        page.evaluate("(d)=>{const b=document.querySelector(`.hm-pf-dimbtn[data-dim='${d}']`); b.click();}", d)
        page.wait_for_timeout(500)
        sel = page.evaluate("window.__human.state.selection")
        disp = page.evaluate("window.__human.ctx.getRig().display")
        print(d, sel, 'landmarks' , disp['landmarks'], 'xray', disp['xray'], 'status:', page.inner_text('.hm-pf-status')[:60], '| statusbar:', page.inner_text('.hm-statusbar')[:120].replace('\n',' ') if page.locator('.hm-statusbar').count() else '')
        page.locator('.hm-stage, .hm-center, canvas').first.screenshot(path=f'{out}/sel-{"d" if dark else "l"}-{d}.png') if False else page.evaluate('window.scrollTo(0,0)'); page.screenshot(path=f'{out}/sel-{"d" if dark else "l"}-{d}.png', clip={'x':350,'y':205,'width':620,'height':570})
    page.wait_for_timeout(2300)
    print('after 2.3 s display', page.evaluate("window.__human.ctx.getRig().display"), 'state.display', page.evaluate("window.__human.state.display"))
