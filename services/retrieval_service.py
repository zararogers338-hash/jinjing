#!/usr/bin/env python3
"""Persistent JSONL service around Jinjing's bundled hybrid retrieval."""

from __future__ import annotations

import argparse
import json
import sqlite3
import sys
import time
from pathlib import Path
from typing import Any


class Runtime:
    def __init__(self, skill: Path) -> None:
        self.skill = skill.resolve()
        self.scripts = self.skill / "scripts"
        self.db = self.skill / "data" / "jinjing_evidence.db"
        self.model_path = self.skill / "models" / "bge-m3"
        if not self.db.is_file():
            raise FileNotFoundError(f"Missing bundled database: {self.db}")
        sys.path.insert(0, str(self.scripts))
        import search_evidence  # type: ignore

        self.search_module = search_evidence
        self.model = None
        self.model_device = None
        self.search_module.encode_query = self.encode_query

    def encode_query(self, query: str, model_path: Path) -> Any:
        import numpy as np
        import torch
        from sentence_transformers import SentenceTransformer
        from transformers.utils import logging as transformers_logging

        if self.model is None:
            transformers_logging.set_verbosity_error()
            transformers_logging.disable_progress_bar()
            self.model_device = "cuda" if torch.cuda.is_available() else "cpu"
            print(f"Loading bundled BGE-M3 on {self.model_device}...", file=sys.stderr, flush=True)
            self.model = SentenceTransformer(str(model_path), device=self.model_device, local_files_only=True)
            self.model.max_seq_length = 512
            if self.model_device == "cuda":
                self.model.half()
            print("BGE-M3 ready", file=sys.stderr, flush=True)
        vector = self.model.encode(
            [query], convert_to_numpy=True, normalize_embeddings=True, show_progress_bar=False
        )[0]
        return np.asarray(vector, dtype=np.float32)

    def health(self) -> dict[str, Any]:
        with sqlite3.connect(f"file:{self.db}?mode=ro", uri=True) as conn:
            papers = conn.execute("SELECT COUNT(*) FROM papers").fetchone()[0]
            abstracts = conn.execute("SELECT COUNT(*) FROM papers WHERE length(abstract) > 0").fetchone()[0]
            embeddings = conn.execute("SELECT COUNT(*) FROM paper_embeddings").fetchone()[0]
        return {
            "ok": True,
            "papers": papers,
            "abstracts": abstracts,
            "embeddings": embeddings,
            "databaseBytes": self.db.stat().st_size,
            "modelPresent": self.model_path.is_dir(),
            "modelLoaded": self.model is not None,
        }

    def search(self, params: dict[str, Any]) -> dict[str, Any]:
        query = str(params.get("query", "")).strip()
        if not query:
            raise ValueError("Query is empty")
        started = time.perf_counter()
        result = self.search_module.run_search(
            db_path=self.db,
            query=query,
            top_k=max(1, min(int(params.get("topK", 5)), 20)),
            topic=params.get("topic") or None,
            year_from=int(params["yearFrom"]) if params.get("yearFrom") else None,
            with_abstract=not bool(params.get("allowNoAbstract", False)),
            lexical_only=bool(params.get("lexicalOnly", False)),
            model_path=self.model_path,
        )
        result["elapsedMs"] = round((time.perf_counter() - started) * 1000)
        result["modelLoaded"] = self.model is not None
        return result


def serve(runtime: Runtime) -> None:
    handlers = {"health": lambda _: runtime.health(), "search": runtime.search}
    for line in sys.stdin:
        try:
            request = json.loads(line)
            method = request.get("method")
            if method not in handlers:
                raise ValueError(f"Unknown method: {method}")
            response = {"id": request.get("id"), "result": handlers[method](request.get("params") or {})}
        except Exception as exc:  # service boundary
            response = {"id": request.get("id") if "request" in locals() else None, "error": f"{type(exc).__name__}: {exc}"}
        print(json.dumps(response, ensure_ascii=False), flush=True)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--skill", type=Path, required=True)
    args = parser.parse_args()
    serve(Runtime(args.skill))


if __name__ == "__main__":
    main()
