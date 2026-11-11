"""Local workflow bookkeeping only. No browser, network, scheduling or publishing."""
from __future__ import annotations

import argparse
import calendar
import hashlib
import json
import math
import re
import sys
from collections import Counter
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from uuid import uuid4
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]
LOCAL = timezone(timedelta(hours=8), "Asia/Shanghai")
QUOTAS = {"cross_industry": 15, "benchmark": 20, "home": 15}


def now() -> datetime:
    return datetime.now(LOCAL)


def load(path: Path):
    return json.loads(path.read_text(encoding="utf-8-sig"))


def save_new(path: Path, value):
    """Exclusive creation: never silently replace another session's output."""
    with path.open("x", encoding="utf-8", newline="\n") as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2)
        stream.write("\n")


def digest(value) -> str:
    raw = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def text(value) -> bool:
    return isinstance(value, str) and bool(value.strip())


def obj(value) -> dict:
    return value if isinstance(value, dict) else {}


def nonnegative(value) -> bool:
    if type(value) not in (int, float) or value < 0:
        return False
    try:
        return math.isfinite(value)
    except OverflowError:
        return False


def timestamp(value) -> datetime:
    if not text(value):
        raise ValueError("timestamp missing")
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise ValueError("timestamp must include timezone")
    return parsed.astimezone(LOCAL)


def publication(value):
    if isinstance(value, str) and re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
        return date.fromisoformat(value)
    return timestamp(value)


def months_before(day: date, months: int = 6) -> date:
    month_number = day.year * 12 + day.month - 1 - months
    year, month0 = divmod(month_number, 12)
    month = month0 + 1
    return date(year, month, min(day.day, calendar.monthrange(year, month)[1]))


def public_url(value) -> bool:
    if not text(value):
        return False
    try:
        parsed = urlsplit(value)
        return (parsed.scheme in ("http", "https") and bool(parsed.hostname)
                and not parsed.username and not parsed.password)
    except ValueError:
        return False


def batch_path(root: Path, batch_id: str) -> Path:
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,100}", batch_id):
        raise ValueError("invalid batch ID; use the ID printed by new-batch")
    parent = (root / "batches").resolve()
    target = (parent / batch_id).resolve()
    if not target.is_relative_to(parent):
        raise ValueError("batch path escapes workspace")
    return target


def new_batch(root: Path = ROOT, started: datetime | None = None) -> Path:
    started = (started or now()).astimezone(LOCAL)
    batch_id = started.strftime("%Y%m%d-%H%M%S") + "-" + uuid4().hex[:6]
    directory = batch_path(root, batch_id)
    benchmark_file = root / "data" / "benchmarks.json"
    account_data = obj(load(benchmark_file)) if benchmark_file.exists() else {}
    accounts = account_data.get("accounts", [])
    if not isinstance(accounts, list):
        raise ValueError("benchmarks.accounts must be an array")
    confirmed = [a for a in accounts if isinstance(a, dict) and a.get("status") == "confirmed"]
    metadata = {
        "schema_version": 1, "batch_id": batch_id,
        "started_at": started.isoformat(),
        "window_start": months_before(started.date()).isoformat(),
        "window_end": started.isoformat(),
        "timezone": "Asia/Shanghai", "quotas": dict(QUOTAS),
        "confirmed_benchmarks": confirmed,
    }
    directory.mkdir(parents=True, exist_ok=False)
    (directory / "assets").mkdir()
    save_new(directory / "batch.json", metadata)
    save_new(directory / "videos.json", [])
    save_new(directory / "excluded.json", [])
    return directory


def read_source(directory: Path) -> dict:
    return {"batch": load(directory / "batch.json"), "videos": load(directory / "videos.json")}


def missing_deliverables(directory: Path) -> list[str]:
    missing = []
    try:
        if not (directory / "report.md").read_text(encoding="utf-8-sig").strip():
            missing.append("report.md must be nonempty")
    except (OSError, UnicodeError):
        missing.append("report.md missing or unreadable")
    try:
        if not isinstance(load(directory / "excluded.json"), list):
            missing.append("excluded.json must be an array")
    except (OSError, ValueError):
        missing.append("excluded.json missing or invalid")
    return missing


def validate(directory: Path, as_of: datetime | None = None) -> dict:
    try:
        snapshot = read_source(directory)
    except (OSError, ValueError, TypeError) as exc:
        return {"batch_id": directory.name, "valid": False, "delivery_complete": False,
                "counts": {}, "errors": [f"cannot read batch: {exc}"], "warnings": [],
                "missing_deliverables": missing_deliverables(directory)}
    return validate_data(directory, snapshot["batch"], snapshot["videos"], as_of)


def validate_data(directory: Path, metadata, videos, as_of: datetime | None = None) -> dict:
    """Validate the exact in-memory source used for selection and fingerprinting."""
    errors, warnings = [], []
    counts = Counter()
    time_limit = (as_of or now()).astimezone(LOCAL) + timedelta(minutes=5)
    result = {"batch_id": directory.name, "valid": False, "delivery_complete": False,
              "counts": {}, "errors": errors, "warnings": warnings,
              "missing_deliverables": missing_deliverables(directory)}
    try:
        if not isinstance(metadata, dict) or not isinstance(videos, list):
            raise ValueError("batch must be an object and videos must be an array")
        start = timestamp(metadata.get("started_at"))
        if start > time_limit:
            errors.append("batch start is in the future")
        lower = months_before(start.date())
        if metadata.get("schema_version") != 1 or metadata.get("batch_id") != directory.name:
            errors.append("batch metadata: schema version or batch ID mismatch")
        if (metadata.get("timezone") != "Asia/Shanghai"
                or metadata.get("window_start") != lower.isoformat()
                or timestamp(metadata.get("window_end")) != start
                or metadata.get("quotas") != QUOTAS):
            errors.append("batch metadata: frozen window/timezone/quotas mismatch")
        snapshot = metadata.get("confirmed_benchmarks")
        if not isinstance(snapshot, list):
            raise ValueError("confirmed_benchmarks must be an array")
        confirmed = set()
        for account in snapshot:
            account = obj(account)
            if (account.get("status") != "confirmed" or not text(account.get("account_id"))
                    or not text(account.get("confirmed_by")) or not public_url(account.get("url"))):
                errors.append("benchmark snapshot: invalid confirmation or account identity")
                continue
            if timestamp(account.get("confirmed_at")) > start:
                errors.append("benchmark confirmation is after batch start")
            confirmed.add(account["account_id"])
    except (OSError, ValueError, TypeError) as exc:
        errors.append(f"cannot read batch: {exc}")
        return result

    seen = set()
    for index, record in enumerate(videos):
        row = obj(record)
        label = f"video[{index}]({row.get('video_id')})"

        def error(message):
            errors.append(f"{label}: {message}")

        def require(mapping, field):
            if not text(mapping.get(field)):
                error(f"missing text: {field}")

        video_id = row.get("video_id")
        if row.get("is_template") is not False:
            error("is_template must explicitly be false after real collection")
        if not isinstance(video_id, str) or not re.fullmatch(r"[0-9]+", video_id):
            error("video_id must be a numeric string")
        elif video_id in seen:
            error("duplicate video_id")
        else:
            seen.add(video_id)
        if row.get("url") != f"https://www.douyin.com/video/{video_id}":
            error("url must be the canonical direct URL matching video_id")
        category = row.get("category")
        if isinstance(category, str) and category in QUOTAS:
            counts[category] += 1
        else:
            error("invalid category")
        for field in ("account_id", "account_name", "title"):
            require(row, field)
        author = row.get("account_id")
        if category == "benchmark":
            if not isinstance(author, str) or author not in confirmed:
                error("benchmark author is not in the confirmed snapshot")
        elif isinstance(author, str) and author in confirmed:
            error("confirmed benchmark author must use benchmark category")
        expected_industry = "other" if category == "cross_industry" else "home"
        if row.get("industry") != expected_industry:
            error("industry conflicts with category")
        for field in ("comments", "likes"):
            if not nonnegative(row.get(field)):
                error(f"{field} must be a nonnegative finite number, not null/bool")
        display = obj(row.get("metric_display"))
        for field in ("comments_raw", "likes_raw"):
            require(display, field)
        if display.get("precision") not in ("exact", "rounded"):
            error("metric precision must be exact or rounded")
        if display.get("precision") == "rounded":
            warnings.append(f"{label}: metrics use rounded platform display")
        try:
            published = publication(row.get("published_at"))
            collected = timestamp(row.get("collected_at"))
            if collected > time_limit:
                error("collection timestamp is in the future")
            published_day = published.date() if isinstance(published, datetime) else published
            if not lower <= published_day <= start.date():
                error("publication outside six-calendar-month window")
            if isinstance(published, datetime) and published > start:
                error("publication is after batch start")
            if collected < start or collected.date() < published_day:
                error("collection predates batch or publication")
            if isinstance(published, datetime) and collected < published:
                error("collection predates publication timestamp")
        except (ValueError, TypeError):
            error("invalid publication/collection date or missing timezone")

        evidence_list = row.get("source_evidence")
        evidence_ids = set()
        if not isinstance(evidence_list, list) or not evidence_list:
            error("source_evidence must be a nonempty array")
        else:
            for evidence in evidence_list:
                evidence = obj(evidence)
                evidence_id = evidence.get("id")
                if not text(evidence_id) or evidence_id in evidence_ids:
                    error("evidence ID missing or duplicated")
                else:
                    evidence_ids.add(evidence_id)
                if not public_url(evidence.get("url")):
                    error("evidence must reference a public URL")
                if evidence.get("access") not in ("page", "video", "screenshot", "user_supplied"):
                    error("evidence must be actually viewed, not a search snippet")
                for field in ("tool", "note"):
                    require(evidence, field)
                try:
                    accessed = timestamp(evidence.get("accessed_at"))
                    if accessed < start or accessed > time_limit:
                        error("evidence access timestamp predates batch or is in the future")
                except (ValueError, TypeError):
                    error("invalid evidence access timestamp")

        review = obj(row.get("comment_review"))
        size, low = review.get("sample_size"), review.get("low_information_count")
        if review.get("status") != "pass":
            error("comment review is not pass")
        sample_valid = type(size) is int and size > 0 and type(low) is int and 0 <= low <= size
        if not sample_valid:
            error("invalid actual comment sample counts")
        else:
            if size < 30:
                warnings.append(f"{label}: fewer than target 30 visible comments; manually verify adequacy")
            if low * 2 > size and review.get("high_like_relative_to_candidates") is True:
                error("high-like / low-information-dominated comments excluded by user rule")
        if type(review.get("high_like_relative_to_candidates")) is not bool:
            error("high_like_relative_to_candidates must be explicitly reviewed")
        for field in ("sampling_method", "high_like_basis", "reason"):
            require(review, field)
        try:
            sampled = timestamp(review.get("sampled_at"))
            if sampled < start or sampled > time_limit:
                error("comment sampling predates batch or is in the future")
        except (ValueError, TypeError):
            error("invalid comment sampling timestamp")
        refs = review.get("evidence_ids")
        if (not isinstance(refs, list) or not refs
                or any(not isinstance(ref, str) or ref not in evidence_ids for ref in refs)):
            error("comment review must cite existing evidence IDs")

        materials = obj(row.get("materials"))
        script = obj(materials.get("script"))
        if script.get("status") not in ("summary", "authorized_transcript"):
            error("script structure/summary is required; no unlicensed full transcript")
        for field in ("content", "method"):
            require(script, field)
        caption = obj(materials.get("caption"))
        if caption.get("status") in ("verified", "summary"):
            for field in ("content", "method"):
                require(caption, field)
        elif caption.get("status") in ("none", "unavailable"):
            require(caption, "reason")
            warnings.append(f"{label}: caption {caption.get('status')}; see reason")
        else:
            error("caption status must be explicit")
        cover = obj(materials.get("cover"))
        if cover.get("status") == "verified":
            require(cover, "visual_analysis")
            reference = cover.get("reference")
            if not public_url(reference):
                if not text(reference):
                    error("cover reference missing")
                else:
                    target = (directory / reference).resolve()
                    if not target.is_relative_to(directory.resolve()) or not target.is_file():
                        error("cover local reference missing or outside batch")
        elif cover.get("status") == "unavailable":
            require(cover, "reason")
            warnings.append(f"{label}: cover unavailable; see reason")
        else:
            error("cover status must be verified or unavailable")
        bgm = obj(materials.get("bgm"))
        if bgm.get("status") == "verified":
            require(bgm, "name")
        elif bgm.get("status") in ("none", "unknown"):
            require(bgm, "reason")
            if bgm.get("status") == "unknown":
                warnings.append(f"{label}: BGM unknown; see reason")
        else:
            error("BGM status must be verified, none, or unknown")
        analysis = obj(row.get("analysis"))
        for field in ("hook", "interaction_driver", "adaptation", "do_not_copy", "risks"):
            require(analysis, field)

    for category, quota in QUOTAS.items():
        if counts[category] != quota:
            errors.append(f"quota {category}: {counts[category]}/{quota}")
    if len(videos) != 50:
        errors.append(f"total videos: {len(videos)}/50")
    result["counts"] = {key: counts[key] for key in QUOTAS}
    result["valid"] = not errors
    result["delivery_complete"] = result["valid"] and not result["missing_deliverables"]
    return result


def source_hash(directory: Path) -> str:
    return digest(read_source(directory))


def select(directory: Path, ids: list[str], confirmation: str) -> dict:
    if (directory / "selection.json").exists() or (directory / "handoff.json").exists():
        raise ValueError("selection already exists or is partial; preserve history and arrange a new version")
    snapshot = read_source(directory)
    result = validate_data(directory, snapshot["batch"], snapshot["videos"])
    if not result["valid"]:
        raise ValueError("batch is not valid: " + "; ".join(result["errors"][:5]))
    if not result["delivery_complete"]:
        raise ValueError("batch delivery incomplete: " + "; ".join(result["missing_deliverables"]))
    if not ids or len(set(ids)) != len(ids) or not text(confirmation):
        raise ValueError("unique selected IDs and actual user confirmation are required")
    records = {row["video_id"]: row for row in snapshot["videos"]}
    if any(key not in records for key in ids):
        raise ValueError("selected ID does not belong to this batch")
    fingerprint = digest(snapshot)
    if source_hash(directory) != fingerprint:
        raise ValueError("source changed during selection; freeze the batch and retry")
    selection = {"schema_version": 1, "batch_id": directory.name, "video_ids": ids,
                 "confirmed_at": now().isoformat(), "confirmation": confirmation,
                 "source_sha256": fingerprint}
    handoff = dict(selection, references=[records[key] for key in ids], warnings=result["warnings"])
    save_new(directory / "selection.json", selection)
    save_new(directory / "handoff.json", handoff)
    if source_hash(directory) != fingerprint:
        raise ValueError("source changed while saving handoff; preserve history and arrange a new version")
    return selection


def handoff_status(directory: Path) -> str:
    files = [directory / "selection.json", directory / "handoff.json"]
    if not any(path.exists() for path in files):
        return "not_selected"
    if not all(path.exists() for path in files):
        return "handoff_error"
    try:
        selection, handoff = map(load, files)
        if not isinstance(selection, dict) or not isinstance(handoff, dict):
            return "handoff_error"
        snapshot = read_source(directory)
        fingerprint = digest(snapshot)
        if selection.get("source_sha256") != fingerprint:
            return "source_changed"
        current = validate_data(directory, snapshot["batch"], snapshot["videos"])
        if not current["valid"]:
            return "invalid_source"
        if not current["delivery_complete"]:
            return "delivery_incomplete"
        if any(handoff.get(key) != value for key, value in selection.items()):
            return "handoff_error"
        ids = selection.get("video_ids")
        if (not isinstance(ids, list) or not ids or any(not isinstance(key, str) for key in ids)
                or len(set(ids)) != len(ids) or not text(selection.get("confirmation"))
                or selection.get("batch_id") != directory.name):
            return "handoff_error"
        if timestamp(selection.get("confirmed_at")) > now() + timedelta(minutes=5):
            return "handoff_error"
        records = {row["video_id"]: row for row in snapshot["videos"]}
        if handoff.get("references") != [records[key] for key in ids]:
            return "handoff_error"
        if source_hash(directory) != fingerprint:
            return "source_changed"
        return "ready_for_session3"
    except (OSError, ValueError, TypeError, KeyError):
        return "handoff_error"


def status(root: Path = ROOT) -> dict:
    parent = root / "batches"
    rows = []
    if parent.exists():
        for directory in sorted(parent.iterdir()):
            if directory.is_dir():
                result = validate(directory)
                rows.append({"batch_id": directory.name, "valid": result["valid"],
                             "delivery_complete": result["delivery_complete"],
                             "missing_deliverables": result["missing_deliverables"],
                             "counts": result["counts"], "errors": len(result["errors"]),
                             "warnings": len(result["warnings"]), "handoff": handoff_status(directory)})
    return {"automation": "local files only; browsers and independent chats not connected by this tool",
            "batches": rows}


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("new-batch")
    sub.add_parser("status")
    validator = sub.add_parser("validate")
    validator.add_argument("batch_id")
    chooser = sub.add_parser("select")
    chooser.add_argument("batch_id")
    chooser.add_argument("--ids", nargs="+", required=True)
    chooser.add_argument("--confirmation", required=True)
    options = parser.parse_args(argv)
    try:
        if options.command == "new-batch":
            directory = new_batch()
            output = {"batch_id": directory.name, "metadata": load(directory / "batch.json"),
                      "note": "empty batch only; no Douyin collection performed"}
        elif options.command == "status":
            output = status()
        elif options.command == "validate":
            output = validate(batch_path(ROOT, options.batch_id))
            print(json.dumps(output, ensure_ascii=False, indent=2))
            return 0 if output["valid"] else 1
        else:
            output = select(batch_path(ROOT, options.batch_id), options.ids, options.confirmation)
        print(json.dumps(output, ensure_ascii=False, indent=2))
        return 0
    except (OSError, ValueError, TypeError) as exc:
        print(json.dumps({"error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
