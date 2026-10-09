"""Throwaway spike: expose Laya-MLX over the router's replay contract.

    POST /classify {"prompt": "..."} -> {"category", "confidence", "probabilities", "ms"}

Usage (venv outside the repo, see docs/research/2026-10-09-laya-spike.md):
    python server.py --port 8089
"""
import argparse, json, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from huggingface_hub import snapshot_download
import laya_mlx as laya

REPO = "aac6fef/laya-multilingual-mlx"
REVISION = "f2b4faf51023039425946074e2cf1361d2db11d5"  # pinned

# The nine router categories. The model sees only the `criteria` labels and the
# single `instructions` string, so the descriptions go INTO the instructions
# (spike variant B: confidence on distinct classes rose, e.g. planning 0.55 ->
# 0.89, exploration 0.46 -> 0.95; see docs/research/2026-10-09-laya-spike.md).
CATEGORIES = {
    "trivial": "greeting, thanks, or one-word acknowledgement",
    "simple": "simple question needing little reasoning",
    "code_simple": "small well-scoped code change or one-line fix",
    "standard": "typical everyday task, explanation or short writing",
    "code_complex": "non-trivial coding: debugging, refactoring, multi-file changes, tests",
    "design": "software architecture or API design",
    "planning": "planning, roadmap, task breakdown",
    "exploration": "searching, reading or researching code or a topic",
    "fallback": "unclear, fits no other category",
}
QUESTION = {"category": {"type": "choice",
                         "instructions": "Classify the user's request. " + "; ".join(f"{k}: {v}" for k, v in CATEGORIES.items()),
                         "criteria": list(CATEGORIES)}}

agent = laya.load(snapshot_download(REPO, revision=REVISION))
agent.predict("warmup", QUESTION)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):  # quiet
        pass

    def do_POST(self):
        if self.path != "/classify":
            self.send_response(404); self.end_headers(); return
        try:
            body = json.loads(self.rfile.read(int(self.headers.get("content-length", 0))))
            t = time.perf_counter()
            ans = agent.predict(str(body["prompt"]), QUESTION)["answers"]["category"]
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
    ap = argparse.ArgumentParser(); ap.add_argument("--port", type=int, default=8089)
    ThreadingHTTPServer(("127.0.0.1", ap.parse_args().port), Handler).serve_forever()
