"""Response models. They only describe the shape for the OpenAPI document and client code generators; the numbers come from core.py."""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

Reliability = Literal["high", "medium", "low"]
Basis = Literal["reported", "pooled", "estimated", "interpolated", "extrapolated", "unavailable"]
SexCode = Literal["M", "F", "both"]


class ErrorBody(BaseModel):
    code: str = Field(examples=["not_found"])
    message: str
    hint: str | None = None
    available: list[str] | None = Field(None, description="Valid values to choose from, or (when `closest` is true) only the nearest matches.")
    closest: bool | None = Field(None, description="True when `available` holds the nearest matches to what was asked, not every valid value.")


class ErrorResponse(BaseModel):
    error: ErrorBody


class SurveyRef(BaseModel):
    id: str = Field(examples=["ansur-ii-2012"])
    name: str = Field(examples=["ANSUR II 2012"])
    year: int | None = None


class Population(BaseModel):
    country: str
    country_id: str
    role: str = Field(description="Survey population: Army, Air Force, Navy, Aircrew, Pilots, Recruits/trainees ...")
    role_id: str
    sex: SexCode = Field(description="M, F, or both (mixed or not stated).")
    sex_name: str
    survey: SurveyRef | None = Field(None, description="Set when one survey was requested; null for the combined values of the population.")
    surveys_combined: list[SurveyRef] = Field(description="Surveys that make up the combined values (empty when a single survey was requested).")
    years: list[int] | None = Field(None, description="First and last year of measurement.")


class MeasureValues(BaseModel):
    key: str = Field(examples=["stature"])
    name: str = Field(examples=["Stature"])
    category: str = Field(examples=["Heights (standing)"])
    harmonized: bool = Field(description="True for the 59 measures defined the same way in every survey; false for as-published measures, whose definition is whatever the source printed.")
    unit: str = Field(description="mm, kg, kg/m2, years, or the printed unit of an as-published measure (%, ratio, degrees ...).", examples=["mm"])
    n: int | None = Field(None, description="Number of people.")
    mean: float | None = None
    sd: float | None = None
    percentiles: dict[str, float | None] = Field(description='Value at each requested percentile, keyed "p5", "p50", "p95", "p97.5" ...', examples=[{"p5": 1642.5, "p50": 1749.3, "p95": 1862.7}])
    percentile_basis: dict[str, Basis] = Field(description="How each percentile was obtained: `reported` by the one survey it comes from, `pooled` from several surveys that each printed theirs "
                                                         "(no source prints this exact number), `estimated` from mean and SD, `interpolated` or `extrapolated` from P5/P50/P95.")
    reliability: Reliability
    reliability_note: str | None = Field(None, description="Why the value is not high reliability.")
    n_surveys: int = Field(description="Number of surveys combined in this value (1 = a single survey).")
    survey_spread_pct: float | None = Field(None, description="When several surveys are combined: (largest survey mean - smallest) / combined mean, in percent. Large values mean the surveys disagree "
                                                              "(different landmark definitions, or real change in body size over the years).")
    official_documents: list[str] = Field(description="Official defence or standards documents the data come from, if any.")
    sources: list[str] = Field(description="Source ids; GET /v1/sources/{id} gives titles and links.")
    years: list[int | None] | None = None
    printed_name: str | None = Field(None, description="The name the source printed, when it differs from the common name.")


class DesignValues(BaseModel):
    population: Population
    percentiles: list[str]
    min_reliability: Reliability
    count: int
    hidden_by_reliability: int
    measures: list[MeasureValues]
    notes: list[str]


class Dimension(BaseModel):
    key: str
    name: str
    category: str
    harmonized: bool
    unit: str
    value: float
    basis: Basis
    n: int | None = None
    reliability: Reliability
    years: list[int | None] | None = Field(None, description="First and last year of measurement of the surveys behind this value.")
    sources: list[str] = Field(description="Source ids behind this value.")
    n_surveys: int
    survey_spread_pct: float | None = None


class Unavailable(BaseModel):
    key: str
    name: str
    unit: str
    mean: float | None = None
    n: int | None = None
    reliability: Reliability


class Mannequin(BaseModel):
    population: Population
    percentile: float
    min_reliability: Reliability
    count: int
    hidden_by_reliability: int
    core: dict[str, float] = Field(description="Stature (mm), body mass (kg) and sitting height (mm) at this percentile, when available.")
    values: dict[str, float] = Field(description="Measure key to value in the measure's unit (see `units`): the flat dimension set.")
    units: dict[str, str] = Field(description="Measure key to unit for every key in `values`: millimetres for lengths, but also kg, kg/m2, years, %, N, ratios ...")
    caution: dict[str, list[str]] = Field(description="Keys of `values` that need care, with the reasons: lower reliability, estimated or extrapolated, surveys that disagree.")
    dimensions: list[Dimension]
    unavailable: list[Unavailable] = Field(description="Measures that exist for this population but have only a mean (no percentiles), so they are not in `values`.")
    notes: list[str]


class MeasureRef(BaseModel):
    key: str
    name: str
    unit: str
    category: str


class CompareRow(BaseModel):
    country: str
    country_id: str
    role: str
    role_id: str
    value: float
    basis: Basis
    mean: float | None = None
    n: int | None = None
    reliability: Reliability
    sources: list[str]
    years: list[int | None] | None = None
    n_surveys: int


class Comparison(BaseModel):
    measure: MeasureRef
    sex: SexCode
    percentile: float
    min_reliability: Reliability
    survey: str | None = Field(None, description="`latest` when each population's most recent survey was used; null for the combined values.")
    count: int = Field(description="Rows in `results`.")
    total: int = Field(description="Populations that matched before `limit`.")
    truncated: bool
    no_data: dict[str, list[str]] = Field(description="Requested countries or roles that have no result, under the keys `countries` and `roles`.")
    results: list[CompareRow]
    notes: list[str]


class MeasureItem(BaseModel):
    key: str
    name: str
    category: str
    unit: str
    note: str | None = None
    harmonized: bool
    populations: int = Field(description="Number of country/role populations with data.")


class RoleSummary(BaseModel):
    id: str
    name: str
    sexes: list[SexCode]
    measures: int
    surveys: int = Field(description="Surveys listed for this population (GET .../surveys).")
    surveys_in_combined_values: int = Field(description="Of those, the surveys that contribute to the combined values.")


class CountryItem(BaseModel):
    id: str
    name: str
    roles: list[RoleSummary]


class MeasurePopulation(BaseModel):
    country: str
    country_id: str
    role: str
    role_id: str
    sexes: list[SexCode]


class MeasureDetail(BaseModel):
    key: str
    name: str
    category: str
    unit: str
    note: str | None = None
    harmonized: bool
    populations: list[MeasurePopulation]


class CategoryItem(BaseModel):
    id: str
    name: str
    measures: int


class SurveyItem(BaseModel):
    id: str
    name: str
    year: int | None = None
    n: dict[str, int]
    sexes: list[SexCode]
    source_id: str
    official_document: str | None = None
    in_combined_values: bool


class SurveyList(BaseModel):
    country: str
    country_id: str
    role: str
    role_id: str
    surveys: list[SurveyItem]
