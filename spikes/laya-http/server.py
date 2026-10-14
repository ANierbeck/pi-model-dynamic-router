"""Throwaway spike: expose Laya-MLX over the router's replay contract.

    POST /classify {"prompt": "...", "context"?: {previousUserMessage?, lastAssistantSnippet?}} -> {"category", "confidence", "probabilities", "ms"}

Usage (venv outside the repo, see docs/research/2026-10-09-laya-spike.md):
    python server.py --port 8089
"""
import argparse, json, pathlib, re, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from huggingface_hub import snapshot_download
import laya_mlx as laya

REPO = "aac6fef/laya-multilingual-mlx"
REVISION = "f2b4faf51023039425946074e2cf1361d2db11d5"  # pinned

# Task definition = the PRODUCTION classifier prompt, read from its single source of
# truth (src/classification-prompt.ts), so both systems get the same category
# definitions, examples and rules (spike variant C; variant A/B used my own
# wording, which made the comparison unfair). Only the HINT sections and the JSON
# answer format are dropped: HINTs are detected deterministically before any
# classifier runs, and Laya answers with probabilities instead of JSON.
PROMPT_TS = pathlib.Path(__file__).resolve().parents[2] / "src" / "classification-prompt.ts"


def production_task_text() -> tuple[str, list[str]]:
    """The FROZEN v2-r3 short head (Laya's window is ~1024 tokens; the full
    production prompt body alone would fill it). Byte-identical to
    LAYA_HEAD_V2_INSTRUCTIONS in src/classification-prompt.ts and to the
    training/serving head ~/.laya-ft/data/laya_head_v2.json (written by
    to_laya_jsonl_v2.py). --head-json overrides this with the artifact copy."""
    src = PROMPT_TS.read_text()
    seg = src[src.index("export const LAYA_HEAD_V2_INSTRUCTIONS ="):]
    seg = seg[: seg.index(";")]
    instructions = "".join(p.replace("\\'", "'") for p in re.findall(r"'((?:\\.|[^'\\])*)'", seg))
    catseg = src[src.index("export const VALID_CATEGORIES = ["):]
    cats = re.findall(r"'([a-z_]+)'", catseg[: catseg.index("]")])
    return instructions, cats


# --head-json <file>: serve a fine-tuned model with EXACTLY the head it was trained on
# ({"instructions": str, "categories": [str]}, written by ~/.laya-ft/to_laya_jsonl_v2.py).
# Train/serve parity is the hard rule: a different head measures prompt drift, not the model.
# Without the flag the head is the production prompt (zero-shot, v2-r3: 7 categories).
_early = argparse.ArgumentParser(add_help=False)
_early.add_argument("--head-json")
_head_path = _early.parse_known_args()[0].head_json
if _head_path:
    _h = json.loads(pathlib.Path(_head_path).read_text())
    INSTRUCTIONS, CATEGORIES = _h["instructions"], list(_h["categories"])
else:
    INSTRUCTIONS, CATEGORIES = production_task_text()
    assert len(CATEGORIES) == 7, CATEGORIES
QUESTION = {"category": {"type": "choice", "instructions": INSTRUCTIONS, "criteria": CATEGORIES}}


def build_state(prompt: str, context: dict | None) -> str:
    """Mirror the production layout: optional background context, then the request."""
    lines = []
    if context and context.get("previousUserMessage"):
        lines.append(f'Previous user message: "{context["previousUserMessage"][:120]}"')
    if context and context.get("lastAssistantSnippet"):
        lines.append(f'Last assistant response (excerpt): "{context["lastAssistantSnippet"][:150]}"')
    head = "Context (background only):\n" + "\n".join(lines) + "\n\n" if lines else ""
    return f'{head}Current request: "{prompt}"'


# --model-dir <path>: serve a fine-tuned local checkpoint instead of the pinned
# HF snapshot (laya_mlx maps upstream PyTorch parameter names itself, so a
# laya-train output directory loads directly - no separate conversion step).
_early2 = argparse.ArgumentParser(add_help=False)
_early2.add_argument("--model-dir")
_model_dir = _early2.parse_known_args()[0].model_dir
agent = laya.load(_model_dir if _model_dir else snapshot_download(REPO, revision=REVISION))
agent.predict(build_state("warmup", None), QUESTION)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):  # quiet
        pass

    def do_POST(self):
        if self.path != "/classify":
            self.send_response(404); self.end_headers(); return
        try:
            body = json.loads(self.rfile.read(int(self.headers.get("content-length", 0))))
            t = time.perf_counter()
            ans = agent.predict(build_state(str(body["prompt"]), body.get("context")), QUESTION)["answers"]["category"]
            out = {"category": ans["choice"], "confidence": ans["answer_confidence"],
                   "probabilities": ans["probabilities"], "ms": round((time.perf_counter() - t) * 1000, 2)}
            code = 200
        except Exception as e:  # spike: report, don't crash
            out, code = {"error": str(e)}, 500
        data = json.dumps(out).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


if __name__ == "__main__":
    ap = argparse.ArgumentParser(); ap.add_argument("--port", type=int, default=8089); ap.add_argument("--head-json"); ap.add_argument("--model-dir")
    ThreadingHTTPServer(("127.0.0.1", ap.parse_args().port), Handler).serve_forever()
