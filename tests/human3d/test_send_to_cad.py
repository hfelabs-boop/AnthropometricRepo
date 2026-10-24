"""Browser test of "Send to CAD": the Export panel (site/js/human/panels/export.js, cadlink.js) in headless Chromium pushes the figure to a LIVE anthro_service REST
server (uvicorn on a free port, a temporary profile store), and the CAD views read it back. Needs Playwright, Chromium with WebGL, fastapi and uvicorn.

    REQUIRE_BROWSER=1 python -m pytest tests/human3d/test_send_to_cad.py -q      (run it on its own, like the other browser test files)
"""
import json
import os
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path.insert(0, str(HERE))
from test_place_analysis import make_session, server, chromium  # noqa: E402,F401  (fixtures shared with the placing tests)

try:
    import fastapi  # noqa: F401
    import uvicorn  # noqa: F401
except ImportError:  # pragma: no cover
    if os.environ.get("REQUIRE_BROWSER") == "1":
        raise
    pytest.skip("fastapi / uvicorn not installed (pip install -r anthro_service/requirements.txt)", allow_module_level=True)


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture(scope="module")
def api():
    store = tempfile.mkdtemp(prefix="anthro-profiles-")
    port = free_port()
    env = {**os.environ, "ANTHRO_PROFILE_DIR": store, "PYTHONPATH": str(ROOT)}
    env.pop("ANTHRO_API_KEYS", None)
    proc = subprocess.Popen([sys.executable, "-m", "anthro_service", "serve", "--port", str(port)], cwd=ROOT, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    base = f"http://127.0.0.1:{port}"
    for _ in range(100):
        try:
            with urllib.request.urlopen(f"{base}/v1/health", timeout=1) as r:
                if r.status == 200:
                    break
        except OSError:
            time.sleep(0.2)
    else:
        proc.kill()
        pytest.fail("the REST server did not start: " + proc.stdout.read().decode(errors="replace")[-2000:])
    yield base, store
    proc.terminate()
    proc.wait(10)


def get(url):
    with urllib.request.urlopen(url, timeout=10) as r:
        return r.read().decode("utf-8")


@pytest.fixture
def s(chromium, server):
    with make_session(chromium, server) as sess:
        yield sess


def open_send(s, base, posture=None):
    s.boot()
    p = s.page
    if posture:  # the posture editor exists once the Posture tab has been opened
        p.get_by_role("tab", name="Posture").click()
        p.wait_for_selector(".hm-pe-card", timeout=60000)
        s.js(f"window.__human.state.postureEditor.apply('{posture}')")
        s.settle(500)
    p.get_by_role("tab", name="Export").click()
    p.wait_for_selector(".hm-ex", timeout=60000)
    sec = p.locator("details", has_text="Send to CAD").first
    sec.evaluate("e => { e.open = true; }")
    p.get_by_label("Server").fill(base)
    p.get_by_label("Server").dispatch_event("change")
    return p


def test_send_profile_and_posture_to_a_live_server(s, api):
    base, store = api
    p = open_send(s, base, "sit-upright-90")
    p.get_by_role("button", name="Test connection").click()
    p.wait_for_selector(".hm-ex-cadout .hm-ex-ok", timeout=20000)
    assert "Connected to anthro_service" in p.locator(".hm-ex-cadout").inner_text()
    p.get_by_role("button", name="Send profile and posture").click()
    p.wait_for_function("document.querySelector('.hm-ex-cadout .hm-ex-ok')?.textContent.startsWith('Sent')", timeout=30000)
    out = p.locator(".hm-ex-cadout").inner_text()
    assert "/values?format=csv" in out and "latest" in out, out
    # what a CAD macro reads back
    summary = json.loads(get(f"{base}/v1/profiles/latest"))
    label = s.js("window.__human.ctx.getProfile().label")
    assert summary["profile"]["label"] == label
    assert summary["profile"]["posture"]["id"] == "sit-upright-90"
    assert abs(summary["values"]["stature"] - s.js("window.__human.ctx.getProfile().measures.stature.value")) < 0.01
    csv_text = get(f"{base}/v1/profiles/latest/values?format=csv")
    assert csv_text.startswith("key,name,value,unit")
    angles = get(f"{base}/v1/profiles/latest/angles?format=csv")
    knee = [line for line in angles.splitlines() if line.startswith("knee_L,") and ",flex," in line][0]
    assert 80 < float(knee.split(",")[5]) < 100, knee  # seated upright: the knee at about 90 degrees
    assert len(list(Path(store).glob("*.meta.json"))) == 1
    assert not s.errors(), s.errors()


def test_a_server_that_is_not_running_gives_the_start_command(s, api):
    p = open_send(s, f"http://127.0.0.1:{free_port()}")
    p.get_by_role("button", name="Send profile and posture").click()
    p.wait_for_selector(".hm-ex-cadout .hm-ex-bad", timeout=30000)
    text = p.locator(".hm-ex-cadout").inner_text()
    assert "Cannot reach the server" in text and "python -m anthro_service serve" in text, text
