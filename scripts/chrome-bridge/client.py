#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""DSH Browser Bridge 只读客户端 —— 对接已安装的 Chrome 扩展与本机 relay。

架构（用户已有，无需重装）：
    Chrome 扩展 "DSH Browser Bridge"（Profile 1，unpacked，chrome.debugger/CDP）
        └─ 长轮询 relay http://127.0.0.1:8787/poll
    DSH 后台任务运行 browser-bridge/server.mjs（listen 127.0.0.1:8787）
    本脚本调用 relay 的 POST /rpc，命令由扩展在真实 Chrome 里执行。

只读边界：
    - 只用 Runtime.evaluate / Page.navigate / Page.captureScreenshot 等读取类命令。
    - 不读取 Cookie、密码库、浏览历史数据库。
    - 点击/导航会改变页面状态，仅在明确需要时使用。

用法：
    python scripts/browser_bridge/client.py status
    python scripts/browser_bridge/client.py ping
    python scripts/browser_bridge/client.py tabs
    python scripts/browser_bridge/client.py new-tab "https://www.douyin.com/"
    python scripts/browser_bridge/client.py eval 123 --js "document.title"
    python scripts/browser_bridge/client.py eval 123 --file probe.js
    python scripts/browser_bridge/client.py nav 123 "https://www.douyin.com/"
    python scripts/browser_bridge/client.py shot 123 "reviews/x.png"
    python scripts/browser_bridge/client.py scroll 123 --by 900
    python scripts/browser_bridge/client.py click 123 "css selector"
    python scripts/browser_bridge/client.py close 123
    python scripts/browser_bridge/client.py rpc send '{"tabId":123,"method":"Page.getNavigationHistory"}'
"""

import argparse
import base64
import json
import sys
import time
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

RELAY = "http://127.0.0.1:8787"


def _get(path, timeout=10.0):
    try:
        with urlopen(RELAY + path, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except URLError as exc:
        raise SystemExit(json.dumps({
            "ok": False,
            "error": "relay_unreachable",
            "detail": str(exc.reason),
            "hint": "relay 未运行：在浏览器桥接工作区运行 node server.mjs（或让 DSH 后台任务启动），端口 8787。",
        }, ensure_ascii=False, indent=2))


def rpc(cmd, params=None, timeout_ms=30000):
    payload = {"cmd": cmd, "params": params or {}, "timeout": int(timeout_ms)}
    req = Request(RELAY + "/rpc",
                  data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
                  headers={"Content-Type": "application/json"},
                  method="POST")
    try:
        with urlopen(req, timeout=timeout_ms / 1000.0 + 20) as resp:
            body = json.loads(resp.read().decode("utf-8"))
    except HTTPError as exc:
        raise SystemExit(json.dumps({"ok": False, "error": "http_%s" % exc.code}, ensure_ascii=False, indent=2))
    except URLError as exc:
        raise SystemExit(json.dumps({
            "ok": False,
            "error": "relay_unreachable",
            "detail": str(exc.reason),
        }, ensure_ascii=False, indent=2))
    if not body.get("ok"):
        raise SystemExit(json.dumps({
            "ok": False,
            "error": body.get("error") or "command_failed",
            "id": body.get("id"),
        }, ensure_ascii=False, indent=2))
    return body.get("result")


def _print(obj):
    print(json.dumps(obj, ensure_ascii=False, indent=2))


# ---------------------------------------------------------------- CDP helpers

def eval_js(tab_id, expression, timeout_ms=30000):
    """在页面主世界执行 JS，返回值（returnByValue）。"""
    result = rpc("send", {
        "tabId": int(tab_id),
        "method": "Runtime.evaluate",
        "params": {
            "expression": expression,
            "returnByValue": True,
            "awaitPromise": True,
        },
        "timeoutMs": timeout_ms,
    }, timeout_ms=timeout_ms)
    if not isinstance(result, dict):
        return result
    if result.get("exceptionDetails"):
        raise SystemExit(json.dumps({
            "ok": False,
            "error": "js_exception",
            "exception": result["exceptionDetails"].get("text"),
            "detail": result["exceptionDetails"].get("exception", {}).get("description"),
        }, ensure_ascii=False, indent=2))
    return result.get("result", {}).get("value")


def wait_ready(tab_id, timeout_ms=20000):
    deadline = time.time() + timeout_ms / 1000.0
    last = None
    while time.time() < deadline:
        try:
            last = eval_js(tab_id, "document.readyState", timeout_ms=5000)
            if last == "complete":
                return True
        except SystemExit:
            pass
        time.sleep(0.5)
    return last == "complete"


def navigate(tab_id, url, timeout_ms=30000):
    rpc("send", {"tabId": int(tab_id), "method": "Page.navigate",
                 "params": {"url": url}, "timeoutMs": timeout_ms}, timeout_ms=timeout_ms)
    wait_ready(tab_id, timeout_ms)
    return eval_js(tab_id, "({href: location.href, title: document.title, readyState: document.readyState})")


def new_tab(url):
    result = rpc("newTab", {"url": url}, timeout_ms=30000)
    tab_id = result.get("id")
    wait_ready(tab_id, 30000)
    return result


# ---------------------------------------------------------------- commands

def cmd_status(args):
    _print(_get("/status"))


def cmd_ping(args):
    _print(rpc("ping", {}, timeout_ms=15000))


def cmd_tabs(args):
    _print(rpc("tabs", {}, timeout_ms=15000))


def cmd_new_tab(args):
    _print(new_tab(args.url))


def cmd_eval(args):
    expression = args.js
    if args.file:
        expression = Path(args.file).read_text(encoding="utf-8")
    if not expression:
        raise SystemExit("需要 --js 或 --file")
    _print({"ok": True, "tabId": args.tab, "value": eval_js(args.tab, expression)})


def cmd_nav(args):
    _print(navigate(args.tab, args.url))


def cmd_shot(args):
    result = rpc("screenshot", {"tabId": int(args.tab)}, timeout_ms=30000)
    data_url = (result or {}).get("dataUrl") or ""
    if "," not in data_url:
        raise SystemExit(json.dumps({"ok": False, "error": "screenshot_data_missing"}))
    raw = base64.b64decode(data_url.split(",", 1)[1])
    out = Path(args.out)
    if not out.is_absolute():
        out = Path.cwd() / out
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(raw)
    _print({"ok": True, "path": str(out), "bytes": len(raw), "tabId": args.tab})


def cmd_scroll(args):
    expression = (
        "(function(){window.scrollBy(0, %d);"
        "return {scrollY: Math.round(window.scrollY), scrollHeight: document.documentElement.scrollHeight};})()"
        % int(args.by)
    )
    _print({"ok": True, "tabId": args.tab, "value": eval_js(args.tab, expression)})


def cmd_click(args):
    selector = json.dumps(args.selector)
    expression = (
        "(function(){var el=document.querySelector(%s);"
        "if(!el)return {found:false};"
        "el.scrollIntoView({block:'center'});el.click();"
        "return {found:true,tag:el.tagName,text:(el.innerText||'').slice(0,80)};})()" % selector
    )
    _print({"ok": True, "tabId": args.tab, "value": eval_js(args.tab, expression)})


def cmd_close(args):
    _print(rpc("closeTab", {"tabId": int(args.tab)}, timeout_ms=15000))


def cmd_rpc(args):
    try:
        params = json.loads(args.params) if args.params else {}
    except json.JSONDecodeError as exc:
        raise SystemExit("params 不是合法 JSON: %s" % exc)
    _print(rpc(args.cmd, params, timeout_ms=args.timeout))


def main(argv=None):
    parser = argparse.ArgumentParser(description="DSH Browser Bridge 只读客户端")
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("status", help="relay 状态")
    p.set_defaults(func=cmd_status)

    p = sub.add_parser("ping", help="验证扩展响应")
    p.set_defaults(func=cmd_ping)

    p = sub.add_parser("tabs", help="列出标签页")
    p.set_defaults(func=cmd_tabs)

    p = sub.add_parser("new-tab")
    p.add_argument("url")
    p.set_defaults(func=cmd_new_tab)

    p = sub.add_parser("eval")
    p.add_argument("tab", type=int)
    p.add_argument("--js", default=None)
    p.add_argument("--file", default=None)
    p.set_defaults(func=cmd_eval)

    p = sub.add_parser("nav")
    p.add_argument("tab", type=int)
    p.add_argument("url")
    p.set_defaults(func=cmd_nav)

    p = sub.add_parser("shot")
    p.add_argument("tab", type=int)
    p.add_argument("out")
    p.set_defaults(func=cmd_shot)

    p = sub.add_parser("scroll")
    p.add_argument("tab", type=int)
    p.add_argument("--by", type=int, default=800)
    p.set_defaults(func=cmd_scroll)

    p = sub.add_parser("click")
    p.add_argument("tab", type=int)
    p.add_argument("selector")
    p.set_defaults(func=cmd_click)

    p = sub.add_parser("close")
    p.add_argument("tab", type=int)
    p.set_defaults(func=cmd_close)

    p = sub.add_parser("rpc")
    p.add_argument("cmd")
    p.add_argument("params", nargs="?", default="{}")
    p.add_argument("--timeout", type=int, default=30000)
    p.set_defaults(func=cmd_rpc)

    args = parser.parse_args(argv)
    args.func(args)
    return 0


if __name__ == "__main__":
    sys.exit(main())
