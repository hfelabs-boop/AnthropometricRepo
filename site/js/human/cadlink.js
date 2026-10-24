// "Send to CAD": push the figure (the human-exchange JSON of export.js) to the REST API of anthro_service (POST /v1/profiles), where CATIA, AutoCAD, Jack,
// RAMSIS or a script reads it back (/v1/profiles/latest/values, /angles, /points; the VBA module anthro_service/examples/AnthroApi.bas does it from CATIA).
// Pure: no DOM; `fetch` is passed in (tests use a fake). The Export panel (panels/export.js) draws the controls. Manual: docs/human3d/EXPORT.md, "Send to CAD".
//
// The server usually runs on the CAD computer itself (python -m anthro_service serve, http://127.0.0.1:8000): the browser then talks to its own computer.
// Chrome, Edge and Firefox allow that from the https website (127.0.0.1 counts as a secure origin; the server answers the Private Network Access preflight);
// Chrome may ask the user to allow access to devices on the local network. Where the browser refuses, the fallback is the downloaded JSON and
// `python -m anthro_service push FILE.json`.

export const DEFAULT_SERVER = "http://127.0.0.1:8000";
export const TIMEOUT_MS = 15000;
export const START_HINT = "Start it on the CAD computer:  pip install -r anthro_service/requirements.txt  then  python -m anthro_service serve";
export const FALLBACK_HINT = "Or download the Exchange JSON and run:  python -m anthro_service push FILE.json";

/**
 * The base URL of a server from what the user typed: "localhost:8000", "http://127.0.0.1:8000/", "https://cad.example.org/anthro/v1" all work.
 * Returns { ok: true, base } (no trailing slash, no /v1) or { ok: false, error }.
 */
export function normalizeServer(text) {
  let s = String(text ?? "").trim();
  if (!s) return { ok: false, error: "Enter the address of the server, for example http://127.0.0.1:8000." };
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `http://${s}`;
  let u;
  try { u = new URL(s); } catch { return { ok: false, error: `"${String(text).slice(0, 80)}" is not a web address.` }; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return { ok: false, error: "The address must start with http:// or https://." };
  if (u.username || u.password) return { ok: false, error: "Leave the user name and password out of the address; put an API key in the key field." };
  if (u.search || u.hash) return { ok: false, error: "Leave the ?query and #fragment out of the address." };
  const path = u.pathname.replace(/\/+$/, "").replace(/\/v1$/i, "");
  return { ok: true, base: `${u.origin}${path}` };
}

const headersOf = (key, json = false) => ({ ...(json ? { "Content-Type": "application/json" } : {}), ...(key ? { "X-API-Key": String(key).trim() } : {}) });

async function call(fetchFn, url, init, timeoutMs) {
  const ctl = typeof AbortController === "function" ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : 0;
  try {
    const r = await fetchFn(url, { ...init, ...(ctl ? { signal: ctl.signal } : {}), mode: "cors", credentials: "omit", cache: "no-store" });
    let body = null;
    try { body = await r.json(); } catch { body = null; }
    return { status: r.status, ok: r.ok, body };
  } catch (e) {
    return { status: 0, ok: false, body: null, error: e?.name === "AbortError" ? "timeout" : String(e?.message ?? e) };
  } finally { if (timer) clearTimeout(timer); }
}

/** A sentence for a failed call: what happened and what to do. `pageOrigin` is the website's origin (location.origin), for the mixed-content advice. */
export function explain(res, base, pageOrigin = "") {
  const err = res?.body?.error;
  if (res?.status === 0) {
    const insecure = /^https:/i.test(pageOrigin) && /^http:/i.test(base) && !/^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(base);
    if (res.error === "timeout") return { message: `The server at ${base} did not answer within ${TIMEOUT_MS / 1000} s.`, hint: `${START_HINT}. ${FALLBACK_HINT}` };
    if (insecure) return { message: `The browser will not send from this https page to the plain http address ${base}.`, hint: "Use https on that server, or run the server on this computer (http://127.0.0.1:8000). " + FALLBACK_HINT };
    return { message: `Cannot reach the server at ${base}.`, hint: `Is it running? ${START_HINT}. If it is, the browser may have blocked the request (Safari blocks it; Chrome asks to allow local network access). ${FALLBACK_HINT}` };
  }
  if (res?.status === 404 && (!err || err.message === "Not found.")) return { message: `${base} answered 404: it is not an anthro_service server, or it is older than the profile inbox.`, hint: "Update the repository and restart: python -m anthro_service serve" };
  if (err) return { message: `${err.message}`, hint: err.hint ?? (res.status === 401 ? "Enter the server's API key." : "") };
  return { message: `The server answered ${res?.status ?? "nothing"}.`, hint: "" };
}

/** Check a server: GET /v1/health, then GET /v1/profiles?limit=1 (which also checks the key and that profiles are served to this computer). */
export async function testServer(base, { key = "", fetch: fetchFn = globalThis.fetch, timeoutMs = TIMEOUT_MS, pageOrigin = "" } = {}) {
  const h = await call(fetchFn, `${base}/v1/health`, { method: "GET", headers: headersOf(key) }, timeoutMs);
  if (!h.ok || h.body?.status !== "ok") return { ok: false, ...explain(h, base, pageOrigin) };
  const p = await call(fetchFn, `${base}/v1/profiles?limit=1`, { method: "GET", headers: headersOf(key) }, timeoutMs);
  if (!p.ok) return { ok: false, version: h.body.version, ...explain(p, base, pageOrigin) };
  const n = p.body?.count ?? 0, newest = p.body?.profiles?.[0];
  return { ok: true, version: h.body.version, message: `Connected to anthro_service ${h.body.version} at ${base}.${newest ? ` Newest profile: "${newest.label}".` : " No profile pushed yet."}`, count: n };
}

/** The absolute URLs of a pushed profile that a CAD macro reads. */
export function linksOf(base, id) {
  const b = `${base}/v1/profiles/${encodeURIComponent(id)}`, l = `${base}/v1/profiles/latest`;
  return {
    values_csv: `${b}/values?format=csv`, values_xml: `${b}/values?format=xml`, angles_csv: `${b}/angles?format=csv`, points_csv: `${b}/points?format=csv`, dims_csv: `${b}/dims?format=csv`,
    summary: b, document: `${b}/document`, latest_values_csv: `${l}/values?format=csv`,
  };
}

/** POST the document (JSON text) to /v1/profiles. Returns { ok, id, label, links, profile } or { ok: false, status, message, hint }. */
export async function pushProfile(base, text, { key = "", fetch: fetchFn = globalThis.fetch, timeoutMs = TIMEOUT_MS, pageOrigin = "" } = {}) {
  const r = await call(fetchFn, `${base}/v1/profiles`, { method: "POST", headers: headersOf(key, true), body: text }, timeoutMs);
  if (r.status !== 201 || !r.body?.id) return { ok: false, status: r.status, ...explain(r, base, pageOrigin) };
  return { ok: true, id: r.body.id, label: r.body.label, links: linksOf(base, r.body.id), profile: r.body };
}
