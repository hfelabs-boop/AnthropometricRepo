"""REST API (FastAPI). Run it with:  python -m anthro_service serve   (or: uvicorn anthro_service.rest:app)

Environment:
  ANTHRO_DATA_DIR      checkout of the repository (default: the folder above this package)
  ANTHRO_API_KEYS      comma-separated keys; when set, /v1 requests need  X-API-Key: <key>  or  Authorization: Bearer <key>
  ANTHRO_CORS_ORIGINS  comma-separated allowed origins (default *)
  ANTHRO_PROFILES      pushed profiles (/v1/profiles): on (default: this computer only, or anyone with a key when ANTHRO_API_KEYS is set), open (any client), off
  ANTHRO_PROFILE_DIR   where pushed profiles are kept (default ~/.anthro_service/profiles)
"""
from __future__ import annotations

import difflib
import hmac
import inspect
import logging
import os
import re
from collections import Counter
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, FastAPI, Path, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from fastapi.security import APIKeyHeader, HTTPAuthorizationCredentials, HTTPBearer
from starlette.exceptions import HTTPException as StarletteHTTPException

from . import models as M
from .core import ApiError, BadRequest, Repo, VERSION, get_repo
from .formats import MEDIA, RENDER, csv_headers, measures_csv
from .origins import clean_origin
from .profiles import MAX_BYTES, VIEWS, TooLarge, get_store, view_csv, view_xml

log = logging.getLogger("anthro_service")


class Unauthorized(ApiError):
    status = 401
    code = "unauthorized"


class Forbidden(ApiError):
    status = 403
    code = "forbidden"


class Disabled(ApiError):
    status = 404
    code = "not_found"


DESCRIPTION = """
Body-measurement statistics of **military populations** for digital-human and mannequin tools (CATIA Human Builder, Siemens Jack,
RAMSIS, AutoCAD scripts, Unreal/Blender add-ons, spreadsheets) and for AI agents.

* **Populations** are *country × role* (Army, Air Force, Navy, Aircrew, Pilots, Recruits/trainees ...) and *sex* (`M`, `F`, `both`).
* **Design values** give P5, P50 and P95 (or any percentile from 0.1 to 99.9) of every measure, with sample size, reliability and sources.
* **Mannequin** gives one value per dimension at a single percentile: the dimension set for a boundary or reference manikin.
* Lengths are **millimetres**, body mass **kg**; every value carries its unit.
* The value endpoints (`/v1/design-values`, `/v1/mannequin`, `/v1/compare`) can also return **CSV** or **XML**: add `?format=csv` or `?format=xml`; `/v1/populations/{country}/{role}/{sex}`
  also takes a `.csv` / `.xml` / `.json` suffix on `sex`. `/v1/measures` has CSV too. CSV carries the data only; the notes travel in the `X-Disclaimer`, `X-Notes` and
  `X-Hidden-By-Reliability` response headers, and XML has a `<notes>` element.
* In URL **paths** use ids (`united-states`, `recruits-trainees`) or names; names that contain `/` (Recruits/trainees) work too. The query-string forms take names or ids.
* List parameters are comma separated: `measures=stature,mass,sitting_height`.

**Reliability.** `min_reliability` defaults to `medium` (high and medium). `high` keeps only values whose sources are raw data, validated
tables or official defence documents, with printed percentiles and at least 100 people. `low` (or `all`) includes everything.

**Percentiles.** P5, P50 and P95 are the roll-up values (see `percentile_basis`: `reported` by the one survey, `pooled` from several surveys, or `estimated` from mean and SD).
Other percentiles are interpolated or extrapolated from them. Each dimension is the requested percentile *of that dimension alone*: a set
of same-percentile dimensions is a boundary case, not a typical body.

**Surveys.** By default the values combine every survey of the population, as the website does, which can mix decades (see `n_surveys`, `survey_spread_pct` and the notes).
Pass `survey=latest` for the most recent well-covered survey, or an id from `/v1/populations/{country}/{role}/surveys`.
"""

TAGS = [
    {"name": "values", "description": "Percentiles for design: the endpoints a CAD or DHM integration needs."},
    {"name": "profiles", "description": "Profiles pushed from the website's Digital human (Export tab, *Send to CAD*): the body, its measures and its posture, for CATIA and other "
                                        "CAD or digital-human tools. Served to this computer only unless the server has API keys (ANTHRO_API_KEYS) or ANTHRO_PROFILES=open."},
    {"name": "catalog", "description": "Countries, roles, measures, surveys and sources."},
    {"name": "service", "description": "Health and metadata."},
]

Fmt = Annotated[Literal["json", "csv", "xml"], Query(description="Output format. CSV and XML are flat tables.")]
CountryQ = Annotated[str, Query(description="Country name or id, e.g. `United States` or `united-states`.", examples=["United States"])]
RoleQ = Annotated[str, Query(description="Role (survey population) name or id, e.g. `Army`, `Air Force`, `Aircrew`, `Recruits/trainees`.", examples=["Army"])]
SexQ = Annotated[str, Query(description="`M`, `F` or `both` (mixed / not stated).", examples=["M"])]
MeasuresQ = Annotated[str | None, Query(description="Comma-separated measure keys (see /v1/measures), e.g. `stature,mass,sitting_height`. Default: all measures with data.")]
CategoriesQ = Annotated[str | None, Query(description="Comma-separated category names or ids (see /v1/categories), e.g. `heights-standing,seated`.")]
RelQ = Annotated[str, Query(description="Lowest reliability to include: `high`, `medium` (default) or `low`/`all`.")]
PidPath = Annotated[str, Path(description="A pushed profile's id from GET /v1/profiles, or `latest` for the newest one.", examples=["latest"])]
ViewPath = Annotated[Literal["values", "dims", "angles", "points", "document"], Path(description="values, dims, angles, points or document.")]
SurveyQ = Annotated[str | None, Query(description="Use one survey instead of the combined values: an id from /v1/populations/{country}/{role}/surveys, or `latest` for the most recent well-covered survey.")]


api_key = APIKeyHeader(name="X-API-Key", auto_error=False, description="Needed only when the server sets ANTHRO_API_KEYS.")
bearer = HTTPBearer(auto_error=False, description="Alternative to X-API-Key: `Authorization: Bearer <key>`.")


def guard(x_api_key: Annotated[str | None, Depends(api_key)] = None, auth: Annotated[HTTPAuthorizationCredentials | None, Depends(bearer)] = None):
    """Checks the API key when the server sets ANTHRO_API_KEYS (read per request, so tests and operators can change it)."""
    keys = [k.strip() for k in os.environ.get("ANTHRO_API_KEYS", "").split(",") if k.strip()]
    if not keys:
        return
    given = x_api_key or (auth.credentials if auth else "")
    if not any(hmac.compare_digest(given.encode(), k.encode()) for k in keys):
        raise Unauthorized("Missing or invalid API key.", "Send it as X-API-Key: <key> or Authorization: Bearer <key>.")


class UTF8JSON(JSONResponse):
    """JSON that declares its charset on the wire (Windows PowerShell 5.1 reads a response without one as ISO-8859-1 and garbles 'kg/m²'),
    while the OpenAPI document keeps the plain media type application/json."""
    media_type = "application/json"

    def init_headers(self, headers=None):
        super().init_headers(headers)
        self.raw_headers = [(k, b"application/json; charset=utf-8" if k == b"content-type" else v) for k, v in self.raw_headers]


class Edge:
    """Outermost pure-ASGI layer. (1) HEAD is answered like GET without the body; the app gets a copy of the scope, so the server still sees a HEAD request
    (uvicorn's httptools backend only tolerates a body-less answer with a Content-Length for HEAD). (2) Headers every answer must have, whatever produced it:
    CORS preflights, /openapi.json and refusals included: X-Data-Version, charset=utf-8 on JSON, and Vary: Origin when only some origins are allowed."""

    def __init__(self, app, data_version: str, vary_origin: bool = False):
        self.app, self.version, self.vary_origin = app, data_version.encode("ascii"), vary_origin

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        head = scope["method"] == "HEAD"
        pna = scope["method"] == "OPTIONS" and any(k.lower() == b"access-control-request-private-network" and v.lower() == b"true" for k, v in scope.get("headers", []))

        async def finish(message):
            if message["type"] == "http.response.start":
                headers = list(message.get("headers", []))
                if pna and not any(k.lower() == b"access-control-allow-private-network" for k, _ in headers):
                    # Private Network Access: a public website (the Digital human) may call this server on the user's own computer (Starlette < 1.x has no option for it)
                    headers.append((b"access-control-allow-private-network", b"true"))
                index = {k.lower(): i for i, (k, _) in enumerate(headers)}
                if b"x-data-version" not in index:
                    headers.append((b"x-data-version", self.version))
                i = index.get(b"content-type")
                if i is not None and headers[i][1].lower() == b"application/json":
                    headers[i] = (headers[i][0], b"application/json; charset=utf-8")
                if self.vary_origin:
                    j = index.get(b"vary")
                    tokens = [t.strip() for t in headers[j][1].split(b",")] if j is not None else []
                    if b"origin" not in [t.lower() for t in tokens]:
                        value = b", ".join(tokens + [b"Origin"])
                        if j is None:
                            headers.append((b"vary", value))
                        else:
                            headers[j] = (headers[j][0], value)
                message = {**message, "headers": headers}
            elif head and message["type"] == "http.response.body":
                message = {**message, "body": b""}
            await send(message)

        await self.app({**scope, "method": "GET"} if head else scope, receive, finish)


def cors_origins() -> list:
    """ANTHRO_CORS_ORIGINS: comma separated origins such as https://app.example.org; unset or empty means any origin (*). Mistakes stop the start-up
    with a message rather than silently locking every browser out."""
    raw = [x.strip() for x in os.environ.get("ANTHRO_CORS_ORIGINS", "").split(",") if x.strip()]
    if not raw or "*" in raw:
        return ["*"]
    out = []
    for o in raw:
        try:
            out.append(clean_origin(o))
        except ValueError as e:
            raise ValueError(f"ANTHRO_CORS_ORIGINS: {e}; use * for any origin.") from None
    return out


ALIASES = {"query": "q", "search": "q", "text": "q", "keyword": "q", "word": "q", "percentile": "percentiles", "pct": "percentile", "p": "percentile"}


def _declared(dependant) -> set:
    names = {p.alias or p.name for p in dependant.query_params}
    for sub in dependant.dependencies:
        names |= _declared(sub)
    return names


def strict_params(request: Request):
    """Reject query parameters the endpoint does not have: a misspelled `percentiles` on /v1/mannequin would otherwise silently return the P50 manikin."""
    dependant = getattr(request.scope.get("route"), "dependant", None)
    if dependant is None:
        return
    known = _declared(dependant)
    counts = Counter(k for k, _ in request.query_params.multi_items())  # one pass: a request with thousands of parameters stays cheap
    for name, times in counts.items():
        if name in known and times > 1:  # FastAPI would silently keep the last one
            raise BadRequest(f"Parameter '{name}' was given {times} times.", "Give each parameter once; lists are comma separated, for example measures=stature,mass.", sorted(known))
    for name in counts:
        if name not in known:
            close = difflib.get_close_matches(name, sorted(known), n=2, cutoff=0.6)
            if ALIASES.get(name) in known and ALIASES[name] not in close:
                close.insert(0, ALIASES[name])
            raise BadRequest(f"Unknown parameter '{name}' for this endpoint.", (f"Did you mean {' or '.join(repr(c) for c in close)}? " if close else "") +
                             "The parameters of each endpoint are in /docs (note: /v1/mannequin takes `percentile`, /v1/design-values takes `percentiles`, /v1/compare takes `countries`).", sorted(known))


def _list(s: str | None) -> list | None:
    if s is None or not s.strip():
        return None
    return [x.strip() for x in s.split(",") if x.strip()]


def _suffix(value: str, fmt: str) -> tuple:
    for ext in ("json", "csv", "xml"):
        if value.lower().endswith("." + ext):
            return value[: -len(ext) - 1], ext
    return value, fmt


TABLE = {200: {"description": "JSON by default; CSV or XML with format=csv or format=xml.", "content": {"text/csv": {"schema": {"type": "string"}}, "application/xml": {"schema": {"type": "string"}}}}}


def _send(kind: str, data, fmt: str):
    if fmt == "json":
        return data
    return Response(RENDER[kind][fmt](data), media_type=MEDIA[fmt], headers=csv_headers(data) if fmt == "csv" else None)


def create_app(data_dir: str | None = None) -> FastAPI:
    repo: Repo = get_repo(data_dir)

    app = FastAPI(title="Military Anthropometry API", version=VERSION, description=DESCRIPTION, openapi_tags=TAGS, default_response_class=UTF8JSON,
                  contact={"name": "Repository", "url": "https://github.com/hfelabs-boop/AnthropometricRepo"})

    @app.middleware("http")
    async def headers(request: Request, call_next):
        try:
            resp = await call_next(request)
        except Exception:  # answered here, inside CORS and this middleware, so the error carries the same headers as every other answer
            log.exception("unhandled error for %s", request.url.path)
            resp = UTF8JSON({"error": {"code": "internal_error", "message": "Internal error.", "hint": "This is a bug in the service; please report the request."}}, status_code=500)
        if request.method == "GET" and resp.status_code == 200 and request.url.path.startswith("/v1/") and "Cache-Control" not in resp.headers:
            if request.url.path == "/v1/health":
                resp.headers["Cache-Control"] = "no-store"
            else:
                resp.headers["Cache-Control"] = ("private" if os.environ.get("ANTHRO_API_KEYS", "").strip() else "public") + ", max-age=3600"
        return resp

    # added after `headers`, so they wrap it: CORS around the middleware above, the edge layer around everything
    origins = cors_origins()
    pna = {"allow_private_network": True} if "allow_private_network" in inspect.signature(CORSMiddleware.__init__).parameters else {}
    app.add_middleware(CORSMiddleware, allow_origins=origins, allow_methods=["GET", "HEAD", "OPTIONS", "POST", "DELETE"], allow_headers=["X-API-Key", "Authorization", "Content-Type"],
                       expose_headers=["X-Data-Version", "X-Total-Count", "X-Disclaimer", "X-Notes", "X-Hidden-By-Reliability", "Location"], **pna)
    app.add_middleware(Edge, data_version=repo.data_version, vary_origin=origins != ["*"])

    @app.exception_handler(ApiError)
    async def api_error(_: Request, e: ApiError):
        return UTF8JSON({"error": e.to_dict()}, status_code=e.status, headers={"WWW-Authenticate": 'Bearer realm="anthro"'} if e.status == 401 else None)

    @app.exception_handler(StarletteHTTPException)
    async def http_error(_: Request, e: StarletteHTTPException):
        code = {404: "not_found", 405: "method_not_allowed"}.get(e.status_code, "error")
        hint = {404: "No such endpoint. See /docs. Path forms take ids (united-states, recruits-trainees) or names; the query-string forms (/v1/design-values, /v1/mannequin) take either.",
                405: "Use GET; only /v1/profiles also takes POST (push a profile) and DELETE."}.get(e.status_code)
        body = {"code": code, "message": str(e.detail) if e.status_code not in (404, 405) else {404: "Not found.", 405: "Method not allowed."}[e.status_code]}
        if hint:
            body["hint"] = hint
        return UTF8JSON({"error": body}, status_code=e.status_code, headers=getattr(e, "headers", None))

    @app.exception_handler(RequestValidationError)
    async def invalid(_: Request, e: RequestValidationError):
        first = e.errors()[0] if e.errors() else {}
        where = ".".join(str(x) for x in first.get("loc", []) if x not in ("query", "path"))
        return UTF8JSON({"error": {"code": "bad_request", "message": f"{where}: {first.get('msg', 'invalid request')}".strip(": ")}}, status_code=422)

    err = {404: {"model": M.ErrorResponse}, 422: {"model": M.ErrorResponse}}
    v1 = APIRouter(prefix="/v1", dependencies=[Depends(guard), Depends(strict_params)], responses={**err, 401: {"model": M.ErrorResponse}})

    @app.get("/", include_in_schema=False)
    def root():
        return {"name": "Military Anthropometry API", "version": VERSION, "docs": "/docs", "openapi": "/openapi.json", "api": "/v1/meta"}

    @app.get("/v1/health", tags=["service"], summary="Liveness check")
    def health():
        return {"status": "ok", "version": VERSION, "data_version": repo.data_version}

    @v1.get("/meta", tags=["service"], summary="Version, counts, units, reliability and percentile definitions, attribution")
    def meta():
        return repo.meta()

    @v1.get("/countries", tags=["catalog"], response_model=list[M.CountryItem], summary="Countries with their roles")
    def countries():
        return repo.countries()

    @v1.get("/countries/{country}", tags=["catalog"], response_model=M.CountryItem, summary="Roles of one country")
    def country_roles(country: str):
        return repo.roles(country)

    @v1.get("/categories", tags=["catalog"], response_model=list[M.CategoryItem], summary="Measure categories")
    def categories():
        return repo.categories()

    @v1.get("/measures", tags=["catalog"], response_model=list[M.MeasureItem], summary="Search measures", responses={200: {"description": "JSON by default; CSV with format=csv.", "content": {"text/csv": TABLE[200]["content"]["text/csv"]}}},
            description="Measures with data, filtered by words in the name (`q`; whole words and common synonyms such as weight = mass, width = breadth), category, and optionally by population. "
                        "Best matches first: harmonized measures before as-published ones. `X-Total-Count` gives the number of matches before `limit`.")
    def measures(response: Response, q: Annotated[str | None, Query(description="Words in the name, e.g. `waist hip` or `sitting height`.")] = None,
                 category: Annotated[str | None, Query(description="Category name or id, e.g. `seated` (see /v1/categories).")] = None,
                 country: str | None = None, role: str | None = None, sex: str | None = None,
                 limit: Annotated[int | None, Query(ge=1, le=1000)] = None, format: Annotated[Literal["json", "csv"], Query()] = "json"):
        everything = repo.measures(category, q, country, role, sex)
        data = everything[:limit] if limit else everything
        if format == "json":
            response.headers["X-Total-Count"] = str(len(everything))
            return data
        return Response(measures_csv(data), media_type=MEDIA["csv"], headers={"X-Total-Count": str(len(everything))})

    @v1.get("/measures/{key:path}", tags=["catalog"], response_model=M.MeasureDetail, summary="One measure and the populations that have it")
    def measure(key: str):
        return repo.measure(key)

    @v1.get("/populations/{country}/{role:path}/surveys", tags=["catalog"], response_model=M.SurveyList, summary="Surveys of a population")
    def surveys(country: str, role: str):
        return repo.surveys(country, role)

    def _names(text, kind):
        return repo.split_names(text, kind) or None if text and text.strip() else None

    def design(country, role, sex, measures, categories, percentiles, min_reliability, survey, stats, fmt):
        d = repo.design_values(country, role, sex, _list(measures), _list(categories), _list(percentiles), min_reliability, survey, stats)
        return _send("design", d, fmt)

    @v1.get("/populations/{country}/{role:path}/{sex}", tags=["values"], response_model=M.DesignValues, response_model_exclude_unset=True, responses=TABLE,
            summary="Design values of one population (P5, P50, P95 or any percentiles)",
            description="The same path works on the static copy of the data: `/api/v1/populations/{country}/{role}/{sex}.json` (or `.csv`), with all "
                        "reliability levels and the default percentiles 5, 50, 95. `sex` may end in `.json`, `.csv` or `.xml`. `country` and `role` take ids or names "
                        "(`united-states`, `recruits-trainees` or `Recruits/trainees`).")
    def population(country: Annotated[str, Path(examples=["united-states"])], role: Annotated[str, Path(examples=["army"])], sex: Annotated[str, Path(examples=["M"])],
                   measures: MeasuresQ = None, categories: CategoriesQ = None,
                   percentiles: Annotated[str | None, Query(description="Comma-separated percentiles, 0.1 to 99.9. Default `5,50,95`.", examples=["5,50,95"])] = None,
                   min_reliability: RelQ = "medium", survey: SurveyQ = None,
                   stats: Annotated[bool, Query(description="Include mean and SD.")] = True, format: Fmt = "json"):
        sex, fmt = _suffix(sex, format)
        return design(country, role, sex, measures, categories, percentiles, min_reliability, survey, stats, fmt)

    @v1.get("/design-values", tags=["values"], response_model=M.DesignValues, response_model_exclude_unset=True, responses=TABLE, summary="Design values (query-string form)")
    def design_values(country: CountryQ, role: RoleQ, sex: SexQ = "M", measures: MeasuresQ = None, categories: CategoriesQ = None,
                      percentiles: Annotated[str | None, Query(description="Comma-separated percentiles, 0.1 to 99.9. Default `5,50,95`.")] = None,
                      min_reliability: RelQ = "medium", survey: SurveyQ = None, stats: bool = True, format: Fmt = "json"):
        return design(country, role, sex, measures, categories, percentiles, min_reliability, survey, stats, format)

    @v1.get("/mannequin", tags=["values"], response_model=M.Mannequin, responses=TABLE, summary="Dimension set for one percentile (boundary or reference manikin)",
            description="One value per dimension at a single percentile, plus `core` (stature, body mass, sitting height) and a flat `values` map "
                        "of key to number. Use it to size a manikin; call it three times (5, 50, 95) for a small, medium and large manikin.")
    def mannequin(country: CountryQ, role: RoleQ, sex: SexQ = "M",
                  percentile: Annotated[float, Query(ge=0.1, le=99.9, description="Percentile, 0.1 to 99.9.", examples=[95])] = 50,
                  measures: MeasuresQ = None, categories: CategoriesQ = None, min_reliability: RelQ = "medium", survey: SurveyQ = None, format: Fmt = "json"):
        return _send("mannequin", repo.mannequin(country, role, sex, percentile, _list(measures), _list(categories), min_reliability, survey), format)

    @v1.get("/compare", tags=["values"], response_model=M.Comparison, responses=TABLE, summary="One measure and percentile across populations")
    def compare(measure: Annotated[str, Query(description="Measure key, e.g. `stature`.", examples=["stature"])], sex: SexQ = "M",
                percentile: Annotated[float, Query(ge=0.1, le=99.9)] = 50,
                countries: Annotated[str | None, Query(description="Comma-separated countries to include.")] = None,
                roles: Annotated[str | None, Query(description="Comma-separated roles to include.")] = None,
                min_reliability: RelQ = "medium", min_n: Annotated[int, Query(ge=0)] = 0, limit: Annotated[int | None, Query(ge=1, le=1000)] = None,
                survey: Annotated[Literal["latest"] | None, Query(description="`latest`: compare each population's most recent survey instead of all its surveys combined.")] = None,
                format: Fmt = "json"):
        return _send("compare", repo.compare(measure, sex, percentile, _names(countries, "country"), _names(roles, "role"), min_reliability, min_n, limit, survey), format)

    @v1.get("/sources/{source_id}", tags=["catalog"], summary="Titles, links and official documents of a source id")
    def source(source_id: str):
        return repo.source(source_id)

    # ---- pushed profiles ---------------------------------------------------------------------------------------------------------
    names = {m["key"]: m["name"] for m in repo.measures()}

    def profiles_access(request: Request):
        """ANTHRO_PROFILES=on (default): with API keys, anyone with a key (guard checked it); without keys, this computer only. open: anyone. off: no profiles."""
        mode = os.environ.get("ANTHRO_PROFILES", "on").strip().lower() or "on"
        if mode in ("off", "0", "false", "no"):
            raise Disabled("Pushed profiles are switched off on this server (ANTHRO_PROFILES=off).")
        if mode == "open" or [k for k in os.environ.get("ANTHRO_API_KEYS", "").split(",") if k.strip()]:
            return
        host = request.client.host if request.client else ""
        if host not in ("127.0.0.1", "::1", "localhost") and not host.startswith("::ffff:127."):
            raise Forbidden("Pushed profiles are served to this computer only.", "Run the server on the CAD workstation, or set ANTHRO_API_KEYS (then send X-API-Key) "
                            "or ANTHRO_PROFILES=open on a trusted network.")

    def nocache(response: Response):
        response.headers["Cache-Control"] = "no-store"

    def links(pid: str) -> dict:
        b = f"/v1/profiles/{pid}"
        return {"self": b, "values_csv": f"{b}/values?format=csv", "values_xml": f"{b}/values?format=xml", "angles_csv": f"{b}/angles?format=csv",
                "points_csv": f"{b}/points?format=csv", "dims_csv": f"{b}/dims?format=csv", "document": f"{b}/document"}

    def send_view(view: str, data, fmt: str):
        if fmt == "json" or view == "document":
            return UTF8JSON(data, headers={"Cache-Control": "no-store"})
        body = view_csv(view, data) if fmt == "csv" else view_xml(view, data)
        return Response(body, media_type=MEDIA[fmt], headers={"Cache-Control": "no-store"})

    pr = APIRouter(prefix="/v1/profiles", tags=["profiles"], dependencies=[Depends(guard), Depends(strict_params), Depends(profiles_access), Depends(nocache)],
                   responses={**err, 401: {"model": M.ErrorResponse}, 403: {"model": M.ErrorResponse}})
    PUSH_BODY = {"requestBody": {"required": True, "description": f"A human-exchange JSON document (version 1) of the website's Export tab, or a digital-human-profile file of its Profile tab. At most {MAX_BYTES:,} bytes.",
                                 "content": {"application/json": {"schema": {"type": "object", "required": ["format", "version"], "properties": {"format": {"type": "string", "enum": ["human-exchange", "digital-human-profile"]}, "version": {"type": "integer", "enum": [1]}}}}}}}

    @pr.post("", status_code=201, summary="Push a profile (the website's Send to CAD)", openapi_extra=PUSH_BODY,
             description="Stores the document and returns its id and the URLs a CAD macro reads (values, angles, points, dims). The newest profile is also `latest`. "
                         f"The store keeps the {get_store().max} newest profiles.")
    async def push(request: Request):
        size = request.headers.get("content-length")
        if size and size.isdigit() and int(size) > MAX_BYTES:
            raise TooLarge(f"The document is {int(size):,} bytes; at most {MAX_BYTES:,} are accepted.")
        chunks, total = [], 0
        async for chunk in request.stream():
            total += len(chunk)
            if total > MAX_BYTES:
                raise TooLarge(f"The document is larger than {MAX_BYTES:,} bytes.")
            chunks.append(chunk)
        meta = get_store().push(b"".join(chunks), received_from=request.client.host if request.client else None)
        return UTF8JSON({**meta, "links": links(meta["id"])}, status_code=201, headers={"Location": f"/v1/profiles/{meta['id']}", "Cache-Control": "no-store"})

    @pr.get("", summary="Pushed profiles, newest first", responses=TABLE)
    def list_profiles(limit: Annotated[int | None, Query(ge=1, le=1000)] = None, format: Fmt = "json"):
        items = get_store().list(limit)
        if format == "json":
            return UTF8JSON({"count": len(items), "profiles": [{**m, "links": links(m["id"])} for m in items]}, headers={"Cache-Control": "no-store"})
        return send_view("list", items, format)

    @pr.get("/{profile_id}", summary="One pushed profile: summary, flat values and units (the /v1/mannequin shape)", responses=TABLE)
    def get_profile(profile_id: PidPath, format: Fmt = "json"):
        data = get_store().view(profile_id, "summary", names)
        data["links"] = links(data["profile"]["id"])
        return send_view("summary", data, format)

    @pr.get("/{profile_id}/{view}", summary="One view of a pushed profile: values, dims, angles, points or the whole document", responses=TABLE,
            description="`values`: the measures (mm, kg) as `values`/`units` and a table; `dims`: the dimension table of the website's model; `angles`: every joint degree of "
                        "freedom of the posture (degrees) with its range; `points`: joint centres and landmarks of the posed figure (mm; +Y up, +Z front, +X the figure's left); "
                        "`document`: the human-exchange JSON as pushed.")
    def get_view(profile_id: PidPath, view: ViewPath, format: Fmt = "json"):
        return send_view(view, get_store().view(profile_id, view, names), format)

    @pr.delete("/{profile_id}", summary="Delete a pushed profile")
    def delete_profile(profile_id: PidPath):
        return get_store().delete(profile_id)

    app.include_router(v1)
    app.include_router(pr)
    return app


app = create_app()
