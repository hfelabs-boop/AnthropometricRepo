"""CSV and XML renderings of the service's answers, for tools that do not parse JSON easily (VBA, spreadsheets, CAD macros).

CSV: UTF-8, comma separated, one header row, no thousands separators, empty cell = no value.
XML: flat and attribute based; numbers use a full stop as the decimal separator.
"""
from __future__ import annotations

import csv
import io
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


def design_csv(d: dict) -> str:
    pcols = d["percentiles"]
    cols = ["country", "role", "sex", "survey", "key", "name", "category", "unit", "n", "mean", "sd", *pcols, "estimated_percentiles", "reliability",
            "reliability_note", "official_documents", "sources"]
    base = _pop(d)
    rows = []
    for m in d["measures"]:
        row = {**base, "key": m["key"], "name": m["name"], "category": m["category"], "unit": m["unit"], "n": m["n"], "mean": m.get("mean"), "sd": m.get("sd"),
               "reliability": m["reliability"], "reliability_note": m["reliability_note"], "official_documents": "; ".join(m["official_documents"]),
               "sources": "; ".join(m["sources"]),
               "estimated_percentiles": " ".join(k for k, b in m["percentile_basis"].items() if b != "reported")}
        row.update(m["percentiles"])
        rows.append(row)
    return to_csv(cols, rows)


def mannequin_csv(m: dict) -> str:
    base = _pop(m)
    cols = ["country", "role", "sex", "survey", "percentile", "key", "name", "category", "unit", "value", "basis", "n", "reliability"]
    rows = [{**base, "percentile": m["percentile"], **x} for x in m["dimensions"]]
    return to_csv(cols, rows)


def compare_csv(c: dict) -> str:
    cols = ["measure", "unit", "sex", "percentile", "country", "role", "value", "basis", "mean", "n", "reliability", "sources"]
    rows = [{"measure": c["measure"]["key"], "unit": c["measure"]["unit"], "sex": c["sex"], "percentile": c["percentile"], **r, "sources": "; ".join(r["sources"])} for r in c["results"]]
    return to_csv(cols, rows)


def measures_csv(ms: list) -> str:
    return to_csv(["key", "name", "category", "unit", "populations", "note"], ms)


def _xml(root: ET.Element) -> str:
    ET.indent(root)
    return '<?xml version="1.0" encoding="UTF-8"?>\n' + ET.tostring(root, encoding="unicode")


def _attrs(d: dict) -> dict:
    return {k: str(v) for k, v in d.items() if v is not None}


def design_xml(d: dict) -> str:
    p = d["population"]
    root = ET.Element("designValues", _attrs({**_pop(d), "minReliability": d["min_reliability"], "count": d["count"]}))
    for m in d["measures"]:
        e = ET.SubElement(root, "measure", _attrs({"key": m["key"], "name": m["name"], "category": m["category"], "unit": m["unit"], "n": m["n"], "mean": m.get("mean"),
                                                  "sd": m.get("sd"), "reliability": m["reliability"]}))
        for k, v in m["percentiles"].items():
            if v is not None:
                pe = ET.SubElement(e, "percentile", _attrs({"p": k[1:], "basis": m["percentile_basis"][k]}))
                pe.text = repr(v)
    return _xml(root)


def mannequin_xml(m: dict) -> str:
    root = ET.Element("mannequin", _attrs({**_pop(m), "percentile": m["percentile"], "minReliability": m["min_reliability"], "count": m["count"]}))
    for x in m["dimensions"]:
        e = ET.SubElement(root, "dimension", _attrs({"key": x["key"], "name": x["name"], "category": x["category"], "unit": x["unit"], "basis": x["basis"],
                                                    "n": x["n"], "reliability": x["reliability"]}))
        e.text = repr(x["value"])
    return _xml(root)


def compare_xml(c: dict) -> str:
    root = ET.Element("comparison", _attrs({"measure": c["measure"]["key"], "unit": c["measure"]["unit"], "sex": c["sex"], "percentile": c["percentile"], "count": c["count"]}))
    for r in c["results"]:
        e = ET.SubElement(root, "population", _attrs({"country": r["country"], "role": r["role"], "basis": r["basis"], "n": r["n"], "reliability": r["reliability"]}))
        e.text = repr(r["value"])
    return _xml(root)


RENDER = {
    "design": {"csv": design_csv, "xml": design_xml},
    "mannequin": {"csv": mannequin_csv, "xml": mannequin_xml},
    "compare": {"csv": compare_csv, "xml": compare_xml},
}
MEDIA = {"json": "application/json", "csv": "text/csv; charset=utf-8", "xml": "application/xml; charset=utf-8"}
