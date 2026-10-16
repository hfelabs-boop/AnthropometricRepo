# Anthropometry API and MCP server

Body-measurement statistics of military populations (country × role × sex) for **digital-human and mannequin tools** (CATIA Human Builder, Siemens Jack, RAMSIS, AutoCAD or Blender scripts, spreadsheets) and for **AI assistants**. It serves the same numbers as the website's *By country & role* and *Design values* views: P5, P50, P95 (or any percentile) of up to 571 measures, with sample size, a reliability rating, the official document each value comes from, and the sources.

Three ways to use it, from simplest to most flexible:

| | Needs | Good for |
|---|---|---|
| **Static files** at `/api/v1/…` on the website | nothing (a plain HTTP GET) | scripts, spreadsheets, any tool that can open a URL or a CSV |
| **REST API** (`python -m anthro_service serve`) | Python 3.10+, `pip install -r anthro_service/requirements.txt` | any percentile, filters, XML, an OpenAPI description for generated clients |
| **MCP server** (`python -m anthro_service mcp`) | the same | AI assistants (Claude Desktop, Claude Code, Cursor, ...) that drive a CAD or digital-human tool |

The library in `core.py` and the static-file generator use only the standard library.

> **Read this first.** Every number is a population statistic, not a measurement of any person, and **each dimension is the requested percentile of that dimension alone.** A manikin built from P95 stature, P95 mass, P95 sitting height ... is a *boundary case*; real 95th-percentile soldiers differ in proportions. The API repeats this in the `notes` of every answer. Surveys span the 1940s to the 2020s and use different landmark definitions: check `years`, `sources` and `reliability` before you rely on a value. This is not an official standard (MIL-STD-1472, DOD-HDBK-743A) and does not replace one.

## Quick start

```bash
pip install -r anthro_service/requirements.txt
python -m anthro_service serve                       # http://127.0.0.1:8000  (interactive docs at /docs)

curl "http://127.0.0.1:8000/v1/mannequin?country=United%20States&role=Army&sex=M&percentile=95&measures=stature,mass,sitting_height"
curl "http://127.0.0.1:8000/v1/populations/united-states/army/M.csv?measures=stature,mass" 
python anthro_service/examples/python_client.py
```

```json
{
  "population": {"country": "United States", "role": "Army", "sex": "M", "surveys_combined": [{"id": "ansur-ii-2012", "name": "ANSUR II 2012", "year": 2010}, "…"], "years": [1966, 2010]},
  "percentile": 95,
  "core": {"stature_mm": 1862.7, "body_mass_kg": 102.34, "sitting_height_mm": 971.4},
  "values": {"mass": 102.34, "stature": 1862.7, "sitting_height": 971.4},
  "dimensions": [{"key": "stature", "name": "Stature", "unit": "mm", "value": 1862.7, "basis": "reported", "n": 12538, "reliability": "high"}, "…"],
  "notes": ["Population statistics for design studies, …"]
}
```

`values` is the flat `{measure key: number}` map a manikin needs; `dimensions` adds unit, how the number was obtained, sample size and reliability.

## Concepts

* **Population** = *country* + *role* (the survey population: `Army`, `Air Force`, `Navy`, `Marine Corps`, `Aircrew`, `Pilots`, `Officers`, `Recruits/trainees` ...) + *sex* (`M`, `F`, or `both` for mixed or not stated). Names, ids (`united-states`, `air-force`) and common aliases (`USA`, `UK`) all work; `GET /v1/countries` lists what has data.
* **Combined or one survey.** By default the values combine every survey of the population (the same roll-up as the website). Pass `survey=ansur-ii-2012` to use one survey; `GET /v1/populations/{country}/{role}/surveys` lists them with year, sample size and official document.
* **Measures** have a key. 59 harmonized measures (`stature`, `mass`, `sitting_height`, `buttock_knee_length`, `hand_length`, `chest_circumference`, …) are comparable across surveys. 512 more are *as published* (`other:waist_back_length_omphalion`), whose definition is whatever the source printed. Search with `GET /v1/measures?q=waist`, browse by `category` (`heights-standing`, `seated`, `circumferences`, …).
* **Units.** Lengths **millimetres**, body mass **kg**, BMI kg/m², age years; as-published measures keep their printed unit (%, ratio, degrees). Every value carries its `unit`.
* **Percentiles.** P5, P50, P95 are the roll-up values. `percentile_basis` says how each one was obtained: `reported` (printed by a source), `estimated` (from mean and SD, normal; lognormal for skewed positive measures), `interpolated` (5 < p < 95) or `extrapolated` (beyond P5/P95, on the line through P5, P50, P95 that is linear in the normal score; less certain the further out). Allowed range 0.1 to 99.9.
* **Reliability.** `high` = raw data, a validated table or an official defence document, printed percentiles, at least 100 people. `low` = an unchecked web article, fewer than 30 people, or no percentiles/SD. `medium` = in between. `min_reliability` defaults to **`medium`** (high and medium); use `high` for design decisions or `low` / `all` to see everything. The answer says how many values were hidden. Values taken from an official document list it in `official_documents`.

## REST API

Base `http://host:8000`; interactive documentation at `/docs`, the machine-readable description at `/openapi.json` (a copy is committed as [`openapi.json`](openapi.json), so you can generate a client with openapi-generator, NSwag or similar without running the server).

| Endpoint | Returns |
|---|---|
| `GET /v1/populations/{country}/{role}/{sex}` | design values: percentiles of every (or chosen) measure, with mean, SD, n, reliability, sources |
| `GET /v1/design-values?country=&role=&sex=` | the same, query-string form |
| `GET /v1/mannequin?country=&role=&sex=&percentile=` | one value per dimension at one percentile + `core` + flat `values` map |
| `GET /v1/compare?measure=stature&percentile=95&sex=M` | the same measure and percentile across populations, highest first |
| `GET /v1/countries`, `/v1/countries/{country}` | countries, roles, sexes with data |
| `GET /v1/measures?q=&category=&country=&role=&sex=`, `/v1/measures/{key}` | search measures; populations that have one |
| `GET /v1/categories` | measure categories |
| `GET /v1/populations/{country}/{role}/surveys` | the individual surveys behind a population |
| `GET /v1/sources/{id}` | titles, links, licence and official document of a source |
| `GET /v1/meta`, `/v1/health` | version, counts, definitions, attribution; liveness |

Common parameters: `measures=stature,mass` and `categories=seated,circumferences` (comma separated), `percentiles=5,50,95,97.5`, `min_reliability=high|medium|low`, `survey=<id>`, `stats=false` (omit mean/SD).

**Formats.** Table endpoints also answer **CSV** (UTF-8, CRLF, `,` separator, `.` decimal mark) and **XML**: add `?format=csv` / `?format=xml`, or end the last path segment with `.csv`, `.xml` or `.json` (`/v1/populations/united-states/army/M.csv`).

**Errors** are always `{"error": {"code": "not_found" | "bad_request" | "unauthorized", "message": "…", "hint": "…", "available": ["valid", "values"]}}` with status 404, 422 or 401. A mistyped country returns the closest names.

**Operation.** `X-Data-Version` on every response changes when the data change (cache on it). Responses are cacheable for an hour. Set `ANTHRO_API_KEYS=key1,key2` to require `X-API-Key: <key>` or `Authorization: Bearer <key>` on `/v1/*` (`/v1/health` stays open); `ANTHRO_CORS_ORIGINS` restricts browser origins (default `*`); `ANTHRO_DATA_DIR` points at another checkout of the data. There is no rate limiting or TLS: put it behind your reverse proxy. A [`Dockerfile`](../Dockerfile) is included (`docker build -t anthro-api . && docker run -p 8000:8000 anthro-api`).

## Static files (no server)

`python scripts/build_site.py` also writes `public/api/v1/`, so the website deployment on Vercel answers these without any server (the files carry the same fields as the live API, always P5/P50/P95, all reliability levels: filter on each measure's `reliability`):

```
/api/v1/index.json                                            every population, with links
/api/v1/populations/{country}/{role}/{sex}.json | .csv        design values
/api/v1/mannequin/{country}/{role}/{sex}.json                 P5, P50 and P95 boundary dimension sets in one file
/api/v1/countries.json  measures.json  categories.json  meta.json
```

Ids are lower-case slugs (`united-states`, `air-force`); `sex` is `M`, `F` or `both`. `python -m anthro_service snapshot --out some_dir` writes the same files locally.

## MCP server (AI assistants)

```bash
python -m anthro_service mcp                                    # stdio
python -m anthro_service mcp --transport streamable-http --port 8001     # remote: http://host:8001/mcp
```

Claude Desktop (`claude_desktop_config.json`, see [`examples/claude_desktop_config.json`](examples/claude_desktop_config.json)), Claude Code (`claude mcp add anthropometry -- python -m anthro_service mcp`), Cursor and other clients take a command like this:

```json
{"mcpServers": {"anthropometry": {"command": "python", "args": ["-m", "anthro_service", "mcp"], "cwd": "/path/to/AnthropometricRepo"}}}
```

Tools: `list_countries`, `list_surveys`, `search_measures`, `get_design_values`, `get_mannequin_dimensions`, `compare_populations`, `get_source`, `about`. Failures come back as readable messages with the valid choices, so the assistant can correct itself. Results over 60 measures are cut to `limit` and say so. Tested with `mcp` 1.27 and 2.3 (`requirements.txt` allows 1.9 up to, not including, 3). The server has no authentication: use stdio, or keep the HTTP transport on a trusted network.

Example prompt: *"Take the US Army men from the anthropometry tool and give me the P5/P50/P95 values of stature, sitting height, buttock-knee length and hand length, then write the CATIA macro that sets them on my manikin."*

## Connecting a CAD or digital-human tool

None of these products has a built-in connector; they take dimensions through scripting or tables. The API gives them the numbers as JSON, CSV or XML, and the integration is a few lines in the tool's scripting language. **The examples have been run against this server from Python and checked for syntax by reading; they have not been run inside CATIA, AutoCAD, Jack or RAMSIS.** Reports from real use are welcome.

| Tool | Route |
|---|---|
| **CATIA V5 / 3DEXPERIENCE (Human Builder, Human Measurements Editor)** | VBA / CATScript: [`examples/AnthroApi.bas`](examples/AnthroApi.bas) fetches the dimensions into a dictionary you copy onto manikin or Knowledge parameters. Or fetch a CSV ([`examples/design_table.py`](examples/design_table.py)) and import it as a design table. Edit `MAPPING` there to your parameter names. |
| **AutoCAD** (has no human model; scripts that place a human figure or ergonomic template) | AutoCAD VBA 7.x: the same `AnthroApi.bas`. AutoLISP / .NET / Python-COM: GET the CSV or JSON URL and read the columns. |
| **Siemens Jack / Process Simulate, RAMSIS, SAMMIE, Santos** | Import the CSV as a custom population or anthropometry table, or call the REST API from the tool's scripting layer. Map `key` to the tool's variable names. |
| **Blender / Unity / Unreal / MakeHuman** | HTTP + JSON from Python or C#. |
| **Excel / Google Sheets** | `=WEBSERVICE(".../populations/united-states/army/M.csv")`, Power Query "From Web", or `IMPORTDATA(url)`. |
| **Any language** | generate a client from [`openapi.json`](openapi.json). |

```bash
python anthro_service/examples/design_table.py --base http://127.0.0.1:8000 --country "United States" --role Army --sex M --out army_men.csv
python anthro_service/examples/design_table.py --base https://YOUR-SITE.vercel.app/api/v1 --country united-states --role army --sex M   # static files
pwsh anthro_service/examples/fetch_mannequin.ps1 -Country Israel -Role "Air Force" -Sex M -Percentile 95
```

Practical notes: use `min_reliability=high` for design decisions; check `n`, `years` and `basis`; get the three boundary sets (5, 50, 95) from `/v1/mannequin`; measure keys that differ between surveys by landmark definition are listed separately (`other:…`) rather than merged; for a typical-proportions manikin use the P50 set, not a mix of percentiles.

## Licences and use

The statistics are extracted from published surveys and papers; each source keeps its own licence (public-domain US Government reports, CC BY 3.0 AU for ASRAN, CC BY-NC 4.0 for the NZDFAS monograph, others restricted or sold). `GET /v1/sources/{id}` returns the `licence` and citation of each source listed on a value. **This repository does not state a licence for the compiled dataset; if you use the data in a commercial product, check the licence of each source you use and cite it.** Attribution text is in `GET /v1/meta`.

## Development

```bash
pip install -r anthro_service/requirements.txt pytest httpx
python -m pytest anthro_service/tests            # core, REST, MCP and the static files
python -m unittest discover -s anthro_service/tests -t . -p "test_core.py"       # core only, standard library
python -m anthro_service openapi --out anthro_service/openapi.json                # after changing the API
```

The tests compare every served value with `aggregates/rollup.csv`, the single-survey path with the roll-up and with `scripts/build_aggregates.py`, the measure categories with `site/js/measurecat.js` (needs `node`), and run the MCP server through a client under mcp 1.x and 2.x (CI matrix).

| File | Role |
|---|---|
| `core.py` | data loading and all calculations (standard library) |
| `rest.py`, `models.py`, `formats.py` | FastAPI app, response models for OpenAPI, CSV/XML writers |
| `mcp_server.py` | MCP tools |
| `snapshot.py` | static JSON/CSV files, called by `scripts/build_site.py` |
| `measurecat.py` | measure categories, same rules as the website |
