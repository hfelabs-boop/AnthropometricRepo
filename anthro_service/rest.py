"""REST API (FastAPI). Run it with:  python -m anthro_service serve   (or: uvicorn anthro_service.rest:app)

Environment:
  ANTHRO_DATA_DIR      checkout of the repository (default: the folder above this package)
  ANTHRO_API_KEYS      comma-separated keys; when set, /v1 requests need  X-API-Key: <key>  or  Authorization: Bearer <key>
  ANTHRO_CORS_ORIGINS  comma-separated allowed origins (default *)
"""
from __future__ import annotations

import hmac
import logging
import os
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, FastAPI, Path, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from fastapi.security import APIKeyHeader, HTTPAuthorizationCredentials, HTTPBearer
from starlette.exceptions import HTTPException as StarletteHTTPException

from . import models as M
from .core import ApiError, Repo, VERSION, get_repo
from .formats import MEDIA, RENDER, csv_headers, measures_csv

log = logging.getLogger("anthro_service")


class Unauthorized(ApiError):
    status = 401
    code = "unauthorized"


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

    app = FastAPI(title="Military Anthropometry API", version=VERSION, description=DESCRIPTION, openapi_tags=TAGS,
                  contact={"name": "Repository", "url": "https://github.com/hfelabs-boop/AnthropometricRepo"})
    app.add_middleware(CORSMiddleware, allow_origins=[o.strip() for o in os.environ.get("ANTHRO_CORS_ORIGINS", "*").split(",") if o.strip()],
                       allow_methods=["GET", "HEAD", "OPTIONS"], allow_headers=["X-API-Key", "Authorization", "Content-Type"],
                       expose_headers=["X-Data-Version", "X-Total-Count", "X-Disclaimer", "X-Notes", "X-Hidden-By-Reliability"])

    @app.middleware("http")
    async def headers(request: Request, call_next):
        head = request.method == "HEAD"
        if head:  # FastAPI routes only GET; answer HEAD with the GET headers and no body
            request.scope["method"] = "GET"
        resp = await call_next(request)
        resp.headers["X-Data-Version"] = repo.data_version
        if request.method == "GET" and resp.status_code == 200 and request.url.path.startswith("/v1/") and "Cache-Control" not in resp.headers:
            if request.url.path == "/v1/health":
                resp.headers["Cache-Control"] = "no-store"
            else:
                resp.headers["Cache-Control"] = ("private" if os.environ.get("ANTHRO_API_KEYS", "").strip() else "public") + ", max-age=3600"
        if head:
            async for _ in resp.body_iterator:
                pass
            resp = Response(status_code=resp.status_code, headers=dict(resp.headers))
        return resp

    @app.exception_handler(ApiError)
    async def api_error(_: Request, e: ApiError):
        return JSONResponse({"error": e.to_dict()}, status_code=e.status, headers={"WWW-Authenticate": 'Bearer realm="anthro"'} if e.status == 401 else None)

    @app.exception_handler(StarletteHTTPException)
    async def http_error(_: Request, e: StarletteHTTPException):
        code = {404: "not_found", 405: "method_not_allowed"}.get(e.status_code, "error")
        hint = {404: "No such endpoint. See /docs. Path forms take ids (united-states, recruits-trainees) or names; the query-string forms (/v1/design-values, /v1/mannequin) take either.",
                405: "This API is read-only: use GET."}.get(e.status_code)
        body = {"code": code, "message": str(e.detail) if e.status_code not in (404, 405) else {404: "Not found.", 405: "Method not allowed."}[e.status_code]}
        if hint:
            body["hint"] = hint
        return JSONResponse({"error": body}, status_code=e.status_code, headers=getattr(e, "headers", None))

    @app.exception_handler(RequestValidationError)
    async def invalid(_: Request, e: RequestValidationError):
        first = e.errors()[0] if e.errors() else {}
        where = ".".join(str(x) for x in first.get("loc", []) if x not in ("query", "path"))
        return JSONResponse({"error": {"code": "bad_request", "message": f"{where}: {first.get('msg', 'invalid request')}".strip(": ")}}, status_code=422)

    @app.exception_handler(Exception)
    async def crash(request: Request, e: Exception):
        log.exception("unhandled error for %s", request.url.path)
        return JSONResponse({"error": {"code": "internal_error", "message": "Internal error.", "hint": "This is a bug in the service; please report the request."}}, status_code=500)

    err = {404: {"model": M.ErrorResponse}, 422: {"model": M.ErrorResponse}}
    v1 = APIRouter(prefix="/v1", dependencies=[Depends(guard)], responses={**err, 401: {"model": M.ErrorResponse}})

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

    @v1.get("/measures", tags=["catalog"], response_model=list[M.MeasureItem], summary="Search measures", responses={200: {**TABLE[200], "content": {"text/csv": TABLE[200]["content"]["text/csv"]}}},
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
            description="One value per dimension at a single percentile, plus `core` (stature, body mass, sitting height, BMI) and a flat `values` map "
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
        return _send("compare", repo.compare(measure, sex, percentile, _list(countries), _list(roles), min_reliability, min_n, limit, survey), format)

    @v1.get("/sources/{source_id}", tags=["catalog"], summary="Titles, links and official documents of a source id")
    def source(source_id: str):
        return repo.source(source_id)

    app.include_router(v1)
    return app


app = create_app()
