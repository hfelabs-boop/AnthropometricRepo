# Anthropometry API and MCP server

Body-measurement statistics of military populations (country × role × sex) for **digital-human and mannequin tools** (CATIA Human Builder, Siemens Jack, RAMSIS, AutoCAD or Blender scripts, spreadsheets) and for **AI assistants**. It serves the same numbers as the website's *By country & role* and *Design values* views: P5, P50, P95 (or any percentile) of 571 measures in 130 populations, with sample size, a reliability rating, the official document each value comes from, and the sources.

Three ways to use it, from simplest to most flexible:

| | Needs | Good for |
|---|---|---|
| **Static files** at `/api/v1/…` on the website | nothing (a plain HTTP GET) | scripts, spreadsheets, any tool that can open a URL or a CSV |
| **REST API** (`python -m anthro_service serve`) | Python 3.10+, `pip install -r anthro_service/requirements.txt` | any percentile, filters, one survey, XML, an OpenAPI description for generated clients |
| **MCP server** (`python -m anthro_service mcp`) | the same | AI assistants (Claude Desktop, Claude Code, Cursor, ...) that drive a CAD or digital-human tool |

The library in `core.py` and the static-file generator use only the standard library.

> **Read this first.**
> * Every number is a population statistic, not a measurement of any person, and **each dimension is the requested percentile of that dimension alone.** A manikin built from P95 stature, P95 mass, P95 sitting height ... is a *boundary case*; real 95th-percentile soldiers differ in proportions.
> * **By default the values combine every survey of the population**, as the website does, and that can span decades: the US Army men's values mix 1966, 1987 and 2010, and 53 % of the people are from 1966. Body size and landmark definitions changed over such a period (the surveys' mean body mass differs by 17 %). For current personnel use **`survey=latest`** (or pick a survey from the survey list); the answers say when the combined values span more than 15 years.
> * Check `reliability`, `basis`, `years`, `sources` and `caution` before you rely on a value. This is not an official standard (MIL-STD-1472, DOD-HDBK-743A) and does not replace one.

## Quick start

```bash
pip install -r anthro_service/requirements.txt
python -m anthro_service serve                       # http://127.0.0.1:8000  (interactive docs at /docs)

curl "http://127.0.0.1:8000/v1/mannequin?country=United%20States&role=Air%20Force&sex=M&percentile=95&measures=stature,mass,sitting_height"
curl "http://127.0.0.1:8000/v1/populations/united-states/army/M.csv?measures=stature,mass&survey=latest"
python anthro_service/examples/python_client.py
```

The first call returns (abridged):

```json
{
  "population": {"country": "United States", "role": "Air Force", "sex": "M", "survey": null,
                 "surveys_combined": [{"id": "rp1024-vol2-s19-usaf-survey-1965", "name": "S19 USAF SURVEY 1965", "year": 1965}], "years": [1965, 1965]},
  "percentile": 95,
  "core": {"stature_mm": 1862.0, "body_mass_kg": 91.0, "sitting_height_mm": 969.0},
  "values": {"mass": 91.0, "stature": 1862.0, "sitting_height": 969.0},
  "units": {"mass": "kg", "stature": "mm", "sitting_height": "mm"},
  "caution": {"sitting_height": ["medium reliability", "estimated"]},
  "dimensions": [{"key": "stature", "name": "Stature", "unit": "mm", "value": 1862.0, "basis": "reported", "n": 3859, "reliability": "high",
                  "years": [1965, 1965], "sources": ["rp1024-vol2"], "n_surveys": 1, "survey_spread_pct": null}, "…"],
  "unavailable": [],
  "notes": ["Population statistics for design studies, …", "Every dimension is percentile 95 of that dimension alone: a boundary case, not a typical body.", "…"]
}
```

`values` is the flat `{measure key: number}` map a manikin needs, in the units of `units` (mostly millimetres, but also kg, kg/m², years, %, …); `dimensions` adds how each number was obtained, its sample size, years and sources; `caution` names the values that need care and why; `unavailable` lists measures that exist for the population but have only a mean.

## Concepts

* **Population** = *country* + *role* (the survey population: `Army`, `Air Force`, `Navy`, `Marine Corps`, `Aircrew`, `Pilots`, `Officers`, `Recruits/trainees` ...) + *sex* (`M`, `F`, or `both` for mixed or not stated). Names, ids (`united-states`, `air-force`) and common aliases (`USA`, `UK`) work; `GET /v1/countries` lists what has data (54 countries and 3 pooled multi-country samples named `Multiple: …`).
* **Combined or one survey.** By default the values combine every survey of the population. `survey=<id>` uses one survey; `survey=latest` uses the most recent survey that has at least 100 people (when any has) and at least half as many measures as the best-covered survey. `GET /v1/populations/{country}/{role}/surveys` lists the surveys with year, sample size and official document. The ids of non-catalog papers are long slugs: copy them from the list.
* **Measures** have a key. 59 *harmonized* measures (`stature`, `mass`, `sitting_height`, `buttock_knee_length`, `hand_length`, `chest_circumference`, …) are defined the same way in every survey that has them and are merged across surveys: the surveys may still differ in landmark definitions or protocol, which `survey_spread_pct` and `caution` make visible. 512 more are *as published* (`other:waist_back_length_omphalion`), whose definition is whatever the source printed. Search with `GET /v1/measures?q=shoulder breadth` (whole words, common synonyms such as weight = mass and width = breadth, harmonized measures first), browse by `category` (`heights-standing`, `seated`, `circumferences`, …).
* **Units.** Lengths **millimetres**, body mass **kg**, BMI kg/m², age years; as-published measures keep their printed unit (%, ratio, degrees, N). Every value carries its `unit`, and `mannequin` has a `units` map for the flat `values`.
* **Percentiles and `percentile_basis`.** P5, P50 and P95 are the roll-up values: `reported` when the one survey behind them printed them; `pooled` when several surveys each printed theirs and the service quotes the n-weighted mixture (no single source prints that exact number: quote the survey, not the pooled value, if you need a table value from a document); `estimated` from mean and SD (normal; lognormal for skewed positive measures). Other percentiles (0.1 to 99.9) are `interpolated` (5 < p < 95) or `extrapolated` on the line through P5, P50, P95 that is linear in the normal score; for strongly right-skewed positive measures such as skinfolds the lower tail follows the same line on the log scale, so a length never comes out below zero. Extrapolated values are less certain the further out.
* **Reliability.** `high` = raw data, a validated table or an official defence document, printed percentiles, at least 100 people. `low` = an unchecked web article, fewer than 30 people, or no percentiles/SD. `medium` = in between. `min_reliability` defaults to **`medium`** (high and medium); use `high` for design decisions or `low` / `all` to see everything. The answer says how many values were hidden. Values taken from an official document list it in `official_documents`.
* **Counts.** `meta` counts populations (130), measures that have data (571), values (6968) and the surveys that can be listed (369). Survey groups of populations that have no roll-up values are not queryable and are not counted.

## REST API

Base `http://host:8000`; interactive documentation at `/docs`, the machine-readable description at `/openapi.json` (a copy is committed as [`openapi.json`](openapi.json), so you can generate a client with openapi-generator, NSwag or similar without running the server).

| Endpoint | Returns |
|---|---|
| `GET /v1/populations/{country}/{role}/{sex}` | design values: percentiles of every (or chosen) measure, with mean, SD, n, reliability, basis, years, sources |
| `GET /v1/design-values?country=&role=&sex=` | the same, query-string form |
| `GET /v1/mannequin?country=&role=&sex=&percentile=` | one value per dimension at one percentile + `core` + flat `values`, `units`, `caution`, per-dimension years and sources |
| `GET /v1/compare?measure=stature&percentile=95&sex=M` | the same measure and percentile across populations, highest first (`total`, `no_data`; `survey=latest` compares each population's most recent survey) |
| `GET /v1/countries`, `/v1/countries/{country}` | countries, roles, sexes with data |
| `GET /v1/measures?q=&category=&country=&role=&sex=&limit=`, `/v1/measures/{key}` | search measures (`X-Total-Count` header); populations that have one |
| `GET /v1/categories` | measure categories |
| `GET /v1/populations/{country}/{role}/surveys` | the individual surveys behind a population |
| `GET /v1/sources/{id}` | titles, links and official document of a source; the `licence` where the catalog records one (7 of the 102 sources used by values) |
| `GET /v1/meta`, `/v1/health` | version, counts, definitions, attribution; liveness |

Common parameters: `measures=stature,mass` and `categories=seated,circumferences` (comma separated), `percentiles=5,50,95,97.5`, `min_reliability=high|medium|low`, `survey=<id>|latest`, `stats=false` (omit mean/SD). In URL **paths** use ids or names; role names that contain `/` (`Recruits/trainees`, `Cadre/other military`) work too.

**Formats.** `/v1/design-values`, `/v1/mannequin` and `/v1/compare` answer **CSV** (UTF-8, CRLF, `,` separator, `.` decimal mark) and **XML** with `?format=csv` / `?format=xml`; `/v1/measures` has `format=csv`. `/v1/populations/{country}/{role}/{sex}` also takes a `.csv`, `.xml` or `.json` suffix on `sex`. XML carries the `<notes>` and the reliability filter's effect; CSV carries the data only, and the same information travels in the `X-Disclaimer`, `X-Notes` and `X-Hidden-By-Reliability` response headers.

**Errors** are always `{"error": {"code": "not_found" | "bad_request" | "unauthorized" | "method_not_allowed" | "internal_error", "message": "…", "hint": "…", "available": ["…"], "closest": true}}` with status 404, 422, 401, 405 or 500 (`available` lists the valid values, or only the nearest matches when `closest` is true). The API is read-only: `GET` and `HEAD` only.

**Operation.** `X-Data-Version` on every response changes when any data file, the version or the calculation changes (cache on it). Answers are cacheable for an hour (`/v1/health` is not). Set `ANTHRO_API_KEYS=key1,key2` to require `X-API-Key: <key>` or `Authorization: Bearer <key>` on `/v1/*` (`/v1/health` stays open; the schemes are in the OpenAPI document, so Swagger's *Authorize* works); `ANTHRO_CORS_ORIGINS` restricts browser origins (default `*`); `ANTHRO_DATA_DIR` points at another checkout of the data. There is no rate limiting or TLS: put it behind your reverse proxy. A [`Dockerfile`](../Dockerfile) is included (`docker build -t anthro-api . && docker run -p 8000:8000 anthro-api`).

## Static files (no server)

`python scripts/build_site.py` also writes `public/api/v1/`, so the website deployment on Vercel answers these without any server:

```
/api/v1/index.json                                              every population, with links
/api/v1/populations/{country}/{role}/{sex}.json | .csv          design values: P5, P50, P95 of every measure, every reliability level, all surveys combined
/api/v1/populations/{country}/{role}/{sex}.latest.json | .csv   the same for the most recent survey alone (where the combined values span more than 15 years)
/api/v1/mannequin/{country}/{role}/{sex}.json | .latest.json    P5, P50 and P95 boundary dimension sets (high and medium reliability only)
/api/v1/countries.json  measures.json  categories.json  meta.json
```

The population files are the live API's answer; filter on each measure's `reliability`. The mannequin file is the live `/v1/mannequin` answer reorganised into one file: per percentile `core`, `values`, `basis`, `caution`, `unavailable`; once per file `units` and `dimensions` (name, category, unit, n, reliability, years, sources, n_surveys, survey_spread_pct). Ids are lower-case slugs (`united-states`, `air-force`); `sex` is `M`, `F` or `both`. `python -m anthro_service snapshot --out some_dir` writes the same files locally.

## MCP server (AI assistants)

```bash
python -m anthro_service mcp                                                    # stdio
python -m anthro_service mcp --transport streamable-http --host 0.0.0.0 --port 8001 --allowed-host mcp.example.org     # remote: http://mcp.example.org:8001/mcp
```

The server has no authentication. The HTTP transports check the `Host` and `Origin` headers (DNS-rebinding protection): bound to localhost they accept localhost only; with `--allowed-host` / `--allowed-origin` (repeatable) exactly those; bound to another address without them they accept any host and print a warning. Keep it on a trusted network.

Claude Desktop and most clients take a command; use absolute paths so it does not depend on the working directory ([`examples/claude_desktop_config.json`](examples/claude_desktop_config.json)):

```json
{"mcpServers": {"anthropometry": {"command": "/path/to/venv/bin/python", "args": ["-m", "anthro_service", "mcp"], "env": {"PYTHONPATH": "/path/to/AnthropometricRepo"}}}}
```

Claude Code: `claude mcp add anthropometry -e PYTHONPATH=/path/to/AnthropometricRepo -- /path/to/venv/bin/python -m anthro_service mcp`. The interpreter must be the one where `pip install -r anthro_service/requirements.txt` was run.

Tools (all read-only): `list_countries`, `list_roles`, `list_categories`, `list_surveys`, `search_measures`, `get_measure`, `get_design_values`, `get_mannequin_dimensions`, `compare_populations`, `get_source`, `about`. Failures come back as readable messages with the valid choices (or the closest matches), so the assistant can correct itself. Value tools return at most `limit` measures (default 60, maximum 200; harmonized ones first) unless you name the measures, and say what was left out. Tested with `mcp` 1.27 and 2.3 (`requirements.txt` allows 1.22 up to, not including, 3).

Example prompt: *"Take the US Army men from the anthropometry tool, use the latest survey, and give me the P5/P50/P95 values of stature, sitting height, buttock-knee length and hand length, then write the CATIA macro that sets them on my manikin."*

## Connecting a CAD or digital-human tool

None of these products has a built-in connector; they take dimensions through scripting or tables. The API gives them the numbers as JSON, CSV or XML, and the integration is a few lines in the tool's scripting language. **The Python examples have been run against this server and the static files; the VBA and PowerShell examples have only been checked by reading. None has been run inside CATIA, AutoCAD, Jack or RAMSIS.** Reports from real use are welcome.

| Tool | Route |
|---|---|
| **CATIA V5 / 3DEXPERIENCE (Human Builder, Human Measurements Editor)** | VBA / CATScript: [`examples/AnthroApi.bas`](examples/AnthroApi.bas) fetches the dimensions into a dictionary you copy onto manikin or Knowledge parameters. Or fetch a CSV ([`examples/design_table.py`](examples/design_table.py)) and import it as a design table. Edit `MAPPING` there to your parameter names. |
| **AutoCAD** (has no human model; scripts that place a human figure or ergonomic template) | AutoCAD VBA 7.x: the same `AnthroApi.bas`. AutoLISP / .NET / Python-COM: GET the CSV or JSON URL and read the columns. |
| **Siemens Jack / Process Simulate, RAMSIS, SAMMIE, Santos** | Import the CSV as a custom population or anthropometry table, or call the REST API from the tool's scripting layer. Map `key` to the tool's variable names. |
| **Blender / Unity / Unreal / MakeHuman** | HTTP + JSON from Python or C#. |
| **Excel / Google Sheets** | Excel: *Data → From Web* (Power Query) on a CSV URL. Google Sheets: `=IMPORTDATA("https://…/populations/united-states/army/M.latest.csv")`. (`=WEBSERVICE()` returns one text cell and fails above 32,767 characters, which these CSVs exceed.) |
| **Any language** | generate a client from [`openapi.json`](openapi.json). |

```bash
python anthro_service/examples/design_table.py --base http://127.0.0.1:8000 --country "United States" --role Army --sex M --survey latest --out army_men.csv
python anthro_service/examples/design_table.py --base https://YOUR-SITE.vercel.app/api/v1 --country "United States" --role Army --sex M --survey latest     # static files
pwsh anthro_service/examples/fetch_mannequin.ps1 -Country "United States" -Role "Air Force" -Sex M -Percentile 95
```

Practical notes: use `min_reliability=high` for design decisions; prefer `survey=latest` for current personnel; check `n`, `years`, `basis` and `caution`; get the three boundary sets (5, 50, 95) from `/v1/mannequin`; a P50 set is a reference body, but real people vary in proportions, so nobody has every dimension at the median; `values` mixes units (see `units`) and includes as-published measures next to the harmonized ones (for example `other:stature_as_reported` beside `stature`): pick the dimensions your manikin needs by key.

## Licences and use

The statistics are extracted from published surveys and papers; each source keeps its own licence (public-domain US Government reports, CC BY 3.0 AU for ASRAN, CC BY-NC 4.0 for the NZDFAS monograph, others restricted or sold). `GET /v1/sources/{id}` returns the `licence` where the catalog records one (survey-level sources: 7 of the 102 source ids used by values) and otherwise says that none is recorded, together with the title and links of the paper; for those, check the publisher's terms. **This repository does not state a licence for the compiled dataset; if you use the data in a commercial product, check the licence of each source you use and cite it.** Attribution text is in `GET /v1/meta`.

## Development

```bash
pip install -r anthro_service/requirements.txt pytest httpx
python -m pytest anthro_service/tests                                            # core, REST, MCP and the static files
python -m unittest discover -s anthro_service/tests -t . -p "test_core.py"       # core only, standard library
python -m anthro_service openapi --out anthro_service/openapi.json               # after changing the API
```

The tests compare every served value with `aggregates/rollup.csv`, the single-survey path with the roll-up and with `scripts/build_aggregates.py`, the measure categories with `site/js/measurecat.js` (needs `node`), every survey of every population for crashes, and run the MCP server through a client, a real stdio process and the HTTP transport under mcp 1.x and 2.x (CI matrix). MCP tests fail rather than skip when `mcp` is installed but broken; set `REQUIRE_SERVICE_DEPS=1` to make a missing dependency fail too (CI does).

| File | Role |
|---|---|
| `core.py` | data loading and all calculations (standard library) |
| `rest.py`, `models.py`, `formats.py` | FastAPI app, response models for OpenAPI, CSV/XML writers |
| `mcp_server.py` | MCP tools |
| `snapshot.py` | static JSON/CSV files, called by `scripts/build_site.py` |
| `measurecat.py` | measure categories, same rules as the website |
