"""Browser tests of the Profile and Skeleton panels of the Digital human tab (site/js/human/panels/profile.js and skeleton.js), on the real site:
headless Chromium with WebGL (SwiftShader), the real shell, fit.js, rig.js and the data under public/api/v1. Slow (a build takes a second or two), about
five minutes for the whole file.

    python -m pytest tests/human3d/test_profile_panel.py -q
    REQUIRE_BROWSER=1 python -m pytest tests/human3d/test_profile_panel.py   # fail instead of skip when Playwright / Chromium / WebGL / the data is missing
    HM_SHOTS=/some/dir ...                                                    # also save screenshots there
    CHROMIUM=/path/to/chrome ...                                              # default: /opt/pw-browsers/chromium (see shot.py)

The shell does not pass `profile.form` and `profile.overrides` on to fitBody yet (see the header of profile.js). The tests that need that run against a copy of
shell.js patched in the browser (a Playwright route; the file on disk is not touched) and one test checks that the panel notices when the shell drops them.
The in-browser database (sql.js from a CDN) may be unreachable in a sandbox: the individual tests then check the error and skip the rest.
"""
import contextlib
import json
import os
import re
import sys
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path.insert(0, str(HERE))
REQUIRE = os.environ.get("REQUIRE_BROWSER") == "1"
SHOTS = os.environ.get("HM_SHOTS")

try:  # noqa: SIM105
    from playwright.sync_api import sync_playwright
    import shot
    from devserver import serve
    _IMPORT_ERROR = None
except Exception as e:  # Playwright not installed
    sync_playwright = shot = serve = None
    _IMPORT_ERROR = e


def _unavailable(reason):
    if REQUIRE:
        pytest.fail(f"REQUIRE_BROWSER=1 but the browser tests cannot run: {reason}", pytrace=False)
    pytest.skip(f"browser tests skipped: {reason} (set REQUIRE_BROWSER=1 to make this a failure)", allow_module_level=True)


if _IMPORT_ERROR is not None:
    _unavailable(f"Playwright is not importable ({_IMPORT_ERROR})")
if not Path(shot.CHROME).exists():
    _unavailable(f"no Chromium at {shot.CHROME} (set CHROMIUM=/path/to/chrome)")
if not (ROOT / "public" / "api" / "v1" / "index.json").exists():
    _unavailable("public/api/v1 is not built (python scripts/build_site.py)")
for _m in ("profile", "skeleton"):
    if "comingSoon" in (ROOT / "site/js/human/panels" / f"{_m}.js").read_text():
        _unavailable(f"panels/{_m}.js is still the stub")

PATCH_OLD = "return m.fitBody(profile, { form: formOf(profile) });"
PATCH_NEW = "return m.fitBody(profile, { form: profile?.form ?? formOf(profile), overrides: profile?.overrides });"
CLIPBOARD = ["clipboard-read", "clipboard-write"]
# Console errors that are not these panels' business: the skin generator (body.js) is another engineer's module and may be mid-edit; the shell then logs
# "the skin generator (body.js) failed to load" and shows the skeleton only. Everything else counts.
OTHER_MODULES = ("the skin generator (body.js) failed to load",)


# ---------------------------------------------------------------------------------------------------------------------------------- plumbing
@pytest.fixture(scope="session")
def server():
    with serve() as base:
        yield base


@pytest.fixture(scope="session")
def chromium():
    with sync_playwright() as p:
        proxy = {"server": os.environ["HTTPS_PROXY"], "bypass": "127.0.0.1,localhost"} if os.environ.get("HTTPS_PROXY") else None
        try:
            b = p.chromium.launch(executable_path=shot.CHROME, args=shot.ARGS, proxy=proxy)
        except Exception as e:
            _unavailable(f"Chromium does not start ({e})")
        try:
            pg = b.new_page()
            ok = pg.evaluate("!!document.createElement('canvas').getContext('webgl2')")
            pg.close()
        except Exception as e:
            ok = False
            _unavailable(f"cannot probe WebGL ({e})")
        if not ok:
            b.close()
            _unavailable("this Chromium has no WebGL 2 (headless SwiftShader needs --use-angle=swiftshader)")
        yield b
        b.close()


class Session:
    def __init__(self, page, logs, base, context):
        self.page, self.logs, self.base, self.context = page, logs, base, context

    def errors(self, allow=()):
        return [ln for ln in self.logs if (ln.startswith("[error]") or ln.startswith("[pageerror]")) and not any(a in ln for a in (*OTHER_MODULES, *allow))]

    def js(self, expr, *args):
        return self.page.evaluate(expr, *args) if args else self.page.evaluate(expr)

    def open(self, tab="profile", hash_="#/human?debug", timeout=90000):
        self.page.goto(f"{self.base}/{hash_}")
        self.page.wait_for_function("window.__human && window.__human.state.rig && window.__human.viewport.renderer", timeout=timeout)
        if tab != "profile":
            self.page.get_by_role("tab", name=tab.capitalize()).click()
            self.page.wait_for_selector(".hm-sk-tree" if tab == "skeleton" else ".hm-pf", timeout=30000)
        else:
            self.page.wait_for_selector(".hm-pf .hm-pf-dimbtn", timeout=30000)
        self.built()
        return self

    def built(self, timeout=60000):
        """Wait until the figure on the stage was built from the current profile."""
        self.page.wait_for_function("""() => { const c = window.__human.ctx, b = c.getBody(), p = c.getProfile(); return !!b && !!p && b.profileId === p.id && !window.__human.state.busy; }""", timeout=timeout)
        self.page.wait_for_timeout(80)

    def stature(self):
        return self.js("window.__human.ctx.getBody().stature * 1000")

    def profile(self):
        return self.js("(() => { const p = window.__human.ctx.getProfile(); return { id: p.id, label: p.label, sex: p.sex, source: p.source, form: p.form ?? null, overrides: p.overrides ?? null, measures: Object.fromEntries(Object.entries(p.measures).map(([k, m]) => [k, [m.value, m.unit, m.status]])) }; })()")

    def source(self, name):
        self.page.get_by_role("button", name=name, exact=True).click()

    def shot(self, name, selector=None):
        if SHOTS:
            Path(SHOTS).mkdir(parents=True, exist_ok=True)
            (self.page.locator(selector) if selector else self.page).screenshot(path=str(Path(SHOTS) / f"{name}.png"))


def V(page):
    """The Digital human view only: the other views of the site have fields with the same labels (hidden, but label queries do not skip them)."""
    return page.locator("#view-human, #demo")  # (#demo: the demo page)


def patched_shell(route):
    text = (ROOT / "site/js/human/shell.js").read_text()
    assert PATCH_OLD in text, "shell.js no longer calls fitBody the way the patch expects: update PATCH_OLD / PATCH_NEW (or drop the patch if the shell reads form and overrides now)"
    route.fulfill(body=text.replace(PATCH_OLD, PATCH_NEW), content_type="text/javascript")


@contextlib.contextmanager
def make_session(chromium, server, width=1280, height=800, dark=False, mobile=False, patched=False, init=(), routes=None, reduced_motion=False):
    ctx = chromium.new_context(viewport={"width": width, "height": height}, color_scheme="dark" if dark else "light", ignore_https_errors=True, is_mobile=mobile, has_touch=mobile,
                               device_scale_factor=1, accept_downloads=True, reduced_motion="reduce" if reduced_motion else "no-preference")
    try:
        ctx.grant_permissions(CLIPBOARD, origin=server)
    except Exception:  # noqa: BLE001  (a Chromium without these permissions: the copy test falls back to the download)
        pass
    page = ctx.new_page()
    logs = []
    page.on("console", lambda m: logs.append(f"[{m.type}] {m.text}"))
    page.on("pageerror", lambda e: logs.append(f"[pageerror] {e}"))
    for script in init:
        page.add_init_script(script)
    if patched:
        page.route("**/js/human/shell.js", patched_shell)
    for pattern, handler in (routes or {}).items():
        page.route(pattern, handler)
    try:
        yield Session(page, logs, server, ctx)
    finally:
        ctx.close()


@pytest.fixture
def s(chromium, server):
    with make_session(chromium, server) as sess:
        yield sess


@pytest.fixture
def sp(chromium, server):
    """A session on a shell that passes `form` and `overrides` on to fitBody."""
    with make_session(chromium, server, patched=True) as sess:
        yield sess


# ---------------------------------------------------------------------------------------------------------------------------------- population
def set_percentile(s, value):
    num = s.page.locator(".hm-pf-slider .hm-num")
    num.fill(str(value))
    num.press("Enter")


def test_population_controls_change_the_figure(s):
    s.open()
    p = s.page
    assert s.profile()["source"]["kind"] == "population"
    assert 1745 < s.stature() < 1755, "the default figure is the US Army man at P50"
    assert "P50" in s.profile()["label"]
    # the lists offer every country and only roles and sexes that exist
    countries = V(p).get_by_label("Country").locator("option").all_inner_texts()
    assert len(countries) > 30 and "United States" in countries
    assert "Army" in V(p).get_by_label("Branch or role").locator("option").all_inner_texts()
    # percentile: P95 is taller, P5 shorter, the quick buttons work
    set_percentile(s, 95)
    p.wait_for_function("window.__human.ctx.getProfile().source.percentile === 95")
    s.built()
    st95 = s.stature()
    assert st95 > 1850
    p.get_by_role("button", name="P5", exact=True).click()
    p.wait_for_function("window.__human.ctx.getProfile().source.percentile === 5")
    s.built()
    st5 = s.stature()
    assert st5 < 1650 and st5 < st95 - 150
    assert p.get_by_role("button", name="P5", exact=True).get_attribute("aria-pressed") == "true"
    p.get_by_role("button", name="P50", exact=True).click()
    s.built()
    assert 1745 < s.stature() < 1755
    # extended 1-99: the slider widens and the profile says it is extrapolated
    V(p).get_by_label("Extended 1 to 99 (extrapolated)").check()
    assert p.locator(".hm-pf-slider input[type=range]").get_attribute("max") == "99"
    set_percentile(s, 99)
    p.wait_for_function("window.__human.ctx.getProfile().source.percentile === 99")
    s.built()
    assert s.stature() > st95
    assert any("extrapolated" in n for n in s.js("window.__human.ctx.getProfile().notes")), "the notes say the values are extrapolated"
    V(p).get_by_label("Extended 1 to 99 (extrapolated)").uncheck()
    p.wait_for_function("window.__human.ctx.getProfile().source.percentile === 95")  # back inside 5 to 95
    assert p.locator(".hm-pf-slider input[type=range]").get_attribute("max") == "95"
    # scaling: proportional keeps the stature of the percentile but not the mass of the boundary case
    s.built()
    mass_boundary = s.js("window.__human.ctx.getBody().mass")
    V(p).get_by_label("Typical person of this stature (proportional)", exact=False).check()
    p.wait_for_function("window.__human.ctx.getProfile().source.scaling === 'proportional'")
    s.built()
    assert abs(s.stature() - st95) < 1.0
    assert abs(s.js("window.__human.ctx.getBody().mass") - mass_boundary) > 0.5
    # reliability filter: high only leaves fewer measures
    n_medium = len(s.profile()["measures"])
    V(p).get_by_label("Reliability filter").select_option("high")
    p.wait_for_function("window.__human.ctx.getProfile().source.minReliability === 'high'")
    s.built()
    assert len(s.profile()["measures"]) < n_medium
    # survey: latest only when the population has one (US Army men do)
    assert p.get_by_role("button", name="Latest survey").count() == 1
    p.get_by_role("button", name="Latest survey").click()
    p.wait_for_function("!!window.__human.ctx.getProfile().source.survey")
    s.built()
    assert "ANSUR II" in json.dumps(s.profile()["source"]["survey"])
    # sex: women are shorter
    p.get_by_role("button", name="Combined surveys").click()
    p.wait_for_function("!window.__human.ctx.getProfile().source.survey")
    V(p).get_by_label("Sex").select_option("F")
    p.wait_for_function("window.__human.ctx.getProfile().source.sex === 'F'")
    s.built()
    assert s.js("window.__human.ctx.getBody().form") == "female"
    assert s.stature() < st95 - 100
    # the last choice is remembered as three select values and nothing else
    assert json.loads(s.js("localStorage.getItem('hm-profile-last')")) == {"country": "united-states", "role": "army", "sex": "F"}
    s.shot("profile-population", ".hm-left")
    assert not s.errors()


def test_population_with_one_measure_is_mostly_estimated(s):
    s.open()
    p = s.page
    V(p).get_by_label("Country").select_option(label="Netherlands")
    p.wait_for_function("window.__human.ctx.getProfile().source.country_id === 'netherlands'")
    s.built()
    assert V(p).get_by_label("Sex").locator("option").all_inner_texts() == ["Men · 1 measure"], "only combinations that exist, with their number of measures"
    assert "Only 1 measure is published" in p.locator(".hm-pf-hint").inner_text()
    counts = s.js("(() => { const d = window.__human.ctx.getBody().dims; const c = {}; for (const x of d) c[x.status] = (c[x.status] || 0) + 1; return { total: d.length, ...c }; })()")
    assert counts["estimated"] > counts["total"] * 0.75, counts
    text = p.locator(".hm-pf-metertext").inner_text()
    assert re.search(rf"Estimated: {counts['estimated']} of {counts['total']} dimensions", text), text
    assert re.search(rf"Estimated: {counts['estimated']} of {counts['total']} dimensions", p.locator(".hm-pf-dimsum").inner_text())
    # the estimated filter lists exactly those rows
    p.get_by_role("button", name=re.compile(r"^Estimated \(")).click()
    assert p.locator(".hm-pf-dimbtn").count() == counts["estimated"]
    assert p.locator(".hm-pf-dim[data-status=estimated]").count() == counts["estimated"]
    assert not s.errors()


def test_a_population_without_a_stature_still_builds_and_proportional_scaling_explains_itself(s):
    s.open()
    p = s.page
    V(p).get_by_label("Country").select_option(label="Belarus")  # publishes a body mass index only
    p.wait_for_function("window.__human.ctx.getProfile().source.country_id === 'belarus'")
    s.built()
    assert list(s.profile()["measures"]) == ["bmi"]
    assert any("no stature" in w for w in s.js("window.__human.ctx.getBody().warnings"))
    assert any("enter one by hand" in n for n in s.js("window.__human.ctx.getProfile().notes"))
    before = s.profile()["id"]
    V(p).get_by_label("Typical person of this stature (proportional)").check()
    p.wait_for_selector(".hm-pf-status-error", timeout=30000)
    text = p.locator(".hm-pf-status").inner_text()
    assert "Proportional scaling needs a stature" in text and "Choose another way to scale" in text
    assert p.locator(".hm-pf-status").get_by_role("button", name="Retry").count() == 0, "asking again would not help"
    assert s.profile()["id"] == before, "the figure stays"
    V(p).get_by_label("Each dimension at this percentile (boundary case)").check()
    p.wait_for_function("document.querySelector('.hm-pf-status-error') === null", timeout=30000)
    assert not s.errors()


def test_inches_in_the_dimension_list_and_edits(s):
    s.open()
    p = s.page
    p.locator(".hm-bar-top").get_by_role("button", name="in", exact=True).click()
    assert re.search(r"7\.5\d in", row(s, "hand_length").inner_text()), row(s, "hand_length").inner_text()
    assert "68.87 in" in row(s, "stature").inner_text()
    row(s, "hand_length").click()
    assert "in" in p.locator(".hm-pf-editrow .hm-unit").inner_text()
    V(p).get_by_label("Set this dimension to").fill("8.5")
    V(p).get_by_label("Set this dimension to").press("Enter")
    p.wait_for_function("window.__human.ctx.getProfile().measures.hand_length.status === 'edited'", timeout=30000)
    s.built()
    assert abs(s.profile()["measures"]["hand_length"][0] - 215.9) < 1e-9
    p.locator("summary", has_text="Fit report").click()
    assert re.search(r"input 8\.5\d\d in", p.locator(".hm-pf-rrow[data-id=hand_length]").inner_text())
    assert not s.errors()


def test_rapid_slider_drags_do_not_queue_builds(s):
    s.open()
    s.js("""() => { window.__cnt = { profile: 0, rig: 0 }; const c = window.__human.ctx; c.on('profile', () => window.__cnt.profile++); c.on('rig', () => window.__cnt.rig++); }""")
    fetches_before = s.js("performance.getEntriesByType('resource').filter(e => e.name.includes('/populations/')).length")
    s.js("""async () => {
        const r = document.querySelector('.hm-pf-slider input[type=range]');
        for (let v = 40; v <= 80; v++) { r.value = String(v); r.dispatchEvent(new Event('input', { bubbles: true })); await new Promise(res => setTimeout(res, 12)); }
        r.dispatchEvent(new Event('change', { bubbles: true }));
    }""")
    s.page.wait_for_function("window.__human.ctx.getProfile().source.percentile === 80", timeout=30000)
    s.built()
    cnt = s.js("window.__cnt")
    assert cnt["profile"] <= 4, f"41 slider steps made {cnt['profile']} profiles"
    assert cnt["rig"] <= 4, f"41 slider steps made {cnt['rig']} rebuilds"
    assert s.js("performance.getEntriesByType('resource').filter(e => e.name.includes('/populations/')).length") == fetches_before, "the population file is not fetched again for a percentile"
    expected = s.js("""async () => { const a = await import('/js/human/anthro.js'); const idx = await a.loadIndex(); const e = idx.populations.find(p => p.country_id === 'united-states' && p.role_id === 'army' && p.sex === 'M');
        return a.percentileProfile(await a.loadPopulation(e), { percentile: 80, meanStature: true }).measures.stature.value; }""")
    assert abs(s.stature() - expected) < 0.01, "the figure shows the last percentile, not an earlier one"
    assert not s.errors()


def test_a_slow_earlier_load_never_overwrites_a_newer_choice(chromium, server):
    delay = """(() => { const f = window.fetch.bind(window); window.fetch = async (u, ...r) => { const d = (window.__delay || []).find(x => String(u).includes(x[0])); if (d) await new Promise(res => setTimeout(res, d[1])); return f(u, ...r); }; })();"""
    with make_session(chromium, server, init=[delay]) as s:
        s.open()
        p = s.page
        s.js("window.__delay = [['/populations/canada/', 4000]]")
        V(p).get_by_label("Country").select_option(label="Canada")
        p.wait_for_timeout(600)  # the Canadian file is on its way (slowly)
        V(p).get_by_label("Country").select_option(label="Netherlands")
        p.wait_for_function("window.__human.ctx.getProfile().source.country_id === 'netherlands'", timeout=30000)
        s.built()
        p.wait_for_timeout(4500)  # the Canadian file arrives now
        s.built()
        assert s.profile()["source"]["country_id"] == "netherlands", s.profile()["label"]
        assert "Netherlands" in p.locator(".hm-pf-status").inner_text() or "Netherlands" in s.profile()["label"]
        assert not s.errors()


def test_offline_index_and_missing_file_show_errors_with_retry(chromium, server):
    block = {"on": True}

    def index_route(route):
        if block["on"]:
            route.abort()
        else:
            route.continue_()

    def missing(route):
        route.fulfill(status=404, body="not found", content_type="text/plain")

    with make_session(chromium, server, routes={"**/api/v1/index.json": index_route}) as s:
        s.open()
        p = s.page
        # the shell could not load the default population either and started from a manual man, so the panel opens on Manual; go to Population
        assert s.profile()["source"]["kind"] == "manual"
        s.source("Population")
        # the list of populations cannot be loaded: a clear message, Retry, and the other sources still there
        p.wait_for_selector(".hm-pf-view .notice", timeout=30000)
        assert "list of populations could not be loaded" in p.locator(".hm-pf-view").inner_text()
        assert p.get_by_role("button", name="Manual", exact=True).is_enabled()
        block["on"] = False
        p.locator(".hm-pf-view").get_by_role("button", name="Retry").click()
        p.wait_for_selector("select#" + V(p).get_by_label("Country").get_attribute("id"), timeout=30000)
        assert V(p).get_by_label("Country").locator("option").count() > 30
        # a population file that is missing (404): the message names it, the figure stays, Retry asks again
        before = s.profile()["id"]
        p.route("**/populations/united-states/army/F.json", missing)
        V(p).get_by_label("Country").select_option("united-states")
        V(p).get_by_label("Branch or role").select_option("army")
        V(p).get_by_label("Sex").select_option("F")
        p.wait_for_selector(".hm-pf-status-error", timeout=30000)
        assert "No data file for United States / Army / F" in p.locator(".hm-pf-status").inner_text()
        assert s.profile()["id"] == before
        p.unroute("**/populations/united-states/army/F.json")
        p.locator(".hm-pf-status").get_by_role("button", name="Retry").click()
        p.wait_for_function("window.__human.ctx.getProfile().source.sex === 'F'", timeout=30000)
        s.built()
        s.shot("profile-error-retry", ".hm-left")
        assert not s.errors(allow=("Failed to load resource", "ERR_FAILED", "404"))


# ---------------------------------------------------------------------------------------------------------------------------------- individual
def test_individual_from_the_database(s):
    s.open()
    p = s.page
    s.source("Individual")
    p.wait_for_function("document.querySelector('.hm-pf-view .loading') === null", timeout=90000)
    if p.locator(".hm-pf-view .notice").count():
        # sql.js (a CDN script) or the 5 MB database could not be loaded in this environment: the error is clear and the rest of the tab works
        text = p.locator(".hm-pf-view").inner_text()
        assert "database could not be loaded" in text and "population, import and manual sources work without it" in text
        assert p.locator(".hm-pf-view").get_by_role("button", name="Retry").count() == 1
        s.source("Manual")
        assert V(p).get_by_label("Stature", exact=True).is_visible()
        pytest.skip("the in-browser database cannot be loaded here (sql.js from the CDN); checked the error state only")
    # survey, sex, branch pickers with the real counts
    assert "ANSUR 1988" in V(p).get_by_label("Survey", exact=True).locator("option").all_inner_texts()[0]
    assert re.search(r"[\d,]+ people with a stature", p.locator(".hm-pf-view").inner_text())
    # closest to a stature and mass
    s.source("Individual")
    V(p).get_by_label(re.compile(r"^Stature \(mm\)")).fill("1900")
    V(p).get_by_label("Mass (kg), optional").fill("95")
    p.get_by_role("button", name="Find the closest person").click()
    p.wait_for_function("window.__human.ctx.getProfile().source.kind === 'individual'", timeout=60000)
    s.built()
    prof = s.profile()
    assert abs(s.stature() - 1900) < 40
    assert set(prof["source"]) == {"kind", "dataset", "subject_key", "sex", "branch"}, "people stay anonymous"
    assert re.search(r"person #\d+", prof["label"])
    msg = p.locator(".hm-pf-msg-ok").inner_text()
    assert f"person #{prof['source']['subject_key']}" in msg and "you asked for 1,900 mm" in msg
    # a different sex: the pickers follow
    V(p).get_by_label("Sex", exact=True).select_option("F")
    p.wait_for_timeout(400)
    # the list: paged, shortest first, a click loads the person
    p.get_by_role("button", name="From a list").click()
    p.wait_for_selector(".hm-pf-person", timeout=30000)
    assert p.locator(".hm-pf-person").count() == 20
    first = p.locator(".hm-pf-person").first.inner_text()
    assert re.match(r"#\d+ · [\d,]+ mm · [\d.]+ kg", first), first
    assert "Page 1 of" in p.locator(".hm-pf-pager").inner_text()
    assert p.get_by_role("button", name="Previous").is_disabled()
    p.get_by_role("button", name="Next").click()
    p.wait_for_function("document.querySelector('.hm-pf-pager').innerText.includes('Page 2 of')")
    assert p.locator(".hm-pf-person").first.inner_text() != first
    key = re.match(r"#(\d+)", p.locator(".hm-pf-person").nth(3).inner_text()).group(1)
    p.locator(".hm-pf-person").nth(3).click()
    p.wait_for_function(f"window.__human.ctx.getProfile().source.subject_key === {key}", timeout=60000)
    s.built()
    # random
    p.get_by_role("button", name="Random", exact=True).click()
    p.get_by_role("button", name="Pick a random person").click()
    p.wait_for_function(f"window.__human.ctx.getProfile().source.kind === 'individual' && window.__human.ctx.getProfile().source.subject_key !== {key}", timeout=60000)
    s.built()
    s.shot("profile-individual", ".hm-left")
    assert not s.errors()


def test_database_blocked_shows_a_clear_error_and_population_still_works(chromium, server):
    with make_session(chromium, server, routes={"**/sql-wasm.js": lambda r: r.abort()}) as s:
        s.open()
        p = s.page
        s.source("Individual")
        p.wait_for_selector(".hm-pf-view .notice", timeout=60000)
        text = p.locator(".hm-pf-view").inner_text()
        assert "The database could not be loaded (sql.js failed to load" in text, text
        assert "population, import and manual sources work without it" in text
        s.source("Population")
        set_percentile(s, 90)
        p.wait_for_function("window.__human.ctx.getProfile().source.percentile === 90")
        s.built()
        assert not s.errors(allow=("sql-wasm", "ERR_FAILED", "Failed to load resource", "sql.js"))


# ---------------------------------------------------------------------------------------------------------------------------------- import
def test_import_files_text_drop_and_export(s, tmp_path):
    s.open()
    p = s.page
    s.source("Import")
    api = ROOT / "public/api/v1/populations/united-states/army"
    # the API's own populations file
    p.set_input_files("input[type=file]", str(api / "M.json"))
    p.wait_for_function("window.__human.ctx.getProfile().source.kind === 'import'", timeout=30000)
    s.built()
    prof = s.profile()
    assert prof["source"]["format"] == "populations-json" and len(prof["measures"]) > 100 and 1740 < prof["measures"]["stature"][0] < 1760
    assert re.search(r"Read \d+ measures from “M.json”", p.locator(".hm-pf-msg-ok").inner_text())
    # the populations CSV, then pasted text
    p.set_input_files("input[type=file]", str(api / "F.csv"))
    p.wait_for_function("window.__human.ctx.getProfile().source.filename === 'F.csv'", timeout=30000)
    s.built()
    assert s.js("window.__human.ctx.getBody().form") in ("male", "female")
    V(p).get_by_label("Or paste JSON or CSV").fill("key,value,unit\nstature,1820,mm\nmass,88,kg\nhand_length,205,mm\n")
    p.get_by_role("button", name="Use the pasted text").click()
    p.wait_for_function("window.__human.ctx.getProfile().measures.hand_length?.value === 205", timeout=30000)
    s.built()
    assert abs(s.stature() - 1820) < 0.01
    assert "pasted text" in p.locator(".hm-pf-msg-ok").inner_text()
    # drag and drop of a file
    s.js("""() => { const dt = new DataTransfer(); dt.items.add(new File(['{"stature": "1.93 m", "mass": "101 kg", "sex": "F"}'], 'dropped.json', { type: 'application/json' }));
        const z = document.querySelector('.hm-pf-drop'); z.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true, cancelable: true })); z.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true })); }""")
    p.wait_for_function("window.__human.ctx.getProfile().source.filename === 'dropped.json'", timeout=30000)
    s.built()
    assert abs(s.stature() - 1930) < 0.01 and s.js("window.__human.ctx.getBody().form") == "female"
    # clear errors, never a thrown exception
    bad = tmp_path / "sheet.xlsx"
    bad.write_bytes(b"PK\x03\x04")
    p.set_input_files("input[type=file]", str(bad))
    assert "Only JSON and CSV files can be imported" in p.locator(".hm-pf-importerr").inner_text()
    V(p).get_by_label("Or paste JSON or CSV").fill("{not json")
    p.get_by_role("button", name="Use the pasted text").click()
    err = p.locator(".hm-pf-importerr").inner_text()
    assert "not valid JSON" in err and "missing comma" in err
    assert p.locator(".hm-pf-importerr").get_attribute("role") == "alert"
    V(p).get_by_label("Or paste JSON or CSV").fill("key,value\nmass,80")
    p.get_by_role("button", name="Use the pasted text").click()
    assert "no stature" in p.locator(".hm-pf-importerr").inner_text().lower() and "stature,1750,mm" in p.locator(".hm-pf-importerr").inner_text()
    V(p).get_by_label("Or paste JSON or CSV").fill("key,value\nstature,12 m")
    p.get_by_role("button", name="Use the pasted text").click()
    assert "unit" in p.locator(".hm-pf-importerr").inner_text()
    assert abs(s.stature() - 1930) < 0.01, "a failed import leaves the figure alone"
    s.shot("profile-import-error", ".hm-left")
    # examples and export
    with p.expect_download() as d:
        p.get_by_role("button", name="Download an example CSV").click()
    assert d.value.suggested_filename == "digital-human-example.csv"
    assert "stature,1755,mm" in Path(d.value.path()).read_text()
    with p.expect_download() as d:
        p.get_by_role("button", name="Download an example JSON").click()
    assert json.loads(Path(d.value.path()).read_text())["sex"] == "M"
    with p.expect_download() as d:
        p.get_by_role("button", name="Download JSON").click()
    data = json.loads(Path(d.value.path()).read_text())
    assert data["format"] == "digital-human-profile" and data["measures"]["stature"]["value"] == 1930
    with p.expect_download() as d:
        p.get_by_role("button", name="Download CSV").click()
    assert "stature,1930,mm" in Path(d.value.path()).read_text()
    assert not s.errors()


# ---------------------------------------------------------------------------------------------------------------------------------- manual
def test_manual_entry(s):
    s.open()
    p = s.page
    s.source("Manual")
    V(p).get_by_label("Stature", exact=True).fill("2000")
    V(p).get_by_label("Body mass (optional)").fill("100")
    p.get_by_role("button", name="Build this body").click()
    p.wait_for_function("window.__human.ctx.getProfile().source.kind === 'manual'", timeout=30000)
    s.built()
    assert abs(s.stature() - 2000) < 0.01
    assert s.profile()["measures"]["stature"][0] == 2000
    est = s.js("window.__human.ctx.getBody().dims.filter(d => d.status === 'estimated').length")
    assert est > 40, "everything but stature and mass is estimated"
    assert re.search(r"Estimated: \d+ of \d+ dimensions", p.locator(".hm-pf-metertext").inner_text())
    # units: inches and pounds
    V(p).get_by_label("Stature unit").select_option("in")
    V(p).get_by_label("Stature", exact=True).fill("70")
    V(p).get_by_label("Mass unit").select_option("lb")
    V(p).get_by_label("Body mass (optional)").fill("180")
    V(p).get_by_label("Sex").select_option("F")
    p.get_by_role("button", name="Build this body").click()
    p.wait_for_function("Math.abs(window.__human.ctx.getProfile().measures.stature.value - 1778) < 0.5", timeout=30000)
    s.built()
    assert abs(s.stature() - 1778) < 0.5 and abs(s.js("window.__human.ctx.getBody().mass") - 81.647) < 0.01
    assert s.js("window.__human.ctx.getBody().form") == "female"
    # nonsense is explained and changes nothing
    before = s.profile()["id"]
    V(p).get_by_label("Stature unit").select_option("mm")
    V(p).get_by_label("Stature", exact=True).fill("175")
    p.get_by_role("button", name="Build this body").click()
    assert "outside the 1,300 to 2,500 mm" in p.locator(".hm-pf-msg-error").inner_text()
    V(p).get_by_label("Stature", exact=True).fill("")
    p.get_by_role("button", name="Build this body").click()
    assert "Enter the stature as a number" in p.locator(".hm-pf-msg-error").inner_text()
    assert s.profile()["id"] == before
    assert not s.errors()


# ---------------------------------------------------------------------------------------------------------------------------------- dimensions and the fit report
def row(s, dim_id):
    return s.page.locator(f"button[data-dim={dim_id}]")


def test_dimension_table_filters_search_and_selection(s):
    s.open()
    p = s.page
    total = s.js("window.__human.ctx.getBody().dims.length")
    assert p.locator(".hm-pf-dimbtn").count() == total == 53
    assert [h.lower() for h in p.locator(".hm-pf-grp").all_inner_texts()][0].startswith("overall")
    assert p.locator(".hm-pf-grp").count() == 8
    # every row shows value, status chip and where it came from
    assert re.search(r"1,749 mm", row(s, "stature").inner_text()) and "measured" in row(s, "stature").inner_text()
    assert re.search(r"[\d,]+ mm", row(s, "femur_length").inner_text()) and "from Trochanterion height" in row(s, "femur_length").inner_text()
    # filter chips
    chip = lambda name: p.get_by_role("button", name=re.compile(rf"^{name} \("))  # noqa: E731
    n_measured = s.js("window.__human.ctx.getBody().dims.filter(d => d.status === 'measured').length")
    chip("Measured").click()
    assert p.locator(".hm-pf-dimbtn").count() == n_measured
    assert chip("Measured").get_attribute("aria-pressed") == "true" and chip("All").get_attribute("aria-pressed") == "false"
    assert chip("Edited").is_disabled(), "nothing is edited yet"
    chip("All").click()
    V(p).get_by_label("Search dimensions").fill("thigh")
    names = p.locator(".hm-pf-dimname").all_inner_texts()
    assert 0 < len(names) < 20 and any("Thigh" in n for n in names)
    ids = p.locator(".hm-pf-dimbtn").evaluate_all("els => els.map(e => e.dataset.dim)")
    assert "femur_length" in ids and "stature" not in ids
    V(p).get_by_label("Search dimensions").fill("zzzz")
    assert "No dimension matches" in p.locator(".hm-pf-dims").inner_text()
    V(p).get_by_label("Search dimensions").fill("")
    # click a row: it opens, selects what it drives (a joint here, a landmark below) and says where the value came from
    row(s, "femur_length").click()
    assert row(s, "femur_length").get_attribute("aria-expanded") == "true"
    assert s.js("window.__human.state.selection") == {"kind": "joint", "id": "knee_L"}
    assert s.js("window.__human.state.rig.selected") == "knee_L"
    detail = p.locator(".hm-pf-dimdetail").text_content()  # text_content: the captions are upper-cased by CSS, inner_text would see that
    assert "Measures used" in detail and "Trochanterion height" in detail and "Other routes" in detail
    row(s, "hand_length").click()
    assert s.js("window.__human.state.selection") == {"kind": "landmark", "id": "dactylion_L"}
    assert row(s, "femur_length").get_attribute("aria-expanded") == "false", "one row open at a time"
    # a derived-only dimension refuses an edit and points to what it is made of
    row(s, "trunk_length").click()
    assert "Computed from other dimensions" in p.locator(".hm-pf-dimdetail").text_content()
    p.locator(".hm-pf-dimdetail").get_by_role("button", name=re.compile("C7")).click()
    assert row(s, "c7_height").get_attribute("aria-expanded") == "true"
    assert s.js("window.__human.state.selection") == {"kind": "joint", "id": "C7"}
    # hovering a row emphasises its joint in 3D
    row(s, "ankle_height").hover()
    assert s.js("window.__human.state.rig.highlighted") == "ankle_L"
    p.mouse.move(5, 5)
    assert s.js("window.__human.state.rig.highlighted") is None
    s.shot("profile-dimension-detail", ".hm-left")
    assert not s.errors()


def test_editing_a_measure_changes_the_fit_report_and_reverts(s):
    s.open()
    p = s.page
    before_report = s.js("window.__human.ctx.getBody().report.find(r => r.id === 'hand_length')")
    row(s, "hand_length").click()
    V(p).get_by_label("Set this dimension to").fill("215.5")
    V(p).get_by_label("Set this dimension to").press("Enter")
    p.wait_for_function("window.__human.ctx.getProfile().measures.hand_length.status === 'edited'", timeout=30000)
    s.built()
    prof = s.profile()
    assert prof["measures"]["hand_length"][:2] == [215.5, "mm"] and prof["label"].endswith("(edited)")
    after = s.js("window.__human.ctx.getBody().report.find(r => r.id === 'hand_length')")
    assert abs(after["input"] - 215.5) < 1e-6 and abs(before_report["input"] - 215.5) > 5, "the report compares with the edited value"
    assert abs(s.js("window.__human.ctx.getBody().d.hand_length") - 0.2155) < 1e-9
    # the table marks it, the chip counts it, the row stays open and focus is kept
    assert row(s, "hand_length").get_attribute("aria-expanded") == "true"
    assert "edited" in row(s, "hand_length").inner_text()
    assert p.get_by_role("button", name=re.compile(r"^Edited \(1\)")).is_enabled()
    assert s.js("document.activeElement?.dataset?.focusKey") == "edit:hand_length"
    # the report section shows the new input
    p.locator("summary", has_text="Fit report").click()
    assert "input 215.5 mm" in p.locator(".hm-pf-rrow[data-id=hand_length]").inner_text()
    # the mass: kilograms
    row(s, "mass").click()
    V(p).get_by_label("Set the mass to").fill("90")
    p.get_by_role("button", name="Apply").click()
    p.wait_for_function("window.__human.ctx.getProfile().measures.mass.status === 'edited'", timeout=30000)
    s.built()
    assert abs(s.js("window.__human.ctx.getBody().mass") - 90) < 0.01
    # revert one, then the rest
    row(s, "hand_length").click()
    p.get_by_role("button", name="Revert", exact=True).click()
    p.wait_for_function("window.__human.ctx.getProfile().measures.hand_length.status !== 'edited'", timeout=30000)
    s.built()
    assert abs(s.js("window.__human.ctx.getBody().d.hand_length") - 0.1915) < 0.001
    p.get_by_role("button", name="Revert all edits").click()
    p.wait_for_function("!window.__human.ctx.getProfile().label.includes('(edited)')", timeout=30000)
    s.built()
    assert s.profile()["id"].startswith("pop:united-states/army/M@p50") and "~" not in s.profile()["id"]
    assert p.get_by_role("button", name="Revert all edits").is_hidden()
    # a value the data refuses is explained next to the field
    row(s, "stature").click()
    V(p).get_by_label("Set this dimension to").fill("700")
    p.get_by_role("button", name="Apply").click()
    assert "outside" in p.locator(".hm-pf-editor .hm-pf-msg-error").inner_text()
    assert not s.errors()


def test_report_summary_pose_and_sorting(s):
    s.open()
    p = s.page
    p.locator("summary", has_text="Fit report").click()
    summary = p.locator(".hm-pf-repsum").inner_text()
    m = re.match(r"(\d+) of (\d+) checks within tolerance", summary)
    assert m and int(m.group(1)) <= int(m.group(2)) and int(m.group(2)) > 40, summary
    statuses = p.locator(".hm-pf-rep").first.locator(".hm-pf-rrow").evaluate_all("els => els.map(e => e.dataset.status)")
    rank = {"off": 0, "warn": 1, "ok": 2, "n/a": 3}
    assert statuses == sorted(statuses, key=lambda x: rank[x]), "problems first"
    body = s.js("window.__human.ctx.getBody().reportSummary")
    assert int(m.group(2)) == body["ok"] + body["warn"] + body["off"] + body["checks"]
    assert "ISO 7250" in p.locator(".hm-pf-rep ~ p, .hm-pf-chk ~ p").first.inner_text()  # the explanation of what the report means
    # in the seated pose the sitting height of the model is the profile's again, and the extra column appears
    s.js("() => { const r = window.__human.state.rig; r.setPose({ root: { y: r.root.y }, angles: { hip_L: [90, 0, 0], hip_R: [90, 0, 0], knee_L: [90, 0], knee_R: [90, 0] } }); }")
    p.get_by_role("button", name="Recompute in current pose").click()
    r = p.locator(".hm-pf-rrow[data-id=sitting_height]")
    text = r.inner_text()
    assert "in this pose" in text, text
    inp = float(re.search(r"input ([\d,.]+)", text).group(1).replace(",", ""))
    pose = float(re.search(r"in this pose ([\d,.]+)", text).group(1).replace(",", ""))
    assert abs(inp - pose) < 3, text
    assert p.get_by_role("button", name="Back to the reference postures").is_visible()
    p.get_by_role("button", name="Back to the reference postures").click()
    assert "in this pose" not in p.locator(".hm-pf-rrow[data-id=sitting_height]").inner_text()
    s.shot("profile-fit-report", ".hm-left")
    assert not s.errors()


def test_warnings_and_notes_listed(s):
    s.open()
    p = s.page
    warnings = s.js("window.__human.ctx.getBody().warnings")
    notes = s.js("window.__human.ctx.getProfile().notes")
    text = p.locator(".hm-pf-notes").first.inner_text()
    assert all(w[:40] in p.locator(".hm-pf").inner_text() for w in warnings)
    assert all(n[:40] in p.locator(".hm-pf").inner_text() for n in notes)
    p.locator(".hm-pf-model > summary").click()
    assert "not clinical limits" in p.locator(".hm-pf-model").inner_text() and "No strength, fatigue, comfort or injury model" in p.locator(".hm-pf-model").inner_text()
    assert text


# ---------------------------------------------------------------------------------------------------------------------------------- form and overrides (the shell has to pass them on)
def test_dimension_override_and_body_form_with_a_shell_that_passes_them_on(sp):
    sp.open()
    p = sp.page
    before = sp.js("window.__human.ctx.getBody().d.femur_length")
    row(sp, "femur_length").click()
    assert "Applied to the model" in p.locator(".hm-pf-editor").inner_text()
    V(p).get_by_label("Set this dimension to").fill("430")
    p.get_by_role("button", name="Apply").click()
    p.wait_for_function("window.__human.ctx.getBody().d.femur_length > 0.42", timeout=30000)
    sp.built()
    assert abs(sp.js("window.__human.ctx.getBody().d.femur_length") - 0.43) < 1e-9 and before < 0.42
    assert sp.profile()["overrides"] == {"femur_length": 0.43}
    assert "overridden by the user" in sp.js("window.__human.ctx.getBody().dims.find(d => d.id === 'femur_length').note")
    assert "edited" in row(sp, "femur_length").inner_text() and "measured" in row(sp, "femur_length").inner_text()
    assert not sp.js("window.__human.state.notices.some(n => n.id === 'profile-extras')"), "no complaint: the shell applied it"
    # the profile's measures did not change; the export has none of it
    assert sp.profile()["measures"]["stature"][2] != "edited"
    # a plausible-range edit is held at the edge and the panel says so (the row stayed open after the edit)
    assert row(sp, "femur_length").get_attribute("aria-expanded") == "true"
    V(p).get_by_label("Set this dimension to").fill("900")
    p.get_by_role("button", name="Apply").click()
    p.wait_for_selector(".hm-pf-status-warn", timeout=30000)
    assert "was held to" in p.locator(".hm-pf-status").inner_text()
    p.get_by_role("button", name="Revert all edits").click()
    p.wait_for_function("!window.__human.ctx.getProfile().overrides", timeout=30000)
    sp.built()
    assert abs(sp.js("window.__human.ctx.getBody().d.femur_length") - before) < 1e-9
    # body form
    p.locator("summary", has_text="Body form").click()
    assert p.get_by_role("button", name="Auto").get_attribute("aria-pressed") == "true"
    p.get_by_role("button", name="Female", exact=True).click()
    p.wait_for_function("window.__human.ctx.getProfile().form === 'female'", timeout=30000)
    sp.built()
    assert sp.js("window.__human.ctx.getBody().form") == "female"
    assert sp.profile()["label"].endswith("· female form") and sp.profile()["sex"] == "M"
    assert not sp.js("window.__human.state.notices.some(n => n.id === 'profile-extras')")
    # the choice follows a new source until it is set back to Auto
    sp.source("Manual")
    V(p).get_by_label("Stature", exact=True).fill("1800")
    p.get_by_role("button", name="Build this body").click()
    p.wait_for_function("window.__human.ctx.getProfile().source.kind === 'manual'", timeout=30000)
    sp.built()
    assert sp.js("window.__human.ctx.getBody().form") == "female", "the form is the user's choice, not the sex of the profile"
    p.get_by_role("button", name="Auto").click()
    p.wait_for_function("!window.__human.ctx.getProfile().form", timeout=30000)
    sp.built()
    assert sp.js("window.__human.ctx.getBody().form") == "male"
    assert not sp.errors()


def test_a_shell_that_drops_the_edits_is_noticed(s):
    s.open()
    p = s.page
    row(s, "femur_length").click()
    V(p).get_by_label("Set this dimension to").fill("430")
    p.get_by_role("button", name="Apply").click()
    p.wait_for_function("window.__human.state.notices.some(n => n.id === 'profile-extras')", timeout=30000)
    note = s.js("window.__human.state.notices.find(n => n.id === 'profile-extras').text")
    assert "ignored the dimension edits" in note and "passes only the measures" in note
    # and the other way: after reverting there is nothing to complain about
    p.get_by_role("button", name="Revert all edits").click()
    p.wait_for_function("!window.__human.state.notices.some(n => n.id === 'profile-extras')", timeout=30000)
    p.locator("summary", has_text="Body form").click()
    p.get_by_role("button", name="Female", exact=True).click()
    p.wait_for_function("window.__human.state.notices.some(n => n.id === 'profile-extras')", timeout=30000)
    assert "the body form" in s.js("window.__human.state.notices.find(n => n.id === 'profile-extras').text")
    assert not s.errors()


# ---------------------------------------------------------------------------------------------------------------------------------- skeleton
def test_skeleton_tree_selection_and_inspector(s):
    s.open("skeleton")
    p = s.page
    assert p.locator(".hm-sk-summary").inner_text() == "77 joints, 159 degrees of freedom, 118 bones, 120 landmarks"
    assert p.locator("[role=treeitem][data-node^='j:']").count() == 77
    groups = p.locator("[role=treeitem][data-node^='g:']")
    assert p.locator("[role=tree]").get_attribute("aria-label") == "Joints of the skeleton"
    # only the first group is open to begin with; expand all shows every joint
    p.get_by_role("button", name="Expand all").click()
    assert p.locator("[role=treeitem][data-node^='j:']:visible").count() == 77
    assert groups.count() == 21  # spine + 3 regions, head, and per arm: arm, hand, 5 fingers; 2 legs
    p.get_by_role("button", name="Collapse all").click()
    assert p.locator("[role=treeitem][data-node^='j:']:visible").count() == 0
    p.locator("[data-node='g:spine']").click()
    p.locator("[data-node='g:arm_L']").click()
    p.locator("[data-node='g:hand_L']").click()
    p.locator("[data-node='g:index_L']").click()
    assert p.locator("[data-node='j:index_pip_L']").is_visible()
    # one joint row: label, DOF count, angle summary, segment length and where it came from
    item = p.locator("[data-node='j:shoulder_L']")
    txt = item.inner_text()
    assert "3 DOF" in txt and "neutral" in txt and re.search(r"[\d,.]+ mm", txt) and re.search(r"measured|derived|estimated", txt), txt
    item.click()
    assert s.js("window.__human.state.selection") == {"kind": "joint", "id": "shoulder_L"}
    assert s.js("window.__human.state.rig.selected") == "shoulder_L"
    assert item.get_attribute("aria-selected") == "true"
    assert p.locator(".hm-inspector-head h2").inner_text() == "Left shoulder (glenohumeral)"
    insp = p.locator(".hm-inspector")
    assert insp.locator(".hm-sk-dof").count() == 3
    assert p.locator(".hm-sk-inline").is_hidden(), "on a wide screen the inspector shows the details"
    dof0 = insp.locator(".hm-sk-dof").first.text_content()  # the source sits in a closed <details>
    assert "Flexion / extension" in dof0 and "−60°" in dof0 and "180°" in dof0 and "arm forward / up" in dof0 and "AAOS" in dof0
    assert insp.locator(".hm-sk-rom").first.get_attribute("aria-label") == "0° in a range of −60° to 180°"
    assert "Rest segment to the parent" in insp.text_content() and "Set by:" in insp.text_content()
    assert "Bones it moves" in insp.text_content() and "Left humerus" in insp.text_content() and "Landmarks on it" in insp.text_content()
    for word in ("null", "undefined", "NaN"):
        assert word not in insp.text_content(), f"“{word}” leaked into the inspector: {insp.text_content()}"
    # values follow the pose without redrawing the inspector node
    s.js("window.__human.state.rig.setAngles({ shoulder_L: [30, -10, 5] })")
    p.wait_for_function("document.querySelector('.hm-inspector .hm-sk-dofval').textContent === '30°'")
    assert "flex 30°, abd −10°, rot 5°" in item.inner_text()
    assert insp.locator(".hm-sk-rom").first.get_attribute("aria-label") == "30° in a range of −60° to 180°"
    # from outside: another panel or the 3D view selects a joint and the tree follows (groups open, row in view)
    s.js("window.__human.ctx.select({ kind: 'joint', id: 'knee_R' })")
    p.wait_for_selector("[data-node='j:knee_R'][aria-selected=true]")
    assert p.locator("[data-node='j:knee_R']").is_visible()
    assert p.locator(".hm-inspector-head h2").inner_text() == "Right knee"
    # parent and child links in the inspector
    insp.get_by_role("button", name="Hip").first.click()
    assert s.js("window.__human.state.selection.id") == "hip_R"
    # nothing selected: the hint
    s.js("window.__human.ctx.select(null)")
    assert "No joint selected" in insp.inner_text()
    s.shot("skeleton-panel", ".hm-left")
    assert not s.errors()


def test_skeleton_search_and_keyboard(s):
    s.open("skeleton")
    p = s.page
    V(p).get_by_label("Search joints").fill("index")
    vis = p.locator("[role=treeitem][data-node^='j:']:visible")
    assert vis.count() == 6
    assert p.locator("[role=treeitem][data-node^='g:']:visible").count() >= 6, "the groups on the way stay"
    V(p).get_by_label("Search joints").fill("zzzz")
    assert p.locator(".hm-sk-none").is_visible()
    V(p).get_by_label("Search joints").fill("knee flex")
    assert p.locator("[role=treeitem][data-node^='j:']:visible").count() == 2
    V(p).get_by_label("Search joints").fill("")
    # keyboard: the list has one tab stop, arrows move, right opens, enter selects
    p.get_by_role("button", name="Collapse all").click()
    assert p.locator("[role=treeitem][tabindex='0']").count() == 1
    p.locator("[data-node='g:spine']").focus()
    assert p.locator("[role=treeitem][tabindex='0']").evaluate("e => e.dataset.node") == "g:spine", "focusing an item makes it the tab stop"
    p.keyboard.press("ArrowRight")  # opens the first group
    p.keyboard.press("ArrowDown")   # the pelvis
    assert s.js("document.activeElement.dataset.node") == "j:pelvis"
    p.keyboard.press("Enter")
    assert s.js("window.__human.state.selection") == {"kind": "joint", "id": "pelvis"}
    p.keyboard.press("ArrowDown")   # lumbar group
    p.keyboard.press("ArrowRight")  # open
    p.keyboard.press("ArrowDown")
    assert s.js("document.activeElement.dataset.node") == "j:L5"
    p.keyboard.press("ArrowLeft")   # to the parent group
    assert s.js("document.activeElement.dataset.node") == "g:lumbar"
    p.keyboard.press("End")
    assert s.js("document.activeElement.dataset.node").startswith("g:leg_R")
    p.keyboard.press("Home")
    assert s.js("document.activeElement.dataset.node") == "g:spine"
    assert p.locator("[role=treeitem][tabindex='0']").count() == 1
    assert not s.errors()


def test_skeleton_landmarks_and_csv(s):
    s.open("skeleton")
    p = s.page
    p.locator("summary", has_text="Landmarks").click()
    p.wait_for_function("document.querySelectorAll('.hm-sk-lm').length === 120")
    V(p).get_by_label("Search landmarks").fill("acromion")
    assert 0 < p.locator(".hm-sk-lm:visible").count() <= 4
    row_ = p.locator(".hm-sk-lm:visible").first
    assert re.search(r"-?[\d,]+\.\d\s+-?[\d,]+\.\d\s+-?[\d,]+\.\d", row_.inner_text().replace("−", "-")), row_.inner_text()
    # a click selects it (the shell names it in the 3D view) and flashes the landmark dots for a moment
    assert s.js("window.__human.state.rig.display.landmarks") is False
    row_.click()
    sel = s.js("window.__human.state.selection")
    assert sel["kind"] == "landmark" and sel["id"].startswith("acromion")
    assert s.js("window.__human.state.rig.display.landmarks") is True and s.js("window.__human.state.rig.display.xray") is True
    assert "Show in the 3D view" in p.locator(".hm-inspector").inner_text() and "World position" in p.locator(".hm-inspector").inner_text()
    p.wait_for_function("window.__human.state.rig.display.landmarks === false", timeout=6000)
    assert s.js("window.__human.state.rig.display.xray") is False
    # the world position in the list is the rig's, in mm, and follows the pose
    s.js("window.__human.state.rig.setAngles({ shoulder_L: [90, 0, 0] })")
    p.wait_for_timeout(250)
    shown = [float(x.replace(",", "")) for x in re.findall(r"-?[\d,]+\.\d", row_.inner_text().replace("−", "-"))]
    want = s.js("(id) => window.__human.state.rig.landmarkWorld(id).toArray().map(v => v * 1000)", sel["id"])
    assert all(abs(a - b) < 0.06 for a, b in zip(shown, want)), (shown, want)
    # CSV: copy and download
    p.locator("summary", has_text="Points for CAD").click()
    p.get_by_role("button", name="Copy as CSV").click()
    p.wait_for_function("document.querySelector('.hm-sk .hm-sk-row ~ p').textContent.length > 0")
    status = p.locator(".hm-sk .hm-sk-row ~ p").inner_text()
    assert "Copied 197 rows" in status, status
    try:
        text = s.js("navigator.clipboard.readText()")
    except Exception:  # noqa: BLE001
        text = None
    with p.expect_download() as d:
        p.get_by_role("button", name="Download CSV").click()
    saved = Path(d.value.path()).read_text()
    if text is not None:
        assert text == saved
    lines = saved.strip().split("\n")
    assert lines[0] == "type,id,label,group,kind,attached_to,x_mm,y_mm,z_mm" and len(lines) == 1 + 77 + 120
    by = {ln.split(",")[1]: ln.split(",") for ln in lines[1:] if not ln.split(",")[1].startswith('"')}
    rig_vertex = s.js("window.__human.state.rig.landmarkWorld('vertex').toArray().map(v => v * 1000)")
    assert all(abs(float(a) - b) < 0.06 for a, b in zip(by["vertex"][-3:], rig_vertex))
    rig_sh = s.js("window.__human.state.rig.jointWorld('shoulder_L').toArray().map(v => v * 1000)")
    assert all(abs(float(a) - b) < 0.06 for a, b in zip(by["shoulder_L"][-3:], rig_sh)), "the CSV is in the current pose (the arm is raised)"
    assert float(by["shoulder_L"][-3]) > 0, "+X is the figure's left"
    assert not s.errors()


def test_skeleton_display_toggles_follow_the_toolbar(s):
    s.open("skeleton")
    p = s.page
    btn = p.locator(".hm-sk-show").get_by_role("button", name="Joint markers")
    assert btn.get_attribute("aria-pressed") == "false"
    btn.click()
    assert s.js("window.__human.state.display.joints") is True and btn.get_attribute("aria-pressed") == "true"
    p.get_by_role("button", name="Joints", exact=True).first.click()  # the toolbar's own button
    assert s.js("window.__human.state.display.joints") is False
    p.wait_for_function("document.querySelector('.hm-sk-show button[aria-pressed]:nth-of-type(2)').getAttribute('aria-pressed') === 'false'")
    assert not s.errors()


# ---------------------------------------------------------------------------------------------------------------------------------- layout, themes, accessibility
VIEWS = [("Population", None), ("Individual", None), ("Import", None), ("Manual", None)]


def no_horizontal_scroll(s):
    return s.js("""() => { const de = document.documentElement; const bad = []; const vw = de.clientWidth;
        for (const e of document.querySelectorAll('.hm-pf *, .hm-sk *')) { const b = e.getBoundingClientRect(); if (b.width > 0 && (b.right > vw + 1 || b.left < -1) && e.offsetParent) bad.push(`${e.tagName}.${e.className} ${Math.round(b.left)}..${Math.round(b.right)}`); }
        return { scrollWidth: document.scrollingElement.scrollWidth, vw, bad: bad.slice(0, 6) }; }""")


@pytest.mark.parametrize("width,height", [(390, 800), (360, 740)])
def test_mobile_layout_has_no_horizontal_scroll(chromium, server, width, height):
    with make_session(chromium, server, width=width, height=height, mobile=True) as s:
        s.open()
        p = s.page
        r = no_horizontal_scroll(s)
        assert r["scrollWidth"] <= r["vw"] + 1 and not r["bad"], r
        for name, _ in VIEWS[1:]:
            s.source(name)
            if name == "Individual":
                p.wait_for_function("document.querySelector('.hm-pf-view .loading') === null", timeout=90000)
            r = no_horizontal_scroll(s)
            assert r["scrollWidth"] <= r["vw"] + 1 and not r["bad"], (name, r)
        s.source("Population")
        row(s, "femur_length").click()
        r = no_horizontal_scroll(s)
        assert r["scrollWidth"] <= r["vw"] + 1 and not r["bad"], ("dimension detail", r)
        p.locator("summary", has_text="Fit report").click()
        r = no_horizontal_scroll(s)
        assert r["scrollWidth"] <= r["vw"] + 1 and not r["bad"], ("fit report", r)
        s.shot(f"profile-mobile-{width}", ".hm-left")
        p.get_by_role("tab", name="Skeleton").click()
        p.wait_for_selector(".hm-sk-tree")
        p.get_by_role("button", name="Expand all").click()
        p.locator("[data-node='j:index_mcp_L']").click()
        # the inspector is folded away on a phone: the details of the joint are right under the list
        inline = p.locator(".hm-sk-inline")
        assert inline.is_visible() and "Left index MCP" in inline.locator("summary").first.inner_text()
        assert inline.locator(".hm-sk-dof").count() == 2 and "Flexion / extension" in inline.inner_text()
        assert "null" not in inline.inner_text() and "undefined" not in inline.inner_text()
        s.js("window.__human.state.rig.setAngles({ index_mcp_L: [45, 5] })")
        p.wait_for_function("document.querySelector('.hm-sk-inline .hm-sk-dofval').textContent === '45°'")
        p.locator("summary", has_text="Landmarks").click()
        r = no_horizontal_scroll(s)
        assert r["scrollWidth"] <= r["vw"] + 1 and not r["bad"], ("skeleton", r)
        s.shot(f"skeleton-mobile-{width}", ".hm-left")
        # a tap target is big enough on a touch screen
        h = s.js("document.querySelector(\"[data-node='j:index_mcp_L']\").getBoundingClientRect().height")
        assert h >= 40, h
        assert not s.errors()


def contrast_js():
    """WCAG contrast of the text of every matching visible element against the background it sits on (colours are resolved through a canvas, so
    color-mix() and the like work; semi-transparent backgrounds are composited down the ancestor chain)."""
    return """(sels) => {
      const cv = document.createElement('canvas'); cv.width = cv.height = 1; const g = cv.getContext('2d', { willReadFrequently: true });
      const rgb = (c) => { g.clearRect(0, 0, 1, 1); g.fillStyle = '#000'; g.fillStyle = c; g.fillRect(0, 0, 1, 1); const d = g.getImageData(0, 0, 1, 1).data; return { r: d[0], g: d[1], b: d[2], a: d[3] / 255 }; };
      const mix = (top, bottom) => ({ r: top.r * top.a + bottom.r * (1 - top.a), g: top.g * top.a + bottom.g * (1 - top.a), b: top.b * top.a + bottom.b * (1 - top.a), a: 1 });
      const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
      const bgOf = (el) => { const stack = []; for (let e = el; e; e = e.parentElement) { const c = rgb(getComputedStyle(e).backgroundColor); if (c.a > 0) { stack.push(c); if (c.a >= 1) break; } }
        let base = rgb(getComputedStyle(document.body).backgroundColor); if (base.a < 1) base = mix(base, { r: 255, g: 255, b: 255, a: 1 }); for (const c of stack.reverse()) base = mix(c, base); return base; };
      const out = [];
      for (const sel of sels) for (const el of document.querySelectorAll(sel)) { if (!el.offsetParent || !el.textContent.trim()) continue;
        const bg = bgOf(el), fg = mix(rgb(getComputedStyle(el).color), bg), a = lum(fg) + 0.05, b = lum(bg) + 0.05; out.push([sel, el.textContent.trim().slice(0, 24), Math.max(a, b) / Math.min(a, b)]); }
      return out; }"""


@pytest.mark.parametrize("dark", [False, True])
def test_themes_keep_text_readable(chromium, server, dark):
    with make_session(chromium, server, dark=dark) as s:
        s.open()
        p = s.page
        assert s.js("getComputedStyle(document.body).backgroundColor") != "rgba(0, 0, 0, 0)"
        row(s, "femur_length").click()
        p.locator("summary", has_text="Fit report").click()
        p.locator("summary", has_text="Body form").click()
        sels = [".hm-pf-st", ".hm-pf-dimname", ".hm-pf-dimval", ".hm-pf-from", ".hm-pf-metertext", ".hm-pf-name", ".hm-pf-rname", ".hm-pf-rnums", ".hm-pf-rnote", ".hm-pf-dl dd", ".hm-pf-dl dt",
                ".hm-pf-repsum", ".hm-pf-radio", ".hm-pf-grp", ".hm-pf-notes li", ".hm-pf .small.muted", ".hm-pf-fchip", ".hm-pf-hint"]
        for name, text, ratio in s.js(contrast_js(), sels):
            floor = 3.0 if name in (".hm-pf-dl dt", ".hm-pf-grp") else 4.5  # the small upper-case captions use the site's --text-3
            assert ratio >= floor, f"{'dark' if dark else 'light'} {name} “{text}” contrast {ratio:.2f}"
        s.shot(f"profile-{'dark' if dark else 'light'}", ".hm-left")
        p.get_by_role("tab", name="Skeleton").click()
        p.wait_for_selector(".hm-sk-tree")
        p.get_by_role("button", name="Expand all").click()
        p.locator("[data-node='j:shoulder_L']").click()
        sk = [".hm-sk-name", ".hm-sk-ang", ".hm-sk-segwrap", ".hm-sk-dofn", ".hm-sk-summary", ".hm-sk-dofname", ".hm-sk-dofsign", ".hm-sk-romends", ".hm-sk-why", ".hm-pf-st", ".hm-sk-link", ".hm-sk-meta"]
        for name, text, ratio in s.js(contrast_js(), sk):
            floor = 3.0 if name in (".hm-sk-dofn", ".hm-sk-romends") else 4.5
            assert ratio >= floor, f"{'dark' if dark else 'light'} {name} “{text}” contrast {ratio:.2f}"
        s.shot(f"skeleton-{'dark' if dark else 'light'}", ".hm-left")
        s.shot(f"skeleton-inspector-{'dark' if dark else 'light'}", ".hm-inspector")
        # switching the theme while the tab is open restyles it
        s.js("document.documentElement.dataset.theme = %s" % ("'light'" if dark else "'dark'"))
        p.wait_for_timeout(200)
        assert s.js("getComputedStyle(document.querySelector('.hm-sk-tree')).backgroundColor") == ("rgb(26, 26, 25)" if not dark else "rgb(252, 252, 251)"), "the site's --surface of the other theme"
        assert not s.errors()


def accessible_name_js():
    return """(root) => { const bad = []; for (const el of document.querySelectorAll(root + ' button, ' + root + ' input, ' + root + ' select, ' + root + ' textarea, ' + root + ' [role=treeitem]')) {
        if (!el.offsetParent && el.type !== 'file') continue;
        const name = (el.getAttribute('aria-label') || (el.labels && [...el.labels].map(l => l.textContent).join(' ')) || el.textContent || el.title || el.getAttribute('placeholder') || '').trim();
        if (!name) bad.push(el.outerHTML.slice(0, 80)); }
      return bad; }"""


def test_every_control_has_a_name_and_a_visible_focus(s):
    s.open()
    p = s.page
    for name in ("Population", "Import", "Manual"):
        s.source(name)
        assert s.js(accessible_name_js(), ".hm-pf") == [], name
    s.source("Population")
    row(s, "femur_length").click()
    p.locator("summary", has_text="Fit report").click()
    p.locator("summary", has_text="Body form").click()
    assert s.js(accessible_name_js(), ".hm-pf") == []
    # groups of buttons are labelled
    for label in ("Profile source", "Show dimensions by status", "Body form"):
        assert p.locator(f"[aria-label='{label}']").count() == 1, label
    # Tab reaches the dimension rows and shows a focus ring
    row(s, "stature").focus()
    p.keyboard.press("Tab")
    p.keyboard.press("Shift+Tab")
    assert s.js("getComputedStyle(document.activeElement).outlineStyle") != "none"
    p.get_by_role("tab", name="Skeleton").click()
    p.wait_for_selector(".hm-sk-tree")
    assert s.js(accessible_name_js(), ".hm-sk") == []
    p.locator("[role=treeitem][tabindex='0']").focus()
    p.keyboard.press("Tab")
    p.keyboard.press("Shift+Tab")
    assert s.js("getComputedStyle(document.activeElement).outlineStyle") != "none"
    assert not s.errors()


def test_reduced_motion_and_no_stray_listeners(chromium, server):
    with make_session(chromium, server, reduced_motion=True) as s:
        s.open("skeleton")
        assert s.js("getComputedStyle(document.querySelector('.hm-sk-chev')).transitionDuration") in ("0s", "0.000001s")
        # leaving the Digital human view and coming back keeps one figure and no errors
        s.page.get_by_role("tab", name="Profile").click()
        s.page.get_by_role("link", name="Survey catalog").click()
        s.page.wait_for_timeout(300)
        s.page.get_by_role("link", name="Digital human").click()
        s.page.wait_for_selector(".hm-pf .hm-pf-dimbtn")
        s.built()
        assert s.page.locator(".hm-pf-dimbtn").count() == 53
        assert not s.errors()


def test_a_selection_made_in_the_profile_tab_is_there_when_the_skeleton_tab_opens(s):
    s.open()
    p = s.page
    row(s, "femur_length").click()
    assert s.js("window.__human.state.selection") == {"kind": "joint", "id": "knee_L"}
    p.get_by_role("tab", name="Skeleton").click()
    p.wait_for_selector(".hm-sk-tree")
    assert p.locator("[data-node='j:knee_L']").get_attribute("aria-selected") == "true"
    assert p.locator("[data-node='j:knee_L']").is_visible()
    assert p.locator(".hm-inspector-head h2").inner_text() == "Left knee"
    assert p.locator(".hm-inspector .hm-sk-dof").count() == 2
    # a landmark selected from the Profile tab: its position in the inspector
    p.get_by_role("tab", name="Profile").click()
    row(s, "hand_length").click()
    p.get_by_role("tab", name="Skeleton").click()
    assert "World position" in p.locator(".hm-inspector").inner_text()
    assert not s.errors()


def test_the_inspector_is_clean_for_every_joint_and_landmark(s):
    s.open("skeleton")
    bad = s.js("""async () => {
        const c = window.__human.ctx, out = [], wait = () => new Promise((r) => setTimeout(r, 0));
        const text = () => document.querySelector('.hm-inspector').textContent + ' ' + document.querySelector('.hm-sk-tree').closest('.hm-sk').textContent.length;
        const joints = [...document.querySelectorAll("[data-node^='j:']")].map((e) => e.dataset.node.slice(2));
        for (const id of joints) { c.select({ kind: 'joint', id }); await wait();
            const t = document.querySelector('.hm-inspector').textContent, title = document.querySelector('.hm-inspector-head h2').textContent;
            if (/null|undefined|NaN|\\[object/.test(t) || !t.includes('Degrees of freedom') || !title) out.push('joint ' + id); }
        for (const id of Object.keys(c.getBody().landmarks)) { c.select({ kind: 'landmark', id }); await wait();
            const t = document.querySelector('.hm-inspector').textContent;
            if (/null|undefined|NaN|\\[object/.test(t) || !t.includes('World position')) out.push('landmark ' + id); }
        c.select(null);
        return out; }""")
    assert bad == [], bad
    assert not s.errors()


# ---------------------------------------------------------------------------------------------------------------------------------- the demo page (no shell, no WebGL, an invented database)
def open_demo(s, query="panel=profile&w=330&fakedb=1"):
    s.page.goto(f"{s.base}/__pages/profile-demo.html?{query}")
    s.page.wait_for_function("window.__ready", timeout=60000)
    s.page.wait_for_function("window.__demo.ctx.getBody() && window.__demo.ctx.getBody().profileId === window.__demo.ctx.getProfile().id")
    return s


def demo_built(s):
    s.page.wait_for_function("window.__demo.ctx.getBody().profileId === window.__demo.ctx.getProfile().id")


def test_individual_source_with_an_invented_database_is_deterministic(chromium, server):
    with make_session(chromium, server, width=480, height=900) as s:
        open_demo(s)
        p = s.page
        ctx = "window.__demo.ctx"
        s.source("Individual")
        p.wait_for_selector(".hm-pf-view select")
        assert "120 people with a stature in this group" in p.locator(".hm-pf-view").inner_text()
        # closest: the person nearest to a stature and mass, by the same distance the database module uses
        V(p).get_by_label(re.compile(r"^Stature \(mm\)")).fill("1800")
        V(p).get_by_label("Mass (kg), optional").fill("")
        p.get_by_role("button", name="Find the closest person").click()
        p.wait_for_function(f"{ctx}.getProfile().source.kind === 'individual'")
        demo_built(s)
        assert s.js(f"{ctx}.getProfile().source.subject_key") == 1100, "1500 + 3 * 100 = 1800"
        assert "Closest: person #1100" in p.locator(".hm-pf-msg-ok").inner_text() and "you asked for 1,800 mm" in p.locator(".hm-pf-msg-ok").inner_text()
        assert abs(s.js(f"{ctx}.getBody().stature") * 1000 - 1800) < 1e-6
        # what was typed stays when a search finds nobody or the page redraws
        V(p).get_by_label(re.compile(r"^Stature \(mm\)")).fill("1234")
        p.get_by_role("button", name="From a list").click()
        p.get_by_role("button", name="Closest match").click()
        assert V(p).get_by_label(re.compile(r"^Stature \(mm\)")).input_value() == "1234"
        # the list: 120 men, 20 a page, shortest first
        p.get_by_role("button", name="From a list").click()
        p.wait_for_selector(".hm-pf-person")
        assert p.locator(".hm-pf-person").count() == 20
        assert p.locator(".hm-pf-person").first.inner_text().startswith("#1000 · 1,500 mm · 50.0 kg")
        assert "Showing 1 to 20 of 120" in p.locator(".hm-pf-view").inner_text() and "Page 1 of 6" in p.locator(".hm-pf-pager").inner_text()
        for _ in range(5):
            p.get_by_role("button", name="Next").click()
            p.wait_for_function("!document.querySelector('.hm-pf-pager button:last-child').disabled || document.querySelector('.hm-pf-pager').innerText.includes('Page 6')")
        p.wait_for_function("document.querySelector('.hm-pf-pager').innerText.includes('Page 6 of 6')")
        assert p.get_by_role("button", name="Next").is_disabled() and p.get_by_role("button", name="Previous").is_enabled()
        assert p.locator(".hm-pf-person").last.inner_text().startswith("#1119 · 1,857 mm")
        assert "Showing 101 to 120 of 120" in p.locator(".hm-pf-view").inner_text()
        p.get_by_role("button", name="Previous").click()
        p.wait_for_function("document.querySelector('.hm-pf-pager').innerText.includes('Page 5 of 6')")
        # a click on a person loads that person and the list does not jump back to the top
        p.locator(".hm-pf-people").evaluate("e => { e.scrollTop = 60; }")
        p.locator(".hm-pf-person").nth(7).click()
        p.wait_for_function(f"{ctx}.getProfile().source.subject_key === 1087")
        demo_built(s)
        assert p.locator(".hm-pf-people").evaluate("e => e.scrollTop") > 0
        # units: the list follows the display units
        s.js(f"{ctx}.setUnits('cm')")
        assert p.locator(".hm-pf-person").first.inner_text().startswith("#1080 · 174.0 cm · 82.0 kg"), p.locator(".hm-pf-person").first.inner_text()
        s.js(f"{ctx}.setUnits('mm')")
        # women: 80 people, 4 pages
        V(p).get_by_label("Sex", exact=True).select_option("F")
        p.wait_for_function("document.querySelector('.hm-pf-pager')?.innerText.includes('Page 1 of 4')")
        assert p.locator(".hm-pf-person").first.inner_text().startswith("#5000 · 1,450 mm")
        # random: a person of the chosen group
        p.get_by_role("button", name="Random", exact=True).click()
        p.get_by_role("button", name="Pick a random person").click()
        p.wait_for_function(f"{ctx}.getProfile().source.sex === 'F' && {ctx}.getProfile().source.kind === 'individual'")
        demo_built(s)
        key = s.js(f"{ctx}.getProfile().source.subject_key")
        assert 5000 <= key < 5080
        assert not s.errors()


def test_individual_source_database_error_and_retry(chromium, server):
    with make_session(chromium, server, width=480, height=900) as s:
        open_demo(s)
        s.js("window.__failDb = true")
        s.source("Individual")
        p = s.page
        p.wait_for_selector(".hm-pf-view .notice")
        text = p.locator(".hm-pf-view").inner_text()
        assert "The database could not be loaded (the demo database is offline)" in text and "population, import and manual sources work without it" in text
        s.js("window.__failDb = false")
        p.locator(".hm-pf-view").get_by_role("button", name="Retry").click()
        p.wait_for_selector(".hm-pf-view select")
        assert "120 people" in p.locator(".hm-pf-view").inner_text()
        # a failure later (while paging) is shown in place and leaves the figure alone
        before = s.js("window.__demo.ctx.getProfile().id")
        p.get_by_role("button", name="From a list").click()
        p.wait_for_selector(".hm-pf-person")
        s.js("window.__failDb = true")
        p.locator(".hm-pf-person").first.click()
        p.wait_for_selector(".hm-pf-msg-error")
        assert "the demo database is offline" in p.locator(".hm-pf-msg-error").inner_text()
        assert s.js("window.__demo.ctx.getProfile().id") == before
        assert not s.errors()
