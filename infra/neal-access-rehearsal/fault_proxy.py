#!/usr/bin/env python3
"""Loopback Matrix proxy that rejects exactly one armed admin deactivation."""

from __future__ import annotations

import argparse
import json
import threading
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class State:
    def __init__(self) -> None:
        self.armed = False
        self.lock = threading.Lock()

    def arm(self) -> None:
        with self.lock:
            self.armed = True

    def consume(self) -> bool:
        with self.lock:
            if not self.armed:
                return False
            self.armed = False
            return True


class Handler(BaseHTTPRequestHandler):
    state = State()
    target = "http://127.0.0.1:18008"

    def log_message(self, _format: str, *_args: object) -> None:
        return

    def body(self) -> bytes:
        length = int(self.headers.get("Content-Length", "0"))
        if length > 128 * 1024:
            raise ValueError("request body too large")
        return self.rfile.read(length)

    def json_response(self, status: int, value: dict[str, object]) -> None:
        payload = json.dumps(value, separators=(",", ":")).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def proxy(self) -> None:
        if self.path == "/__fault/arm" and self.command == "POST":
            self.state.arm()
            self.json_response(200, {"armed": True})
            return
        if (
            self.command == "POST"
            and self.path.startswith("/_synapse/admin/v1/deactivate/")
            and self.state.consume()
        ):
            self.json_response(503, {"errcode": "M_REHEARSAL_FAULT", "error": "injected cleanup failure"})
            return
        try:
            body = self.body()
        except ValueError:
            self.json_response(413, {"error": "request too large"})
            return
        headers = {
            key: value
            for key, value in self.headers.items()
            if key.lower() not in {"host", "content-length", "connection", "transfer-encoding"}
        }
        request = urllib.request.Request(
            self.target + self.path,
            data=body if body else None,
            headers=headers,
            method=self.command,
        )
        try:
            with urllib.request.urlopen(request, timeout=20) as response:
                status, response_headers, payload = response.status, response.headers, response.read()
        except urllib.error.HTTPError as error:
            status, response_headers, payload = error.code, error.headers, error.read()
        except OSError:
            self.json_response(502, {"error": "upstream unavailable"})
            return
        self.send_response(status)
        for key, value in response_headers.items():
            if key.lower() not in {"connection", "transfer-encoding", "content-length"}:
                self.send_header(key, value)
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    do_GET = proxy
    do_POST = proxy
    do_PUT = proxy
    do_DELETE = proxy


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bind", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=18010)
    parser.add_argument("--target", default="http://127.0.0.1:18008")
    options = parser.parse_args()
    if options.bind not in {"127.0.0.1", "::1"}:
        parser.error("--bind must be loopback")
    Handler.target = options.target.rstrip("/")
    ThreadingHTTPServer((options.bind, options.port), Handler).serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
