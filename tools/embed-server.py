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
import gc
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
    # —— 2026-11-03 起给控制台留的口子（主人说「后期想优化控制台界面，正好能接进去」）
    # /stats 直接读这些数，控制台不需要解析日志文件；日志文件只是给人事后翻的。
    "started_at": time.time(),
    "embed_calls": 0,
    "embed_items": 0,
    "embed_ms": 0,
    "embed_max_ms": 0,
    "rerank_calls": 0,
    "rerank_items": 0,
    "rerank_ms": 0,
    "rerank_max_ms": 0,
    "last_kind": "",
    "last_ms": 0,
    "last_q": "",
    "errors": 0,
    "recent": [],  # 最近 20 次调用，给控制台做「最近调用」列表
}

RECENT_MAX = 20
LOG_PATH = ""  # 由 --log 设定；空表示只打 stdout


def log_event(kind, **fields):
    """记一条结构化日志：写文件（JSONL）+ 留在内存里给 /stats。

    为什么不是纯文本：控制台要把它渲染成表格（谁在调、多少次、多慢），
    JSONL 一行一个事件，前端直接 JSON.parse 就行，不用再写解析器。
    """
    now = time.time()
    evt = {"at": int(now * 1000), "kind": kind}
    evt.update(fields)
    recent = _state["recent"]
    recent.append(evt)
    if len(recent) > RECENT_MAX:
        del recent[0:len(recent) - RECENT_MAX]
    if not LOG_PATH:
        return
    try:
        # 简单轮转：单文件过 8MB 就换 .1（日志只是观测，不追求无损）
        if os.path.exists(LOG_PATH) and os.path.getsize(LOG_PATH) > 8 * 1024 * 1024:
            os.replace(LOG_PATH, LOG_PATH + ".1")
        with open(LOG_PATH, "a", encoding="utf-8") as f:
            f.write(json.dumps(evt, ensure_ascii=False) + "\n")
    except Exception:  # noqa: BLE001
        pass  # 日志写不进去绝不能影响推理


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
                "uptime_s": int(time.time() - _state["started_at"]),
            })
        elif self.path.startswith("/stats"):
            # 给控制台的一次性快照：不需要它去 tail 日志文件
            self._send(200, {
                "ok": True,
                "uptime_s": int(time.time() - _state["started_at"]),
                "hits": _state["hits"],
                "embed": {
                    "calls": _state["embed_calls"],
                    "items": _state["embed_items"],
                    "ms_avg": round(_state["embed_ms"] / max(1, _state["embed_calls"]), 1),
                    "ms_max": _state["embed_max_ms"],
                },
                "rerank": {
                    "calls": _state["rerank_calls"],
                    "items": _state["rerank_items"],
                    "ms_avg": round(_state["rerank_ms"] / max(1, _state["rerank_calls"]), 1),
                    "ms_max": _state["rerank_max_ms"],
                },
                "errors": _state["errors"],
                "last": {
                    "kind": _state["last_kind"],
                    "ms": _state["last_ms"],
                    "query": _state["last_q"],
                },
                "recent": _state["recent"][-10:],
                "log_file": LOG_PATH,
                "models": _state.get("models_dir", ""),
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
            if self.path.startswith("/config"):
                # 2026-11-05 控制台改完配置就地推过来，不用重启侧车
                global RERANK_IDLE_MIN
                mode = body.get("rerankMode")
                val = body.get("rerankIdleMin")
                if mode == "always":
                    RERANK_IDLE_MIN = 0
                elif isinstance(val, (int, float)):
                    RERANK_IDLE_MIN = max(0, int(val))
                self._send(200, {"ok": True, "rerank_idle_min": RERANK_IDLE_MIN, "rerank": bool(_state["rerank"])})
            elif self.path.startswith("/unload"):
                # 2026-11-05 控制台「储存与占用 → 立即回收」：把还能按需重载的模型放掉。
                # embed 放掉后 /embed 会 503（插件的召回会静默退回关键词），所以默认只卸重排，
                # 只有显式传 embed:true（主人点「立即回收」）才连嵌入一起放。
                unloaded = []
                with _state["lock"]:
                    if body.get("rerank", True) and _state["rerank"]:
                        _state["rerank"] = None
                        unloaded.append("rerank")
                    if body.get("embed", False) and _state["embed"]:
                        _state["embed"] = None
                        unloaded.append("embed")
                gc.collect()
                try:
                    import torch  # noqa: PLC0415  (放到这里，没装 torch 也不影响其余功能)
                    torch.cuda.empty_cache()
                except Exception:  # noqa: BLE001
                    pass
                print(f"[unload] {','.join(unloaded) or 'nothing'}", flush=True)
                log_event("unload", items=unloaded)
                self._send(200, {"ok": True, "unloaded": unloaded})
            elif self.path.startswith("/embed"):
                texts = [str(t) for t in body.get("texts") or []]
                if not texts:
                    self._send(400, {"ok": False, "error": "texts 不能为空"})
                    return
                if not _state["embed"]:
                    # 2026-11-05 懒加载：控制台「立即回收」会连嵌入一起放掉，
                    # 下一次召回在这里重新装回来（2~4 秒），别让嵌入再也起不来。
                    epath = _state.get("embed_path") or ""
                    if not epath or not os.path.isdir(epath):
                        self._send(503, {"ok": False, "error": "embedding 未就绪（也没有可加载的模型目录）"})
                        return
                    print(f"[embed] 懒加载 {epath}", flush=True)
                    log_event("embed_load", path=epath)
                    with _state["lock"]:
                        _state["embed"] = load_embed(epath)
                with _state["lock"]:
                    vecs = embed(texts, bool(body.get("query")))
                _state["hits"] += 1
                _state["last"] = time.time()
                _ms = int((time.time() - _t0) * 1000)
                _state["embed_calls"] += 1
                _state["embed_items"] += len(texts)
                _state["embed_ms"] += _ms
                _state["embed_max_ms"] = max(_state["embed_max_ms"], _ms)
                _state["last_kind"] = "embed"
                _state["last_ms"] = _ms
                _state["last_q"] = (texts[0][:40] if texts else "")
                log_event("embed", n=len(texts), ms=_ms, query=bool(body.get("query")),
                          head=(texts[0][:40] if texts else ""))
                print(f"[embed] n={len(texts)} q={bool(body.get('query'))} {_ms}ms", flush=True)
                self._send(200, {"vectors": vecs, "dim": len(vecs[0]) if vecs else 0})
            elif self.path.startswith("/rerank"):
                if not _state["rerank"]:
                    # 2026-11-05 懒加载：控制台「储存与占用」可以把重排卸掉省 1.2~1.5 GB，
                    # 下次真有召回请求时在这里重新装回来（第一次会慢 3~8 秒，之后照旧）。
                    path = _state.get("rerank_path") or ""
                    if not path or not os.path.isdir(path):
                        self._send(503, {"ok": False, "error": "reranker 未加载（也没有可加载的模型目录）"})
                        return
                    print(f"[rerank] 懒加载 {path}", flush=True)
                    log_event("rerank_load", path=path)
                    with _state["lock"]:
                        _state["rerank"] = load_rerank(path)
                query = str(body.get("query") or "")
                texts = [str(t)[:400] for t in body.get("texts") or []]
                if not query or not texts:
                    self._send(400, {"ok": False, "error": "query/texts 不能为空"})
                    return
                with _state["lock"]:
                    scores = rerank(query, texts)
                _state["hits"] += 1
                _state["last"] = time.time()
                _ms = int((time.time() - _t0) * 1000)
                _state["rerank_calls"] += 1
                _state["rerank_items"] += len(texts)
                _state["rerank_ms"] += _ms
                _state["rerank_max_ms"] = max(_state["rerank_max_ms"], _ms)
                _state["last_kind"] = "rerank"
                _state["rerank_last_at"] = time.time()
                _state["last_ms"] = _ms
                _state["last_q"] = query[:40]
                log_event("rerank", n=len(texts), ms=_ms, query=query[:40])
                print(f"[rerank] n={len(texts)} {_ms}ms q={query[:30]}", flush=True)
                self._send(200, {"scores": scores})
            else:
                self._send(404, {"ok": False, "error": "not found"})
        except Exception as exc:  # noqa: BLE001
            _state["errors"] += 1
            log_event("error", path=self.path, error=f"{type(exc).__name__}: {exc}")
            self._send(500, {"ok": False, "error": f"{type(exc).__name__}: {exc}"})


def idle_watchdog(server):
    while True:
        time.sleep(60)
        # 2026-11-05：可选的重排空闲卸载（默认关，RERANK_IDLE_MIN=0）。
        # 为什么单独一条：重排只有召回时才用，闲置时白占 1.2~1.5 GB；
        # 但第一次再召回要重新加载（3~8 秒），所以只给内存紧张的部署者开。
        if RERANK_IDLE_MIN and _state["rerank"]:
            idle_min = (time.time() - _state.get("rerank_last_at", _state["started_at"])) / 60.0
            if idle_min > RERANK_IDLE_MIN:
                with _state["lock"]:
                    _state["rerank"] = None
                gc.collect()
                try:
                    torch.cuda.empty_cache()
                except Exception:  # noqa: BLE001
                    pass
                print(f"[rerank] 空闲 {idle_min:.0f} 分钟，已卸载", flush=True)
                log_event("rerank_unload", idle_min=round(idle_min, 1))
        if IDLE_EXIT_MIN and (time.time() - _state["last"]) > IDLE_EXIT_MIN * 60:
            print(f"[idle] 空闲超过 {IDLE_EXIT_MIN} 分钟，退出", flush=True)
            threading.Thread(target=server.shutdown, daemon=True).start()
            return


def port_in_use(host, port):
    import socket

    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.5)
        return s.connect_ex((host, port)) == 0


def main():
    global IDLE_EXIT_MIN, LOG_PATH
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8791)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--models", default=r"${MOLLY_ROOT}\sandbox\molly-bench\models")
    ap.add_argument("--embed-name", default="bge-small-zh-v1.5")
    ap.add_argument("--rerank-name", default="bge-reranker-base")
    ap.add_argument("--idle-exit-min", type=int, default=30)
    ap.add_argument("--rerank-idle-min", type=int, default=0,
                    help="重排空闲多少分钟就卸载（0=不卸载；内存紧张时给 5~10）")
    ap.add_argument("--no-rerank", action="store_true")
    # 2026-11-03 主人要接控制台：日志默认落到数据目录，JSONL 一行一个事件
    ap.add_argument("--log", default=r"${MOLLY_ROOT}\data\qq-whale\embed-server.log.jsonl")
    args = ap.parse_args()
    IDLE_EXIT_MIN = args.idle_exit_min
    RERANK_IDLE_MIN = max(0, args.rerank_idle_min)
    LOG_PATH = args.log or ""
    _state["models_dir"] = args.models
    # 2026-11-05 与控制台共用一份策略：桌面壳、控制台、侧车都读 out\\mem-config.json，
    # 免得「控制台里关了重排」而侧车还常驻着 1.2 GB。命令行显式给了就不覆盖。
    cfg_path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "out", "mem-config.json")
    try:
        with open(cfg_path, encoding="utf-8") as fh:
            _cfg = json.load(fh)
        if _cfg.get("rerankMode") == "always":
            RERANK_IDLE_MIN = 0
        elif not args.rerank_idle_min and isinstance(_cfg.get("rerankIdleMin"), (int, float)):
            RERANK_IDLE_MIN = max(0, int(_cfg["rerankIdleMin"]))
        print(f"[serve] 策略来自 {cfg_path}：重排空闲卸载 {RERANK_IDLE_MIN} 分钟", flush=True)
    except Exception:
        pass
    _state["embed_path"] = os.path.join(args.models, args.embed_name)
    _state["rerank_path"] = os.path.join(args.models, args.rerank_name)

    # 2026-11-03 多开守卫：插件的 ensure() 每次启动都会 spawn 一次，而
    # ThreadingHTTPServer 默认 allow_reuse_address 在 Windows 上等于 SO_REUSEADDR，
    # 第二个实例也能 bind 成功 —— 于是两份模型（1.2GB 内存）常驻，还会多出控制台窗口。
    # 所以先探测端口：已经有人应答就立刻退出，连模型都不加载。
    if port_in_use(args.host, args.port):
        print(f"[serve] {args.host}:{args.port} 已有实例在跑，本次退出", flush=True)
        return

    _state["embed"] = load_embed(os.path.join(args.models, args.embed_name))
    if not args.no_rerank:
        _state["rerank"] = load_rerank(os.path.join(args.models, args.rerank_name))

    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"[serve] http://{args.host}:{args.port} 就绪", flush=True)
    log_event("boot", port=args.port, models=args.models,
              embed=args.embed_name, rerank=(not args.no_rerank),
              idle_exit_min=IDLE_EXIT_MIN, pid=os.getpid())
    threading.Thread(target=idle_watchdog, args=(server,), daemon=True).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    log_event("stop", pid=os.getpid(), hits=_state["hits"])


IDLE_EXIT_MIN = 30
RERANK_IDLE_MIN = 0

if __name__ == "__main__":
    main()
