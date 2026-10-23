"""Browser tests of the MIL-STD-1472H tags (site/js/human/mil1472.js, compliance.js) on the real site: the library cards and the current posture in the Posture tab,
the object rows and the selected object in the Scene tab, the compliance section of the Analysis tab. Headless Chromium with WebGL (SwiftShader).

    python -m pytest tests/human3d/test_mil1472.py -q
    REQUIRE_BROWSER=1 python -m pytest tests/human3d/test_mil1472.py     # fail instead of skip when Playwright / Chromium / WebGL / the data is missing
    HM_SHOTS=/some/dir ...                                                 # also save screenshots there
"""
import os
import sys
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from test_place_analysis import make_session, server, chromium, SHOTS  # noqa: E402,F401  (fixtures and helpers shared with the placing tests; run this file on its own, like the other browser test files)

ED = "window.__human.state.postureEditor"
SB = "window.__human.state.sandbox"


def boot(s):
    s.boot()
    s.page.get_by_role("tab", name="Posture").click()
    s.page.wait_for_selector(".hm-pe-card", timeout=60000)
    return s


def shot(s, name, selector=None):
    if not SHOTS:
        return
    Path(SHOTS).mkdir(parents=True, exist_ok=True)
    s.page.add_style_tag(content=".hm-left{max-height:none!important;overflow:visible!important}.hm-panels{overflow:visible!important}")
    (s.page.locator(selector) if selector else s.page).screenshot(path=str(Path(SHOTS) / f"mil1472-{name}.png"))


@pytest.fixture
def s(chromium, server):
    with make_session(chromium, server) as sess:
        yield sess


def test_library_cards_and_the_current_posture_carry_a_1472h_tag(s):
    boot(s)
    p = s.page
    p.wait_for_function("[...document.querySelectorAll('.hm-pe-card .hm-pe-mil')].some((e) => ['compliant', 'check', 'not-compliant'].includes(e.dataset.state))", timeout=60000)
    tags = s.js("[...document.querySelectorAll('.hm-pe-card .hm-pe-mil')].filter((e) => e.dataset.state && e.dataset.state !== 'none').map((e) => [e.textContent, e.dataset.state, e.title])")
    assert tags, "no card has a tag"
    for text, state, title in tags:
        assert text.startswith("1472H"), text
        assert "MIL-STD-1472H" in title and ("5.8.4.3" in title or "5.20" in title), title
    # the stoop lift of 15 kg: not compliant with the lifting equation
    s.js(f"{ED}.apply('lift-stoop-start')")
    s.settle(600)
    chip = p.locator(".hm-pe-cur .hm-pe-mil")
    chip.wait_for(state="visible", timeout=20000)
    p.wait_for_function("document.querySelector('.hm-pe-cur .hm-pe-mil').dataset.state === 'not-compliant'", timeout=20000)
    assert "Not compliant" in chip.inner_text()
    assert "5.20.3.3" in chip.get_attribute("title")
    box = p.locator(".hm-pe-milbox")
    box.evaluate("e => { e.open = true; }")
    assert "5.20.3.3" in box.inner_text()
    shot(s, "posture")
    assert not s.errors(), s.errors()


def test_scene_rows_the_selected_object_and_the_analysis_section(s):
    boot(s)
    p = s.page
    p.get_by_role("tab", name="Scene").click()
    p.wait_for_selector(".hm-sc", timeout=60000)
    ids = s.js(f"""() => {{ const sb = {SB};
      const st = sb.add('stairs', {{ position: [1.5, 0, 0], yaw: 0 }});
      const sw = sb.add('steering_wheel', {{ position: [0, 0, 0.6], yaw: 180 }});
      const cr = sb.add('crate', {{ position: [-1, 0, 0.5], yaw: 0 }}); sb.setParam(cr.id, 'mass', 30);
      return {{ st: st.id, sw: sw.id, cr: cr.id }}; }}""")
    p.wait_for_function("document.querySelectorAll('.hm-ol-row .hm-ol-mil:not([hidden])').length >= 3", timeout=20000)
    rows = s.js("Object.fromEntries([...document.querySelectorAll('.hm-ol-row')].map((r) => [r.dataset.id, [r.querySelector('.hm-ol-mil').textContent, r.querySelector('.hm-ol-mil').dataset.state, r.querySelector('.hm-ol-mil').title]]))")
    assert rows[ids["sw"]][1] == "not-compliant" and "5.1.4.1.2.5.6" in rows[ids["sw"]][2], rows[ids["sw"]]  # the 34 mm rim
    assert rows[ids["cr"]][1] == "not-compliant" and "5.20.3.2" in rows[ids["cr"]][2], rows[ids["cr"]]  # 30 kg for one lifter
    assert rows[ids["st"]][1] == "not-compliant" and "5.11.8.1.8" in rows[ids["st"]][2], rows[ids["st"]]  # the default stairs have no handrails
    # the selected object lists its clauses
    s.js(f"window.__human.ctx.select({{ kind: 'object', id: '{ids['st']}' }})")
    p.wait_for_timeout(400)
    mil = p.locator(".hm-ed-mil").first
    mil.wait_for(state="attached", timeout=10000)
    txt = mil.inner_text()
    assert "5.11.8.1.8" in txt and "Figure 86" in txt, txt
    shot(s, "scene", ".hm-left")
    # the Analysis tab: the section, the headline and the CSV
    p.get_by_role("tab", name="Analysis").click()
    p.wait_for_selector(".hm-an-mil .hm-an-milhead", timeout=30000)
    head = p.locator(".hm-an-mil .hm-an-milhead").inner_text()
    assert "Not compliant" in head, head
    groups = s.js("[...document.querySelectorAll('.hm-an-milgroup > summary')].map((e) => e.textContent)")
    assert any(g.startswith("Not compliant") and "Object: Steering wheel" in g for g in groups), groups
    assert any("Posture:" in g for g in groups), groups
    assert "MIL-STD-1472H: not compliant" in p.locator(".hm-an-verdict").inner_text()
    with p.expect_download() as dl:
        p.get_by_role("button", name="Download report (CSV)").click()
    path = dl.value.path()
    text = Path(path).read_text()
    assert "subject_kind,subject,clause" in text and "5.1.4.1.2.5.6" in text
    shot(s, "analysis", ".hm-left")
    assert not s.errors(), s.errors()
