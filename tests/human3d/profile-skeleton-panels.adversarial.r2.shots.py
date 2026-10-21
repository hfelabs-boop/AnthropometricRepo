"""Round 2: scrolling screenshots of the Profile (dimension 4 open, extra sections open) and Skeleton panels. python ...r2.shots.py OUTDIR tag w h [dark] [mobile]"""
import sys
sys.path.insert(0, 'tests/human3d')
from shot import browser
out, tag, w, h = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4]); dark = 'dark' in sys.argv; mobile = 'mobile' in sys.argv
with browser(w, h, dark=dark, mobile=mobile) as (page, logs):
    page.goto(page.base + '/#/human?debug')
    page.wait_for_function("window.__human && window.__human.state.rig", timeout=90000)
    page.wait_for_selector('.hm-pf .hm-pf-dimbtn', timeout=30000); page.wait_for_timeout(800)
    page.evaluate("document.querySelectorAll('.hm-pf details.hm-section').forEach(d=>d.open=true)")
    page.click('.hm-pf-dimbtn[data-dim="femur_length"]'); page.wait_for_timeout(300)
    # click a joint-related dim to edit
    sc = page.evaluate_handle("""()=>{let e=document.querySelector('.hm-pf'); while(e){const s=getComputedStyle(e); if(/(auto|scroll)/.test(s.overflowY) && e.scrollHeight>e.clientHeight+5) return e; e=e.parentElement} return document.scrollingElement}""")
    tot = page.evaluate("(e)=>[e.scrollHeight,e.clientHeight, e.tagName+'.'+e.className]", sc)
    print(tag, 'scroller', tot)
    i = 0; y = 0
    while y < tot[0] and i < 40:
        page.evaluate("([e,y])=>{e.scrollTop=y}", [sc, y]); page.wait_for_timeout(120)
        page.screenshot(path=f'{out}/{tag}-pf-{i:02d}.png'); i += 1; y += max(300, tot[1]-80)
    print(tag, i, 'shots', [l for l in logs if l.startswith('[error]')][:3])
