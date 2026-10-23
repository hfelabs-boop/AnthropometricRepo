// "Send to CAD" (site/js/human/cadlink.js): server addresses, the calls to anthro_service's /v1/profiles and the messages, with a fake fetch.
// The server side is tested in anthro_service/tests/test_profiles.py; the whole path (the Export panel in Chromium posting to a live server) in test_send_to_cad.py.
//   node --import ./tests/human3d/register.mjs --test tests/human3d/cadlink.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { normalizeServer, testServer, pushProfile, linksOf, explain, DEFAULT_SERVER } from "../../site/js/human/cadlink.js";

const json = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });
function fakeFetch(routes) {
  const calls = [];
  const f = async (url, init) => {
    calls.push({ url, init });
    const u = new URL(url), key = `${init.method} ${u.pathname}`;
    const r = routes[key];
    if (!r) return json(404, { error: { code: "not_found", message: "Not found." } });
    if (r instanceof Error) throw r;
    return typeof r === "function" ? r(url, init) : r;
  };
  f.calls = calls;
  return f;
}

test("server addresses: a scheme is added, /v1 and slashes are dropped, the rest is refused", () => {
  assert.deepEqual(normalizeServer("localhost:8000"), { ok: true, base: "http://localhost:8000" });
  assert.deepEqual(normalizeServer(" http://127.0.0.1:8000/ "), { ok: true, base: "http://127.0.0.1:8000" });
  assert.deepEqual(normalizeServer("https://cad.example.org/anthro/v1/"), { ok: true, base: "https://cad.example.org/anthro" });
  assert.equal(normalizeServer(DEFAULT_SERVER).base, DEFAULT_SERVER);
  for (const bad of ["", "ftp://x.org", "http://u:p@x.org", "http://x.org/?a=1", "http://[bad"]) assert.equal(normalizeServer(bad).ok, false, bad);
});

test("push: the document is POSTed as JSON with the key; the answer gives the id and the URLs a macro reads", async () => {
  const f = fakeFetch({ "POST /v1/profiles": json(201, { id: "20261023-100000-p50-ab12", label: "US Army · men · P50", links: {} }) });
  const r = await pushProfile("http://127.0.0.1:8000", '{"format":"human-exchange"}', { key: " k1 ", fetch: f });
  assert.equal(r.ok, true);
  assert.equal(r.id, "20261023-100000-p50-ab12");
  assert.equal(r.links.values_csv, "http://127.0.0.1:8000/v1/profiles/20261023-100000-p50-ab12/values?format=csv");
  assert.equal(r.links.latest_values_csv, "http://127.0.0.1:8000/v1/profiles/latest/values?format=csv");
  const c = f.calls[0];
  assert.equal(c.init.method, "POST");
  assert.equal(c.init.headers["Content-Type"], "application/json");
  assert.equal(c.init.headers["X-API-Key"], "k1");
  assert.equal(c.init.credentials, "omit");
  assert.equal(c.init.body, '{"format":"human-exchange"}');
});

test("push: the server's error message and hint come through; a network failure explains how to start the server", async () => {
  const forbidden = fakeFetch({ "POST /v1/profiles": json(403, { error: { code: "forbidden", message: "Pushed profiles are served to this computer only.", hint: "Set ANTHRO_API_KEYS." } }) });
  const r = await pushProfile("http://10.0.0.5:8000", "{}", { fetch: forbidden });
  assert.equal(r.ok, false);
  assert.equal(r.status, 403);
  assert.match(r.message, /this computer only/);
  assert.match(r.hint, /ANTHRO_API_KEYS/);
  const down = fakeFetch({ "POST /v1/profiles": new TypeError("Failed to fetch") });
  const d = await pushProfile("http://127.0.0.1:8000", "{}", { fetch: down, pageOrigin: "https://antrorepo.vercel.app" });
  assert.equal(d.ok, false);
  assert.match(d.message, /Cannot reach the server/);
  assert.match(d.hint, /python -m anthro_service serve/);
  assert.match(d.hint, /anthro_service push FILE\.json/);
  // an https page and a plain-http server on another computer: mixed content
  const lan = await pushProfile("http://10.0.0.5:8000", "{}", { fetch: down, pageOrigin: "https://antrorepo.vercel.app" });
  assert.match(lan.message, /will not send from this https page/);
  const big = fakeFetch({ "POST /v1/profiles": json(413, { error: { code: "payload_too_large", message: "The document is 6,000,000 bytes; at most 5,000,000 are accepted." } }) });
  assert.match((await pushProfile("http://127.0.0.1:8000", "{}", { fetch: big })).message, /at most 5,000,000/);
  assert.match(explain({ status: 404, body: null }, "http://x.org").message, /not an anthro_service server/);
});

test("test connection: health, then the profile list (which checks the key and the access rule)", async () => {
  const ok = fakeFetch({ "GET /v1/health": json(200, { status: "ok", version: "1.2.0" }), "GET /v1/profiles": json(200, { count: 1, profiles: [{ id: "x", label: "Woman P5" }] }) });
  const r = await testServer("http://127.0.0.1:8000", { fetch: ok });
  assert.equal(r.ok, true);
  assert.match(r.message, /anthro_service 1\.2\.0/);
  assert.match(r.message, /Woman P5/);
  assert.deepEqual(ok.calls.map((c) => new URL(c.url).pathname), ["/v1/health", "/v1/profiles"]);
  const nokey = fakeFetch({ "GET /v1/health": json(200, { status: "ok", version: "1.2.0" }), "GET /v1/profiles": json(401, { error: { code: "unauthorized", message: "Missing or invalid API key." } }) });
  const n = await testServer("http://127.0.0.1:8000", { fetch: nokey });
  assert.equal(n.ok, false);
  assert.match(n.message, /API key/);
  const old = fakeFetch({ "GET /v1/health": json(200, { status: "ok", version: "1.1.0" }) });
  assert.match((await testServer("http://127.0.0.1:8000", { fetch: old })).message, /older than the profile inbox|not an anthro_service/);
});

test("URLs of a profile escape the id", () => {
  assert.equal(linksOf("http://h:1", "a b").summary, "http://h:1/v1/profiles/a%20b");
});
