"""Round 2: accessibility + hidden-state probes on the real tab. python tests/human3d/profile-skeleton-panels.adversarial.r2.a11y.py OUTDIR"""
import sys, json
sys.path.insert(0, 'tests/human3d')
from shot import browser
out = sys.argv[1]
AUDIT = r"""()=>{
  const res = {};
  const root = document.querySelector('#view-human');
  const vis = (e)=> !!(e.offsetParent || e.getClientRects().length) && getComputedStyle(e).visibility!=='hidden';
  // visible-but-[hidden]
  res.hiddenButShown = [...root.querySelectorAll('[hidden]')].filter(e=>getComputedStyle(e).display!=='none').map(e=>e.className||e.tagName).slice(0,10);
  // controls without accessible names
  const name = (e)=>{ const a=e.getAttribute('aria-label'); if(a) return a; const lb=e.getAttribute('aria-labelledby'); if(lb) return lb.split(' ').map(i=>document.getElementById(i)?.textContent||'').join(' ');
     if(e.id){ const l=document.querySelector(`label[for="${CSS.escape(e.id)}"]`); if(l) return l.textContent; } const p=e.closest('label'); if(p) return p.textContent; return (e.title||e.textContent||e.placeholder||'').trim(); };
  res.noName = [...root.querySelectorAll('input,select,textarea,button,[role=button],[role=treeitem]')].filter(vis).filter(e=>!name(e).trim()).map(e=>e.outerHTML.slice(0,140)).slice(0,10);
  // duplicate ids
  const ids = {}; for (const e of document.querySelectorAll('[id]')) ids[e.id]=(ids[e.id]||0)+1; res.dupIds = Object.entries(ids).filter(([k,v])=>v>1).map(([k])=>k).slice(0,10);
  // aria-controls pointing nowhere
  res.badControls = [...document.querySelectorAll('[aria-controls]')].filter(e=>!document.getElementById(e.getAttribute('aria-controls'))).map(e=>e.getAttribute('aria-controls')+':'+(e.textContent||'').slice(0,20)).slice(0,10);
  res.badLabelFor = [...document.querySelectorAll('label[for]')].filter(l=>!document.getElementById(l.getAttribute('for'))).map(l=>l.getAttribute('for')).slice(0,10);
  // too small targets (visible buttons < 24px)
  res.small = [...root.querySelectorAll('button,input[type=checkbox],input[type=radio],select')].filter(vis).filter(e=>{const r=e.getBoundingClientRect(); return r.height<24 || r.width<24}).map(e=>(e.textContent||e.type||'').trim().slice(0,20)+':'+Math.round(e.getBoundingClientRect().width)+'x'+Math.round(e.getBoundingClientRect().height)).slice(0,15);
  // horizontal overflow of any element beyond the panel
  const panel = document.querySelector('.hm-pf, .hm-sk'); const pr = panel?.getBoundingClientRect();
  res.overflowEls = pr ? [...panel.querySelectorAll('*')].filter(vis).filter(e=>{const r=e.getBoundingClientRect(); return r.right>pr.right+1 && r.width>0}).map(e=>e.className.toString().slice(0,40)+':'+Math.round(e.getBoundingClientRect().right-pr.right)).slice(0,10) : null;
  res.docScroll = [document.documentElement.scrollWidth, document.documentElement.clientWidth];
  return res;
}"""
def run(w, h, dark, tag, mobile=False):
    with browser(w, h, dark=dark, mobile=mobile) as (page, logs):
        page.goto(page.base + '/#/human?debug')
        page.wait_for_function("window.__human && window.__human.state.rig", timeout=90000)
        page.wait_for_selector('.hm-pf .hm-pf-dimbtn', timeout=30000); page.wait_for_timeout(800)
        # open everything
        page.evaluate("document.querySelectorAll('.hm-pf details').forEach(d=>d.open=true)")
        page.click('.hm-pf-dimbtn >> nth=3'); page.wait_for_timeout(200)
        print(tag, 'PROFILE', json.dumps(page.evaluate(AUDIT), indent=None)[:1800])
        page.screenshot(path=f'{out}/{tag}-profile-el.png', full_page=True)
        el = page.locator('.hm-pf')
        el.screenshot(path=f'{out}/{tag}-profile-panel.png')
        page.click('[role=tab]:has-text("Skeleton")'); page.wait_for_selector('.hm-sk'); page.wait_for_timeout(500)
        page.evaluate("document.querySelectorAll('.hm-sk details').forEach(d=>d.open=true)")
        page.click('button:has-text("Expand all")'); page.click('[data-node="j:shoulder_L"]'); page.wait_for_timeout(500)
        print(tag, 'SKELETON', json.dumps(page.evaluate(AUDIT))[:1800])
        page.locator('.hm-sk').screenshot(path=f'{out}/{tag}-skeleton-panel.png')
        page.screenshot(path=f'{out}/{tag}-skeleton-full.png', full_page=True)
        errs=[l for l in logs if l.startswith('[error]') or l.startswith('[pageerror]')]
        print(tag, 'errors', errs[:4])
run(1280, 800, False, 'ld'); run(1280, 800, True, 'dd'); run(390, 800, False, 'lm', True); run(390, 800, True, 'dm', True)
