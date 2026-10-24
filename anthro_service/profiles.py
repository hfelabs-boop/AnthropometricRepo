"""Pushed profiles: the "profile inbox" that lets the website's Digital human tab hand a body (and its posture) to CAD and digital-human tools.

The website sends its human-exchange JSON (Export tab: "Send to CAD", or `python -m anthro_service push FILE`) to the REST API (POST /v1/profiles); the store keeps it
on disk, and CATIA, AutoCAD, Jack, RAMSIS or a script fetches it back in the form it needs:

  values   the profile's measures as a flat {key: number} map with units: the same keys and shape as /v1/mannequin, so a macro written for the population
           values works unchanged on a pushed profile (stature, sitting_height, buttock_knee_length, ... in mm; mass in kg)
  dims     the dimension table of the built model (segment lengths, breadths, depths) that the website derived from the measures
  angles   the posture: every joint degree of freedom with its value, range and meaning (degrees), plus the root orientation
  points   joint centres and landmarks in the posed figure, world millimetres (+Y up, +Z front, +X the figure's left, floor y = 0)
  document the whole human-exchange document as it was sent

Two formats are accepted: "human-exchange" version 1 (export.js buildExchange: profile, body, posture, scene) and "digital-human-profile" version 1 (the Profile
tab's profile file: measures only, so no dims, angles or points).

Storage: one directory (ANTHRO_PROFILE_DIR, default ~/.anthro_service/profiles) with <id>.json (the document) and <id>.meta.json (the summary); the REST API and the
MCP server read the same directory, so a profile pushed to one is seen by the other. At most MAX_PROFILES are kept (the oldest go first). Standard library only.
"""
from __future__ import annotations

import json
import math
import os
import re
import secrets
import threading
import time
import unicodedata
from datetime import datetime, timezone
from pathlib import Path

from .core import ApiError, BadRequest, NotFound

MAX_BYTES = 5_000_000          # a human-exchange document of the website is about 110 to 250 kB
MAX_PROFILES = 200             # kept in the store; pushing one more removes the oldest
FORMATS = ("human-exchange", "digital-human-profile")
VIEWS = ("summary", "values", "dims", "angles", "points", "document")
ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{2,80}$")


class TooLarge(ApiError):
    status = 413
    code = "payload_too_large"


def default_dir() -> Path:
    env = os.environ.get("ANTHRO_PROFILE_DIR", "").strip()
    return Path(env).expanduser() if env else Path.home() / ".anthro_service" / "profiles"


def _fin(v) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def _text(v, limit: int = 200) -> str:
    s = "" if v is None else str(v)
    s = "".join(" " if unicodedata.category(c).startswith("C") else c for c in s)
    return re.sub(r"\s+", " ", s).strip()[:limit]


def _slug(s: str, limit: int = 32) -> str:
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z0-9]+", "-", s).strip("-")[:limit].strip("-") or "profile"


def _no_constant(name: str):
    raise ValueError(f"{name} is not a JSON number")


def _isobj(v) -> bool:
    return isinstance(v, dict)


def validate(doc) -> list:
    """Errors of a pushed document (empty when it can be stored). Checks the parts the views read: format and version, units, profile label and measures,
    and for a human-exchange document the body (stature, mass, dimension table, joints with their degrees of freedom, landmarks) and the posture."""
    errs = []
    if not _isobj(doc):
        return ["The document must be a JSON object."]
    fmt = doc.get("format")
    if fmt not in FORMATS:
        return [f"format must be one of {', '.join(FORMATS)} (found {json.dumps(fmt)[:60]}). Send the human-exchange JSON of the Export tab or a profile file of the Profile tab."]
    if doc.get("version") != 1:
        errs.append(f"version must be 1 (found {json.dumps(doc.get('version'))[:30]}).")
    prof = doc.get("profile") if fmt == "human-exchange" else doc
    if not _isobj(prof):
        return errs + ["profile is missing."]
    if not _text(prof.get("label")):
        errs.append("profile.label must be a non-empty text.")
    measures = prof.get("measures")
    if not _isobj(measures):
        errs.append("profile.measures must be an object of {key: {value, unit}}.")
    else:
        if len(measures) > 3000:
            errs.append("profile.measures has more than 3000 entries.")
        for k, m in list(measures.items())[:3000]:
            if not (isinstance(k, str) and 0 < len(k) <= 120) or not _isobj(m) or not _fin(m.get("value")) or not isinstance(m.get("unit", ""), str):
                errs.append(f"profile.measures.{str(k)[:60]} needs a finite value and a unit.")
                if len(errs) > 20:
                    break
    if fmt == "digital-human-profile":
        return errs
    if doc.get("units") != "mm":
        errs.append('units must be "mm".')
    body = doc.get("body")
    if not _isobj(body):
        return errs + ["body is missing."]
    if not _fin(body.get("stature_mm")) or not 500 <= body["stature_mm"] <= 3000:
        errs.append("body.stature_mm must be a number between 500 and 3000.")
    if not _fin(body.get("mass_kg")) or body["mass_kg"] <= 0:
        errs.append("body.mass_kg must be a positive number.")
    for key, limit in (("dims", 1000), ("joints", 300), ("landmarks", 2000), ("segments", 300)):
        v = body.get(key, [])
        if not isinstance(v, list) or len(v) > limit:
            errs.append(f"body.{key} must be a list of at most {limit} items.")
    for i, j in enumerate(body.get("joints", []) if isinstance(body.get("joints"), list) else []):
        if not _isobj(j) or not isinstance(j.get("id"), str) or not isinstance(j.get("dof", []), list) or not _pt(j.get("position_mm")):
            errs.append(f"body.joints[{i}] needs an id, position_mm [x, y, z] and a dof list.")
            break
        if any(not _isobj(d) or not isinstance(d.get("key"), str) or not _fin(d.get("value_deg")) for d in j.get("dof", [])):
            errs.append(f"body.joints[{i}] ({_text(j.get('id'), 40)}): every dof needs a key and a finite value_deg.")
            break
    for i, l in enumerate(body.get("landmarks", []) if isinstance(body.get("landmarks"), list) else []):
        if not _isobj(l) or not isinstance(l.get("id"), str) or not _pt(l.get("position_mm")):
            errs.append(f"body.landmarks[{i}] needs an id and position_mm [x, y, z].")
            break
    post = doc.get("posture")
    if post is not None and (not _isobj(post) or not _isobj(post.get("angles", {}))):
        errs.append("posture.angles must be an object.")
    return errs


def _pt(v) -> bool:
    return isinstance(v, list) and len(v) == 3 and all(_fin(c) and abs(c) < 1e6 for c in v)


def summary_of(doc: dict) -> dict:
    """The short description the list shows."""
    exchange = doc["format"] == "human-exchange"
    prof = doc["profile"] if exchange else doc
    m = prof.get("measures", {})
    body = doc.get("body", {}) if exchange else {}
    stature = body.get("stature_mm") if exchange else (m.get("stature") or {}).get("value")
    mass = body.get("mass_kg") if exchange else (m.get("mass") or {}).get("value")
    src = prof.get("source") if _isobj(prof.get("source")) else {}
    post = doc.get("posture") if exchange and _isobj(doc.get("posture")) else None
    return {
        "label": _text(prof.get("label")), "sex": _text(prof.get("sex"), 10) or None, "format": doc["format"],
        "source": {k: src[k] for k in ("kind", "country", "role", "sex", "percentile", "dataset", "subject_key", "survey") if k in src and not _isobj(src[k])} or None,
        "stature_mm": round(stature, 1) if _fin(stature) else None, "mass_kg": round(mass, 2) if _fin(mass) else None,
        "measures": len(m) if _isobj(m) else 0,
        "posture": {"id": _text(post.get("id"), 80) or None, "name": _text(post.get("name"), 120) or None} if post else None,
        "generator": _text(doc.get("generator"), 120) or None, "created": _text(doc.get("created"), 40) or None,
    }


class ProfileStore:
    """Profiles on disk. Thread-safe within one process; two processes (REST and MCP) can share a directory: files are written atomically."""

    def __init__(self, directory: str | os.PathLike | None = None, max_profiles: int = MAX_PROFILES):
        self.dir = Path(directory).expanduser() if directory else default_dir()
        self.max = max_profiles
        self._lock = threading.Lock()

    # ---- writing
    def push(self, data, received_from: str | None = None) -> dict:
        """Store a document (dict, JSON text or bytes). Returns the summary with its id. Raises BadRequest or TooLarge."""
        if isinstance(data, (bytes, bytearray)):
            if len(data) > MAX_BYTES:
                raise TooLarge(f"The document is {len(data):,} bytes; at most {MAX_BYTES:,} are accepted.", "Send the human-exchange JSON of one figure.")
            try:
                data = data.decode("utf-8-sig")
            except UnicodeDecodeError:
                raise BadRequest("The document is not UTF-8 text.") from None
        if isinstance(data, str):
            if len(data) > MAX_BYTES:
                raise TooLarge(f"The document is {len(data):,} characters; at most {MAX_BYTES:,} are accepted.")
            try:
                data = json.loads(data, parse_constant=_no_constant)
            except (ValueError, RecursionError) as e:
                raise BadRequest(f"The document is not valid JSON ({str(e)[:120]}).", "Send the file the Export tab saves (human-exchange JSON).") from None
        errs = validate(data)
        if errs:
            raise BadRequest("The document cannot be used: " + " ".join(errs[:6]), "Export it again from the website (Export tab, human-exchange JSON) or check it against docs/human3d/EXPORT.md.")
        summary = summary_of(data)
        now = datetime.now(timezone.utc)
        pid = f"{now.strftime('%Y%m%d-%H%M%S')}-{_slug(summary['label'])}-{secrets.token_hex(2)}"
        meta = {"id": pid, "received": now.isoformat(timespec="seconds").replace("+00:00", "Z"), "received_ns": time.time_ns(), "received_from": received_from, **summary}
        with self._lock:
            self.dir.mkdir(parents=True, exist_ok=True)
            self._write(self.dir / f"{pid}.json", data)
            self._write(self.dir / f"{pid}.meta.json", meta)
            self._trim()
        return meta

    @staticmethod
    def _write(path: Path, obj) -> None:
        tmp = path.with_suffix(path.suffix + f".{os.getpid()}.tmp")
        tmp.write_text(json.dumps(obj, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        os.replace(tmp, path)

    def _trim(self) -> None:
        for m in self.list()[self.max:]:
            for f in (self.dir / f"{m['id']}.meta.json", self.dir / f"{m['id']}.json"):
                f.unlink(missing_ok=True)

    def delete(self, pid: str) -> dict:
        meta = self.meta(pid)
        with self._lock:
            for f in (self.dir / f"{meta['id']}.meta.json", self.dir / f"{meta['id']}.json"):
                f.unlink(missing_ok=True)
        return {"deleted": meta["id"]}

    def clear(self) -> int:
        n = 0
        with self._lock:
            for p in list(self.dir.glob("*.meta.json")):
                pid = p.name[: -len(".meta.json")]
                for f in (p, self.dir / f"{pid}.json"):
                    f.unlink(missing_ok=True)
                n += 1
        return n

    # ---- reading
    def list(self, limit: int | None = None) -> list:
        """Summaries, newest first."""
        if not self.dir.exists():
            return []
        out = []
        for p in self.dir.glob("*.meta.json"):
            try:
                out.append(json.loads(p.read_text(encoding="utf-8")))
            except (OSError, ValueError):
                continue
        # newest first: by the time received (nanoseconds, so two pushes in one second keep their order), then by id
        out.sort(key=lambda m: (m.get("received_ns") or 0, m.get("id", "")), reverse=True)
        return out[:limit] if limit else out

    def _resolve(self, pid: str) -> str:
        pid = (pid or "").strip().lower()
        if pid in ("latest", "last", "newest"):
            items = self.list(1)
            if not items:
                raise NotFound("No profile has been pushed yet.", "Use 'Send to CAD' in the Export tab of the website's Digital human, or: python -m anthro_service push FILE.json")
            return items[0]["id"]
        if not ID_RE.match(pid) or not (self.dir / f"{pid}.meta.json").exists():
            close = [m["id"] for m in self.list(5)]
            raise NotFound(f"No pushed profile '{_text(pid, 80)}'.", "Use 'latest' for the newest one, or an id from the list (GET /v1/profiles).", close)
        return pid

    def meta(self, pid: str) -> dict:
        pid = self._resolve(pid)
        return json.loads((self.dir / f"{pid}.meta.json").read_text(encoding="utf-8"))

    def document(self, pid: str) -> dict:
        pid = self._resolve(pid)
        return json.loads((self.dir / f"{pid}.json").read_text(encoding="utf-8"))

    def view(self, pid: str, view: str = "summary", measure_names: dict | None = None) -> dict:
        """One view of a profile (see the module docstring): a dict with 'profile' (the summary) and the view's data."""
        view = (view or "summary").strip().lower()
        if view not in VIEWS:
            raise BadRequest(f"Unknown view '{_text(view, 30)}'.", None, list(VIEWS))
        meta = self.meta(pid)
        doc = self.document(meta["id"])
        if view == "document":
            return doc
        out = {"profile": meta}
        exchange = doc["format"] == "human-exchange"
        if view in ("summary", "values"):
            out.update(values_of(doc, measure_names))
            if view == "summary":
                out["views"] = list(VIEWS[1:])
                out["notes"] = notes_of(doc)
            return out
        if not exchange:
            out["rows"] = []
            out["notes"] = [f"This profile was pushed as a {doc['format']} file: it has measures only, no {view}. Push the human-exchange JSON of the Export tab for the body and the posture."]
            return out
        out["rows"] = {"dims": dims_of, "angles": angles_of, "points": points_of}[view](doc)
        out["units"] = {"dims": "mm, kg", "angles": "deg", "points": "mm"}[view]
        if view == "points":
            out["axes"] = doc.get("axes", {}).get("note") or "+Y up, +Z front, +X the figure's left, floor y = 0"
        return out


def values_of(doc: dict, names: dict | None = None) -> dict:
    """{values: {key: number}, units: {key: unit}, measures: [{key, name, value, unit, status, reliability, basis, n}]}: the /v1/mannequin shape."""
    prof = doc["profile"] if doc["format"] == "human-exchange" else doc
    values, units, rows = {}, {}, []
    for k, m in prof.get("measures", {}).items():
        if not _isobj(m) or not _fin(m.get("value")):
            continue
        key = _text(k, 120)
        values[key] = m["value"]
        units[key] = _text(m.get("unit"), 20)
        rows.append({"key": key, "name": (names or {}).get(key) or key, "value": m["value"], "unit": units[key], "status": _text(m.get("status"), 30) or None,
                     "reliability": _text(m.get("reliability"), 20) or None, "basis": _text(m.get("basis"), 30) or None, "n": m.get("n") if _fin(m.get("n")) else None})
    core = {"stature_mm": values.get("stature"), "body_mass_kg": values.get("mass"), "sitting_height_mm": values.get("sitting_height")}
    return {"core": core, "values": values, "units": units, "measures": rows}


def dims_of(doc: dict) -> list:
    out = []
    for d in doc.get("body", {}).get("dims", []):
        if _isobj(d) and _fin(d.get("value")):
            out.append({"id": _text(d.get("id"), 80), "label": _text(d.get("label"), 120), "value": d["value"], "unit": _text(d.get("unit"), 10), "status": _text(d.get("status"), 20) or None})
    return out


def angles_of(doc: dict) -> list:
    """The root orientation, then one row per degree of freedom of every joint (all 77 joints of the website's rig, 0 where the posture leaves them)."""
    post = doc.get("posture") if _isobj(doc.get("posture")) else {}
    root = post.get("root") if _isobj(post.get("root")) else {}
    rows = [{"joint_id": "root", "joint_label": "Root (orientation of the pelvis in the world)", "side": None, "dof_key": k[: -len("_deg")], "dof_label": k[: -len("_deg")],
             "value_deg": root[k], "min_deg": None, "max_deg": None, "positive_means": None} for k in ("heading_deg", "flex_deg", "lat_deg", "rot_deg") if _fin(root.get(k))]
    for j in doc.get("body", {}).get("joints", []):
        for d in j.get("dof", []):
            rows.append({"joint_id": _text(j.get("id"), 60), "joint_label": _text(j.get("label"), 80), "side": _text(j.get("side"), 4) or None, "dof_key": _text(d.get("key"), 20),
                         "dof_label": _text(d.get("label"), 60), "value_deg": d.get("value_deg"), "min_deg": d.get("min_deg") if _fin(d.get("min_deg")) else None,
                         "max_deg": d.get("max_deg") if _fin(d.get("max_deg")) else None, "positive_means": _text(d.get("positive_means"), 80) or None})
    return rows


def points_of(doc: dict) -> list:
    body = doc.get("body", {})
    rows = [{"type": "joint", "id": _text(j.get("id"), 60), "label": _text(j.get("label"), 80), "x_mm": j["position_mm"][0], "y_mm": j["position_mm"][1], "z_mm": j["position_mm"][2]}
            for j in body.get("joints", []) if _pt(j.get("position_mm"))]
    rows += [{"type": "landmark", "id": _text(l.get("id"), 60), "label": _text(l.get("label"), 80), "x_mm": l["position_mm"][0], "y_mm": l["position_mm"][1], "z_mm": l["position_mm"][2]}
             for l in body.get("landmarks", []) if _pt(l.get("position_mm"))]
    return rows


def notes_of(doc: dict) -> list:
    out = []
    prof = doc["profile"] if doc["format"] == "human-exchange" else doc
    src = prof.get("source") if _isobj(prof.get("source")) else {}
    if src.get("kind") == "population" and src.get("percentile") is not None:
        out.append(f"A population profile: every measure is percentile {src.get('percentile')} of that measure alone (a boundary case, not a real person).")
    if doc["format"] == "human-exchange":
        out.append(_text(doc.get("note"), 300) or "A simplified kinematic model of the website.")
        out.append("values are the profile's survey measures (mm, kg); dims, angles and points come from the website's model of that body in the pushed posture.")
    for n in prof.get("notes", [])[:5] if isinstance(prof.get("notes"), list) else []:
        out.append(_text(n, 300))
    return [n for n in out if n]


# one store per directory, shared by the REST app and the MCP tools of a process
_STORES: dict = {}


def get_store(directory: str | os.PathLike | None = None) -> ProfileStore:
    d = str(Path(directory).expanduser() if directory else default_dir())
    if d not in _STORES:
        _STORES[d] = ProfileStore(d)
    return _STORES[d]


def rows_csv(columns: list, rows: list) -> str:
    """CSV with formula injection defused (a cell that starts with = + - @ gets a leading apostrophe, unless it is a number)."""
    from .formats import to_csv
    safe = []
    for r in rows:
        s = {}
        for k, v in r.items():
            if isinstance(v, str) and v[:1] in ("=", "+", "-", "@", "\t", "\r") and not re.fullmatch(r"[-+]?\d+(\.\d+)?", v):
                v = "'" + v
            s[k] = v
        safe.append(s)
    return to_csv(columns, safe)


COLUMNS = {
    "values": ["key", "name", "value", "unit", "status", "reliability", "basis", "n"],
    "dims": ["id", "label", "value", "unit", "status"],
    "angles": ["joint_id", "joint_label", "side", "dof_key", "dof_label", "value_deg", "min_deg", "max_deg", "positive_means"],
    "points": ["type", "id", "label", "x_mm", "y_mm", "z_mm"],
    "list": ["id", "received", "label", "sex", "format", "stature_mm", "mass_kg", "measures", "posture"],
}


def view_csv(view: str, data) -> str:
    if view == "list":
        return rows_csv(COLUMNS["list"], [{**m, "posture": (m.get("posture") or {}).get("name")} for m in data])
    rows = data["measures"] if view in ("values", "summary") else data["rows"]
    return rows_csv(COLUMNS["values" if view in ("values", "summary") else view], rows)


def view_xml(view: str, data) -> str:
    """Flat, attribute-based XML: <profile id=...><measure key= unit=>value</measure>...</profile> (values), or <row .../> for the tables."""
    import xml.etree.ElementTree as ET
    if view == "list":
        root = ET.Element("profiles")
        for m in data:
            ET.SubElement(root, "profile", {k: str(v) for k, v in m.items() if v is not None and not isinstance(v, dict)})
        return ET.tostring(root, encoding="unicode", xml_declaration=True)
    meta = data["profile"]
    root = ET.Element("profile", {k: str(meta[k]) for k in ("id", "label", "sex", "format", "received") if meta.get(k) is not None})
    if view in ("values", "summary"):
        for r in data["measures"]:
            e = ET.SubElement(root, "measure", {k: str(r[k]) for k in ("key", "name", "unit", "status", "reliability") if r.get(k) is not None})
            e.text = repr(float(r["value"])) if isinstance(r["value"], float) else str(r["value"])
    else:
        for r in data["rows"]:
            ET.SubElement(root, "row", {k: str(v) for k, v in r.items() if v is not None})
    return ET.tostring(root, encoding="unicode", xml_declaration=True)


__all__ = ["ProfileStore", "get_store", "validate", "values_of", "dims_of", "angles_of", "points_of", "view_csv", "view_xml", "TooLarge", "MAX_BYTES", "MAX_PROFILES", "VIEWS"]
