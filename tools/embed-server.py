#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
茉莉花的本地嵌入/重排 sidecar（2026-11-03）。

为什么是常驻进程：bge-small-zh 单条编码 10–20ms，但**每次冷启动 python + 加载模型要 5–10 秒**，
按需起进程比推理本身贵两个数量级。所以起一个本机 HTTP 服务，插件只在需要时打它。

约定：
  GET  /health                      → {"ok": true, "model": "...", "dim": 512, "idle_exit_min": 30}
  POST /embed   {"texts": [...], "query": false}
                                    → {"vectors": [[...], ...], "dim": 512}   （已 L2 归一化，余弦=点积）
  POST /rerank  {"query": "...", "texts": [...]}
                                    → {"scores": [0.12, -3.4, ...]}          （原始 logits，越大越相关）

模型：
  嵌入  BAAI/bge-small-zh-v1.5 —— **CLS 池化**，doc 不加前缀，query 加固定前缀
        （用 mean pooling 或漏掉 query 前缀都会掉点，2026-11-02 踩过）
  重排  BAAI/bge-reranker-base —— 有就加载，没有就 /rerank 返回 503，插件侧自动退回粗排

用法：
  G:\\Molly\\data\\singing\\venv312\\Scripts\\python.exe tools\\embed-server.py --port 8791
  --models <dir> 指向沙箱模型目录；生产将来固定到 G:\\Molly\\models\\
"""

import argparse
import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import torch

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

QUERY_PREFIX = "为这个句子生成表示以用于检索相关文章："

_state = {
    "embed": None,  # (tokenizer, model, dim)
    "rerank": None,  # (tokenizer, model)
    "last": time.time(),
    "lock": threading.Lock(),
    "hits": 0,  # 累计服务次数，用来在 /health 里判断「插件到底有没有在调我」
}


def load_embed(path):
    from transformers import AutoTokenizer, AutoModel

    tok = AutoTokenizer.from_pretrained(path)
    model = AutoModel.from_pretrained(path, torch_dtype=torch.float32)
    model.eval()
    dim = int(model.config.hidden_size)
    # CPU 机器上线程开太多反而慢；留两个核给聊天本身
    torch.set_num_threads(max(1, (os.cpu_count() or 4) - 2))
    print(f"[embed] 已加载 {path}（dim={dim}）", flush=True)
    return tok, model, dim


def load_rerank(path):
    from transformers import AutoTokenizer, AutoModelForSequenceClassification

    if not os.path.isdir(path) or not any(f.endswith(".safetensors") for f in os.listdir(path)):
        print(f"[rerank] 没找到模型：{path}", flush=True)
        return None
    tok = AutoTokenizer.from_pretrained(path)
    model = AutoModelForSequenceClassification.from_pretrained(path, torch_dtype=torch.float32)
    model.eval()
    print(f"[rerank] 已加载 {path}", flush=True)
    return tok, model


@torch.no_grad()
def embed(texts, is_query=False):
    tok, model, _ = _state["embed"]
    vecs = []
    batch = 16
    for i in range(0, len(texts), batch):
        chunk = [QUERY_PREFIX + t if is_query else t for t in texts[i:i + batch]]
        enc = tok(chunk, padding=True, truncation=True, max_length=512, return_tensors="pt")
        out = model(**enc)
        # CLS 池化：bge 系列用 [CLS]，不是 mean
        v = out.last_hidden_state[:, 0]
        v = torch.nn.functional.normalize(v, p=2, dim=1)
        vecs.extend(v.tolist())
    return vecs


@torch.no_grad()
def rerank(query, texts):
    tok, model = _state["rerank"]
    scores = []
    batch = 16
    for i in range(0, len(texts), batch):
        enc = tok([[query, t] for t in texts[i:i + batch]], padding=True, truncation=True,
                  max_length=320, return_tensors="pt")
        logits = model(**enc).logits.view(-1)
        scores.extend(logits.tolist())
    return scores


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        pass

    def _send(self, code, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _body(self):
        n = int(self.headers.get("content-length") or 0)
        if not n:
            return {}
        return json.loads(self.rfile.read(n).decode("utf-8-sig"))

    def do_GET(self):
        if self.path.startswith("/health"):
            _state["last"] = time.time()
            dim = _state["embed"][2] if _state["embed"] else 0
            self._send(200, {
                "ok": bool(_state["embed"]),
                "dim": dim,
                "rerank": bool(_state["rerank"]),
                "idle_exit_min": IDLE_EXIT_MIN,
                "hits": _state.get("hits", 0),
            })
        else:
            self._send(404, {"ok": False, "error": "not found"})

    def do_POST(self):
        _state["last"] = time.time()
        _t0 = time.time()
        try:
            body = self._body()
        except Exception as exc:  # noqa: BLE001
            self._send(400, {"ok": False, "error": f"bad json: {exc}"})
            return
        try:
            if self.path.startswith("/embed"):
                texts = [str(t) for t in body.get("texts") or []]
                if not texts:
                    self._send(400, {"ok": False, "error": "texts 不能为空"})
                    return
                if not _state["embed"]:
                    self._send(503, {"ok": False, "error": "embedding 未就绪"})
                    return
                with _state["lock"]:
                    vecs = embed(texts, bool(body.get("query")))
                _state["hits"] += 1
                _state["last"] = time.time()
                print(f"[embed] n={len(texts)} q={bool(body.get('query'))} {int((time.time() - _t0) * 1000)}ms", flush=True)
                self._send(200, {"vectors": vecs, "dim": len(vecs[0]) if vecs else 0})
            elif self.path.startswith("/rerank"):
                if not _state["rerank"]:
                    self._send(503, {"ok": False, "error": "reranker 未加载"})
                    return
                query = str(body.get("query") or "")
                texts = [str(t)[:400] for t in body.get("texts") or []]
                if not query or not texts:
                    self._send(400, {"ok": False, "error": "query/texts 不能为空"})
                    return
                with _state["lock"]:
                    scores = rerank(query, texts)
                _state["hits"] += 1
                _state["last"] = time.time()
                print(f"[rerank] n={len(texts)} {int((time.time() - _t0) * 1000)}ms q={query[:30]}", flush=True)
                self._send(200, {"scores": scores})
            else:
                self._send(404, {"ok": False, "error": "not found"})
        except Exception as exc:  # noqa: BLE001
            self._send(500, {"ok": False, "error": f"{type(exc).__name__}: {exc}"})


def idle_watchdog(server):
    while True:
        time.sleep(60)
        if IDLE_EXIT_MIN and (time.time() - _state["last"]) > IDLE_EXIT_MIN * 60:
            print(f"[idle] 空闲超过 {IDLE_EXIT_MIN} 分钟，退出", flush=True)
            threading.Thread(target=server.shutdown, daemon=True).start()
            return


def main():
    global IDLE_EXIT_MIN
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8791)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--models", default=r"${MOLLY_ROOT}\sandbox\molly-bench\models")
    ap.add_argument("--embed-name", default="bge-small-zh-v1.5")
    ap.add_argument("--rerank-name", default="bge-reranker-base")
    ap.add_argument("--idle-exit-min", type=int, default=30)
    ap.add_argument("--no-rerank", action="store_true")
    args = ap.parse_args()
    IDLE_EXIT_MIN = args.idle_exit_min

    _state["embed"] = load_embed(os.path.join(args.models, args.embed_name))
    if not args.no_rerank:
        _state["rerank"] = load_rerank(os.path.join(args.models, args.rerank_name))

    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"[serve] http://{args.host}:{args.port} 就绪", flush=True)
    threading.Thread(target=idle_watchdog, args=(server,), daemon=True).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


IDLE_EXIT_MIN = 30

if __name__ == "__main__":
    main()
