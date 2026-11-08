"""GET /health payload for the Laya sidecar: which artifact it serves.

Contract (plan docs/plans/2026-11-08-laya-model-artifact.md, Solution 5):

    GET /health -> {"status": "ok", "model"?, "version"?, "backend"?,
                    "artifact_sha256"?, "head_sha256"?, "served_head"?}

model / version / backend / artifact_sha256 come from the install record
(manifest.json) that `pi-laya-model install` writes next to the weights; a
model directory without one reports no identity. head_sha256 is computed from
the head this process actually SERVES, never copied from the record, so the
router can tell a train/serve head mismatch from a configuration typo.

Both hashes must equal the router's TypeScript implementations byte for byte
(headSha256 / artifactSha256 in src/laya-model-manifest.ts); the parity is
pinned by test/laya-sidecar-identity.test.ts. Stdlib only, Python 3.9+, so the
tests run without the MLX venv.

CLI (for the tests and for debugging a model directory):
    python3 -I identity.py [--model-dir DIR] [--head-json FILE]
"""
from __future__ import annotations

import argparse
import hashlib
import json
import pathlib
from typing import Optional, Tuple

INSTALL_RECORD = "manifest.json"
Head = Tuple[str, list]


def head_sha256(instructions: str, categories: list) -> str:
    # JSON.stringify({instructions, categories}): no whitespace, non-ASCII
    # verbatim (ensure_ascii=False), same key order.
    canonical = json.dumps(
        {"instructions": instructions, "categories": categories},
        separators=(",", ":"),
        ensure_ascii=False,
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def artifact_sha256(files: list) -> str:
    # One `sha256sum` line per file, sorted by path (paths are ASCII by the
    # manifest's safe-path rule, so code-point and UTF-16 order agree).
    lines = "".join(f"{f['sha256']}  {f['path']}\n" for f in sorted(files, key=lambda f: f["path"]))
    return hashlib.sha256(lines.encode("utf-8")).hexdigest()


def head_from_text(fmt: str, text: str) -> Optional[Head]:
    """Mirror of headFromFile (src/laya-model-manifest.ts); None = not a readable head."""
    try:
        raw = json.loads(text)
    except ValueError:
        return None
    src = raw
    if fmt == "laya-questions":
        cat = raw.get("category") if isinstance(raw, dict) else None
        src = {"instructions": cat.get("instructions"), "categories": cat.get("criteria")} if isinstance(cat, dict) else None
    if not isinstance(src, dict):
        return None
    instructions, categories = src.get("instructions"), src.get("categories")
    if not isinstance(instructions, str) or not isinstance(categories, list) or not categories:
        return None
    if not all(isinstance(c, str) for c in categories):
        return None
    return instructions, list(categories)


def read_record(model_dir: Optional[str]) -> Optional[dict]:
    """The install record, or None when absent, unreadable or of another schema."""
    if not model_dir:
        return None
    try:
        rec = json.loads((pathlib.Path(model_dir) / INSTALL_RECORD).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(rec, dict) or rec.get("schema_version") != 1:
        return None
    if not isinstance(rec.get("files"), list) or not isinstance(rec.get("head_file"), dict):
        return None
    return rec


def served_head(model_dir: Optional[str], head_json: Optional[str]) -> Tuple[Optional[Head], Optional[str]]:
    """(head, source): --head-json wins, else the head file the install record names.

    (None, None) means neither is there; server.py then serves the production prompt.
    """
    if head_json:
        head = head_from_text("head-json", pathlib.Path(head_json).read_text(encoding="utf-8"))
        if head is None:
            raise SystemExit(f"--head-json {head_json}: not a head ({{instructions, categories}})")
        return head, "head-json"
    rec = read_record(model_dir)
    if rec is not None:
        hf = rec["head_file"]
        try:
            text = (pathlib.Path(model_dir) / str(hf.get("path"))).read_text(encoding="utf-8")
        except OSError:
            return None, None
        head = head_from_text(str(hf.get("format")), text)
        if head is not None:
            return head, "record"
    return None, None


def health_payload(model_dir: Optional[str], head: Optional[Head], source: Optional[str]) -> dict:
    out: dict = {"status": "ok"}
    rec = read_record(model_dir)
    if rec is not None:
        for key in ("model", "version", "backend"):
            if isinstance(rec.get(key), str):
                out[key] = rec[key]
        try:
            out["artifact_sha256"] = artifact_sha256(rec["files"])
        except (KeyError, TypeError):
            pass  # the router treats every identity field as optional
    if head is not None:
        out["head_sha256"] = head_sha256(*head)
        out["served_head"] = source
    return out


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--model-dir")
    ap.add_argument("--head-json")
    a = ap.parse_args()
    h, src = served_head(a.model_dir, a.head_json)
    print(json.dumps(health_payload(a.model_dir, h, src), ensure_ascii=False))
