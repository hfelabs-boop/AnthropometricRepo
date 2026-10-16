"""Response models. They only describe the shape for the OpenAPI document and client code generators; the numbers come from core.py."""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

Reliability = Literal["high", "medium", "low"]
Basis = Literal["reported", "estimated", "interpolated", "extrapolated", "unavailable"]
SexCode = Literal["M", "F", "both"]


class ErrorBody(BaseModel):
    code: str = Field(examples=["not_found"])
    message: str
    hint: str | None = None
    available: list[str] | None = Field(None, description="Valid values to choose from, or the closest matches.")


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
    unit: str = Field(description="mm, kg, kg/m2, years, or the printed unit of an as-published measure (%, ratio, degrees ...).", examples=["mm"])
    n: int | None = Field(None, description="Number of people.")
    mean: float | None = None
    sd: float | None = None
    percentiles: dict[str, float | None] = Field(description='Value at each requested percentile, keyed "p5", "p50", "p95", "p97.5" ...', examples=[{"p5": 1642.5, "p50": 1749.3, "p95": 1862.7}])
    percentile_basis: dict[str, Basis] = Field(description="How each percentile was obtained: reported by the source, estimated from mean and SD, interpolated or extrapolated from P5/P50/P95.")
    reliability: Reliability
    reliability_note: str | None = Field(None, description="Why the value is not high reliability.")
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
    unit: str
    value: float
    basis: Basis
    n: int | None = None
    reliability: Reliability


class Mannequin(BaseModel):
    population: Population
    percentile: float
    min_reliability: Reliability
    count: int
    hidden_by_reliability: int
    core: dict[str, float] = Field(description="Stature, body mass, sitting height and BMI at this percentile, when available.")
    values: dict[str, float] = Field(description="Measure key to value in the measure's unit: the flat dimension set.")
    dimensions: list[Dimension]
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


class Comparison(BaseModel):
    measure: MeasureRef
    sex: SexCode
    percentile: float
    min_reliability: Reliability
    count: int
    results: list[CompareRow]
    notes: list[str]


class MeasureItem(BaseModel):
    key: str
    name: str
    category: str
    unit: str
    note: str | None = None
    populations: int = Field(description="Number of country/role populations with data.")


class RoleSummary(BaseModel):
    id: str
    name: str
    sexes: list[SexCode]
    measures: int
    surveys: int


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
