"""CSV and XML renderings of the service's answers, for tools that do not parse JSON easily (VBA, spreadsheets, CAD macros).

CSV: UTF-8, comma separated, one header row, no thousands separators, empty cell = no value.
XML: flat and attribute based; numbers use a full stop as the decimal separator.
"""
from __future__ import annotations

import csv
import io
import re
import unicodedata
import xml.etree.ElementTree as ET


def to_csv(columns: list, rows: list) -> str:
    buf = io.StringIO()
    w = csv.writer(buf, lineterminator="\r\n")
    w.writerow(columns)
    for r in rows:
        w.writerow(["" if r.get(c) is None else r.get(c) for c in columns])
    return buf.getvalue()


def _pop(d: dict) -> dict:
    p = d["population"]
    return {"country": p["country"], "role": p["role"], "sex": p["sex"], "survey": (p.get("survey") or {}).get("name") or "all surveys combined"}


def _years(y) -> dict:
    return {"year_min": y[0] if y else None, "year_max": y[1] if y else None}


def design_csv(d: dict) -> str:
    pcols = d["percentiles"]
    cols = ["country", "role", "sex", "survey", "key", "name", "category", "unit", "n", "mean", "sd", *pcols, "estimated_percentiles", "percentile_basis", "reliability",
            "reliability_note", "n_surveys", "survey_spread_pct", "year_min", "year_max", "official_documents", "sources"]
    base = _pop(d)
    rows = []
    for m in d["measures"]:
        row = {**base, "key": m["key"], "name": m["name"], "category": m["category"], "unit": m["unit"], "n": m["n"], "mean": m.get("mean"), "sd": m.get("sd"),
               "reliability": m["reliability"], "reliability_note": m["reliability_note"], "official_documents": "; ".join(m["official_documents"]),
               "sources": "; ".join(m["sources"]), "n_surveys": m["n_surveys"], "survey_spread_pct": m["survey_spread_pct"], **_years(m["years"]),
               "estimated_percentiles": " ".join(k for k, b in m["percentile_basis"].items() if b == "estimated"),
               "percentile_basis": " ".join(f"{k}:{b}" for k, b in m["percentile_basis"].items())}
        row.update(m["percentiles"])
        rows.append(row)
    return to_csv(cols, rows)


def mannequin_csv(m: dict) -> str:
    base = _pop(m)
    cols = ["country", "role", "sex", "survey", "percentile", "key", "name", "category", "unit", "value", "basis", "n", "reliability", "caution", "n_surveys",
            "survey_spread_pct", "year_min", "year_max", "sources"]
    rows = [{**base, "percentile": m["percentile"], **x, "caution": "; ".join(m["caution"].get(x["key"], [])), **_years(x["years"]), "sources": "; ".join(x["sources"])} for x in m["dimensions"]]
    return to_csv(cols, rows)


def compare_csv(c: dict) -> str:
    cols = ["measure", "unit", "sex", "percentile", "country", "role", "value", "basis", "mean", "n", "reliability", "n_surveys", "year_min", "year_max", "sources"]
    rows = [{"measure": c["measure"]["key"], "unit": c["measure"]["unit"], "sex": c["sex"], "percentile": c["percentile"], **r, **_years(r["years"]), "sources": "; ".join(r["sources"])}
            for r in c["results"]]
    return to_csv(cols, rows)


def measures_csv(ms: list) -> str:
    return to_csv(["key", "name", "category", "unit", "harmonized", "populations", "note"], ms)


def csv_headers(d: dict) -> dict:
    """CSV has no room for the notes, so the disclaimer and the reliability filter's effect travel in response headers."""
    notes = d.get("notes") or []
    h = {}
    if notes:
        h["X-Disclaimer"] = _ascii(notes[0])
    if len(notes) > 1:
        h["X-Notes"] = _ascii(" | ".join(notes[1:]))
    if "hidden_by_reliability" in d:
        h["X-Hidden-By-Reliability"] = str(d["hidden_by_reliability"])
    return h


def _ascii(s: str) -> str:
    """HTTP header values: ASCII only, no control characters (accented letters lose their accents instead of becoming '?')."""
    plain = "".join(ch for ch in unicodedata.normalize("NFKD", s) if not unicodedata.combining(ch))
    return re.sub(r"[\x00-\x1f\x7f]+", " ", plain.encode("ascii", "replace").decode("ascii"))


_ILLEGAL_XML = re.compile("[\x00-\x08\x0b\x0c\x0e-\x1f\ud800-\udfff\ufffe\uffff]")


def _xml(root: ET.Element) -> str:
    ET.indent(root)
    return _ILLEGAL_XML.sub("", '<?xml version="1.0" encoding="UTF-8"?>\n' + ET.tostring(root, encoding="unicode"))


def _attrs(d: dict) -> dict:
    return {k: str(v) for k, v in d.items() if v is not None}


def _notes(root: ET.Element, d: dict) -> None:
    if d.get("notes"):
        n = ET.SubElement(root, "notes")
        for t in d["notes"]:
            ET.SubElement(n, "note").text = t


def design_xml(d: dict) -> str:
    root = ET.Element("designValues", _attrs({**_pop(d), "minReliability": d["min_reliability"], "count": d["count"], "hiddenByReliability": d["hidden_by_reliability"]}))
    for m in d["measures"]:
        y = m["years"] or [None, None]
        e = ET.SubElement(root, "measure", _attrs({"key": m["key"], "name": m["name"], "category": m["category"], "unit": m["unit"], "n": m["n"], "mean": m.get("mean"),
                                                  "sd": m.get("sd"), "reliability": m["reliability"], "reliabilityNote": m["reliability_note"], "nSurveys": m["n_surveys"],
                                                  "surveySpreadPct": m["survey_spread_pct"], "yearMin": y[0], "yearMax": y[1],
                                                  "officialDocuments": "; ".join(m["official_documents"]) or None, "sources": "; ".join(m["sources"])}))
        for k, v in m["percentiles"].items():
            if v is not None:
                pe = ET.SubElement(e, "percentile", _attrs({"p": k[1:], "basis": m["percentile_basis"][k]}))
                pe.text = repr(v)
    _notes(root, d)
    return _xml(root)


def mannequin_xml(m: dict) -> str:
    root = ET.Element("mannequin", _attrs({**_pop(m), "percentile": m["percentile"], "minReliability": m["min_reliability"], "count": m["count"],
                                           "hiddenByReliability": m["hidden_by_reliability"]}))
    for x in m["dimensions"]:
        y = x["years"] or [None, None]
        e = ET.SubElement(root, "dimension", _attrs({"key": x["key"], "name": x["name"], "category": x["category"], "unit": x["unit"], "basis": x["basis"],
                                                    "n": x["n"], "reliability": x["reliability"], "caution": "; ".join(m["caution"].get(x["key"], [])) or None,
                                                    "nSurveys": x["n_surveys"], "yearMin": y[0], "yearMax": y[1], "sources": "; ".join(x["sources"])}))
        e.text = repr(x["value"])
    if m["unavailable"]:
        u = ET.SubElement(root, "unavailable")
        for x in m["unavailable"]:
            ET.SubElement(u, "dimension", _attrs({"key": x["key"], "name": x["name"], "unit": x["unit"], "mean": x["mean"], "n": x["n"], "reliability": x["reliability"]}))
    _notes(root, m)
    return _xml(root)


def compare_xml(c: dict) -> str:
    root = ET.Element("comparison", _attrs({"measure": c["measure"]["key"], "unit": c["measure"]["unit"], "sex": c["sex"], "percentile": c["percentile"], "count": c["count"],
                                            "total": c["total"]}))
    for r in c["results"]:
        y = r["years"] or [None, None]
        e = ET.SubElement(root, "population", _attrs({"country": r["country"], "role": r["role"], "basis": r["basis"], "n": r["n"], "reliability": r["reliability"],
                                                     "nSurveys": r["n_surveys"], "yearMin": y[0], "yearMax": y[1], "sources": "; ".join(r["sources"])}))
        e.text = repr(r["value"])
    _notes(root, c)
    return _xml(root)


RENDER = {
    "design": {"csv": design_csv, "xml": design_xml},
    "mannequin": {"csv": mannequin_csv, "xml": mannequin_xml},
    "compare": {"csv": compare_csv, "xml": compare_xml},
}
MEDIA = {"json": "application/json", "csv": "text/csv; charset=utf-8", "xml": "application/xml; charset=utf-8"}
