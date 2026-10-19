"""Round 2: 320/360 px: every section and a long detail open, horizontal overflow of page and of any element."""
import sys
sys.path.insert(0, 'tests/human3d')
from shot import browser
for w in (320, 360):
  with browser(w, 800, mobile=True) as (page, logs):
    page.goto(page.base + '/#/human?debug')
    page.wait_for_function("window.__human && window.__human.state.rig", timeout=90000)
    page.wait_for_selector('.hm-pf .hm-pf-dimbtn', timeout=30000); page.wait_for_timeout(600)
    JS = """()=>{const out=[]; const W=document.documentElement.clientWidth; for (const e of document.querySelectorAll('#view-human *')) { if(!e.offsetParent && getComputedStyle(e).position!=='fixed') continue; const r=e.getBoundingClientRect(); if (r.width>0 && (r.right>W+1 || r.left<-1)) out.push((e.className||e.tagName).toString().slice(0,40)+' '+Math.round(r.left)+'..'+Math.round(r.right)); } return {sw:document.documentElement.scrollWidth, W, over:[...new Set(out)].slice(0,12)}}"""
    def audit(tag): print(w, tag, page.evaluate(JS))
    page.evaluate("document.querySelectorAll('.hm-pf details').forEach(d=>d.open=true)")
    for src in ['Individual', 'Import', 'Manual', 'Population']:
        page.click(f'.hm-pf-srcseg button:has-text("{src}")'); page.wait_for_timeout(1200); audit(src)
    page.evaluate("document.querySelector('.hm-pf-dimbtn[data-dim=\"femur_length\"]').click()"); page.wait_for_timeout(200); audit('dim open')
    page.evaluate("document.querySelector('summary .hm-pf-chk, .hm-pf-chk summary')?.click()"); audit('crosschecks')
    page.click('[role=tab]:has-text("Skeleton")'); page.wait_for_selector('.hm-sk'); page.wait_for_timeout(500)
    page.evaluate("document.querySelectorAll('.hm-sk details').forEach(d=>d.open=true)")
    page.click('button:has-text("Expand all")'); page.click('[data-node="j:index_mcp_L"]'); page.wait_for_timeout(500); audit('skeleton')
    page.evaluate("document.querySelectorAll('.hm-sk-src').forEach(d=>d.open=true)"); audit('rom sources open')
    print(w, 'errors', [l[:150] for l in logs if l.startswith('[pageerror]')])
