"""REST API (FastAPI). Run it with:  python -m anthro_service serve   (or: uvicorn anthro_service.rest:app)

Environment:
  ANTHRO_DATA_DIR      checkout of the repository (default: the folder above this package)
  ANTHRO_API_KEYS      comma-separated keys; when set, /v1 requests need  X-API-Key: <key>  or  Authorization: Bearer <key>
  ANTHRO_CORS_ORIGINS  comma-separated allowed origins (default *)
"""
from __future__ import annotations

import hmac
import os
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, FastAPI, Header, Path, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response

from . import models as M
from .core import ApiError, Repo, VERSION, get_repo
from .formats import MEDIA, RENDER, measures_csv


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
* Every endpoint that returns a table can also return **CSV** or **XML**: add `?format=csv`, or end the last path segment with `.csv` / `.xml` / `.json`.
* List parameters are comma separated: `measures=stature,mass,sitting_height`.

**Reliability.** `min_reliability` defaults to `medium` (high and medium). `high` keeps only values whose sources are raw data, validated
tables or official defence documents, with printed percentiles and at least 100 people. `low` (or `all`) includes everything.

**Percentiles.** P5, P50 and P95 are the roll-up values (printed by the sources, or estimated from mean and SD: see `percentile_basis`).
Other percentiles are interpolated or extrapolated from them. Each dimension is the requested percentile *of that dimension alone*: a set
of same-percentile dimensions is a boundary case, not a typical body.
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
SurveyQ = Annotated[str | None, Query(description="Use one survey instead of the combined values (ids from /v1/populations/{country}/{role}/surveys).")]


def _list(s: str | None) -> list | None:
    if s is None or not s.strip():
        return None
    return [x.strip() for x in s.split(",") if x.strip()]


def _suffix(value: str, fmt: str) -> tuple:
    for ext in ("json", "csv", "xml"):
        if value.lower().endswith("." + ext):
            return value[: -len(ext) - 1], ext
    return value, fmt


def _send(kind: str, data, fmt: str):
    if fmt == "json":
        return data
    return Response(RENDER[kind][fmt](data), media_type=MEDIA[fmt])


def create_app(data_dir: str | None = None) -> FastAPI:
    repo: Repo = get_repo(data_dir)

    def guard(x_api_key: Annotated[str | None, Header(alias="X-API-Key", include_in_schema=False)] = None,
              authorization: Annotated[str | None, Header(include_in_schema=False)] = None):
        keys = [k.strip() for k in os.environ.get("ANTHRO_API_KEYS", "").split(",") if k.strip()]
        if not keys:
            return
        given = x_api_key or (authorization[7:].strip() if authorization and authorization.lower().startswith("bearer ") else "")
        if not any(hmac.compare_digest(given.encode(), k.encode()) for k in keys):
            raise Unauthorized("Missing or invalid API key.", "Send it as X-API-Key: <key> or Authorization: Bearer <key>.")

    app = FastAPI(title="Military Anthropometry API", version=VERSION, description=DESCRIPTION, openapi_tags=TAGS,
                  contact={"name": "Repository", "url": "https://github.com/hfelabs-boop/AnthropometricRepo"})
    app.add_middleware(CORSMiddleware, allow_origins=[o.strip() for o in os.environ.get("ANTHRO_CORS_ORIGINS", "*").split(",") if o.strip()],
                       allow_methods=["GET", "OPTIONS"], allow_headers=["X-API-Key", "Authorization", "Content-Type"], expose_headers=["X-Data-Version"])

    @app.middleware("http")
    async def headers(request: Request, call_next):
        resp = await call_next(request)
        resp.headers["X-Data-Version"] = repo.data_version
        if request.method == "GET" and resp.status_code == 200 and request.url.path.startswith("/v1/") and "Cache-Control" not in resp.headers:
            resp.headers["Cache-Control"] = ("private" if os.environ.get("ANTHRO_API_KEYS", "").strip() else "public") + ", max-age=3600"
        return resp

    @app.exception_handler(ApiError)
    async def api_error(_: Request, e: ApiError):
        return JSONResponse({"error": e.to_dict()}, status_code=e.status)

    @app.exception_handler(RequestValidationError)
    async def invalid(_: Request, e: RequestValidationError):
        first = e.errors()[0] if e.errors() else {}
        where = ".".join(str(x) for x in first.get("loc", []) if x not in ("query", "path"))
        return JSONResponse({"error": {"code": "bad_request", "message": f"{where}: {first.get('msg', 'invalid request')}".strip(": ")}}, status_code=422)

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

    @v1.get("/measures", tags=["catalog"], response_model=list[M.MeasureItem], summary="Search measures",
            description="Measures with data, filtered by words in the name (`q`), category, and optionally by population.")
    def measures(q: Annotated[str | None, Query(description="Words in the name, e.g. `waist hip` or `sitting height`.")] = None,
                 category: Annotated[str | None, Query(description="Category name or id, e.g. `seated`.")] = None,
                 country: str | None = None, role: str | None = None, sex: str | None = None,
                 limit: Annotated[int | None, Query(ge=1, le=1000)] = None, format: Annotated[Literal["json", "csv"], Query()] = "json"):
        data = repo.measures(category, q, country, role, sex, limit)
        return data if format == "json" else Response(measures_csv(data), media_type=MEDIA["csv"])

    @v1.get("/measures/{key:path}", tags=["catalog"], response_model=M.MeasureDetail, summary="One measure and the populations that have it")
    def measure(key: str):
        return repo.measure(key)

    @v1.get("/populations/{country}/{role}/surveys", tags=["catalog"], response_model=M.SurveyList, summary="Surveys of a population")
    def surveys(country: str, role: str):
        return repo.surveys(country, role)

    def design(country, role, sex, measures, categories, percentiles, min_reliability, survey, stats, fmt):
        d = repo.design_values(country, role, sex, _list(measures), _list(categories), _list(percentiles), min_reliability, survey, stats)
        return _send("design", d, fmt)

    @v1.get("/populations/{country}/{role}/{sex}", tags=["values"], response_model=M.DesignValues, response_model_exclude_unset=True,
            summary="Design values of one population (P5, P50, P95 or any percentiles)",
            description="The same path works on the static copy of the data: `/api/v1/populations/{country}/{role}/{sex}.json` (or `.csv`), with all "
                        "reliability levels and the default percentiles 5, 50, 95. `sex` may end in `.json`, `.csv` or `.xml`.")
    def population(country: Annotated[str, Path(examples=["united-states"])], role: Annotated[str, Path(examples=["army"])], sex: Annotated[str, Path(examples=["M"])],
                   measures: MeasuresQ = None, categories: CategoriesQ = None,
                   percentiles: Annotated[str | None, Query(description="Comma-separated percentiles, 0.1 to 99.9. Default `5,50,95`.", examples=["5,50,95"])] = None,
                   min_reliability: RelQ = "medium", survey: SurveyQ = None,
                   stats: Annotated[bool, Query(description="Include mean and SD.")] = True, format: Fmt = "json"):
        sex, fmt = _suffix(sex, format)
        return design(country, role, sex, measures, categories, percentiles, min_reliability, survey, stats, fmt)

    @v1.get("/design-values", tags=["values"], response_model=M.DesignValues, response_model_exclude_unset=True, summary="Design values (query-string form)")
    def design_values(country: CountryQ, role: RoleQ, sex: SexQ = "M", measures: MeasuresQ = None, categories: CategoriesQ = None,
                      percentiles: Annotated[str | None, Query(description="Comma-separated percentiles, 0.1 to 99.9. Default `5,50,95`.")] = None,
                      min_reliability: RelQ = "medium", survey: SurveyQ = None, stats: bool = True, format: Fmt = "json"):
        return design(country, role, sex, measures, categories, percentiles, min_reliability, survey, stats, format)

    @v1.get("/mannequin", tags=["values"], response_model=M.Mannequin, summary="Dimension set for one percentile (boundary or reference manikin)",
            description="One value per dimension at a single percentile, plus `core` (stature, body mass, sitting height, BMI) and a flat `values` map "
                        "of key to number. Use it to size a manikin; call it three times (5, 50, 95) for a small, medium and large manikin.")
    def mannequin(country: CountryQ, role: RoleQ, sex: SexQ = "M",
                  percentile: Annotated[float, Query(ge=0.1, le=99.9, description="Percentile, 0.1 to 99.9.", examples=[95])] = 50,
                  measures: MeasuresQ = None, categories: CategoriesQ = None, min_reliability: RelQ = "medium", survey: SurveyQ = None, format: Fmt = "json"):
        return _send("mannequin", repo.mannequin(country, role, sex, percentile, _list(measures), _list(categories), min_reliability, survey), format)

    @v1.get("/compare", tags=["values"], response_model=M.Comparison, summary="One measure and percentile across populations")
    def compare(measure: Annotated[str, Query(description="Measure key, e.g. `stature`.", examples=["stature"])], sex: SexQ = "M",
                percentile: Annotated[float, Query(ge=0.1, le=99.9)] = 50,
                countries: Annotated[str | None, Query(description="Comma-separated countries to include.")] = None,
                roles: Annotated[str | None, Query(description="Comma-separated roles to include.")] = None,
                min_reliability: RelQ = "medium", min_n: Annotated[int, Query(ge=0)] = 0, limit: Annotated[int | None, Query(ge=1, le=1000)] = None, format: Fmt = "json"):
        return _send("compare", repo.compare(measure, sex, percentile, _list(countries), _list(roles), min_reliability, min_n, limit), format)

    @v1.get("/sources/{source_id}", tags=["catalog"], summary="Titles, links and official documents of a source id")
    def source(source_id: str):
        return repo.source(source_id)

    app.include_router(v1)
    return app


app = create_app()
