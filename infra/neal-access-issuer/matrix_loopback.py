#!/usr/bin/env python3
"""Narrow loopback bridge from the manual host to isolated Synapse."""

from __future__ import annotations

import http.client
import json
import threading
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote, urlsplit


SCHEMA = "neal.matrix-loopback/v1"
LISTEN_ADDRESS = "0.0.0.0"
LISTEN_PORT = 18011
MAX_BODY_BYTES = 1024 * 1024
UPSTREAM_HOST = "synapse"
UPSTREAM_PORT = 8008
UPSTREAM_TIMEOUT_SECONDS = 60
ALLOWED_METHODS = frozenset({"GET", "POST", "PUT", "DELETE", "OPTIONS"})
REQUEST_HEADERS = frozenset({"accept", "authorization", "content-type", "user-agent"})
RESPONSE_HEADERS = frozenset({"cache-control", "content-type", "etag", "retry-after"})


def route_allowed(method: str, raw_target: str) -> bool:
    if method not in ALLOWED_METHODS:
        return False
    target = urlsplit(raw_target)
    if target.scheme or target.netloc or target.fragment:
        return False
    try:
        decoded_path = unquote(target.path, errors="strict")
    except UnicodeDecodeError:
        return False
    if "\\" in decoded_path or "\0" in decoded_path or any(
        segment in {".", ".."} for segment in decoded_path.split("/")
    ):
        return False
    return decoded_path.startswith("/_matrix/") or decoded_path == "/_synapse/admin/v1/register"


def filtered_headers(headers, allowed: frozenset[str]) -> dict[str, str]:
    return {
        name: value
        for name, value in headers.items()
        if name.lower() in allowed and "\r" not in value and "\n" not in value
    }


class MatrixLoopbackHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "neal-matrix-loopback"
    sys_version = ""

    def log_message(self, _format: str, *_arguments) -> None:
        return

    def _send_json(self, status: int, value: dict[str, str]) -> None:
        body = json.dumps(value, separators=(",", ":")).encode("ascii") + b"\n"
        self.send_response(status)
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(body)

    def _body(self) -> bytes:
        if self.headers.get("Transfer-Encoding"):
            raise ValueError("chunked request bodies are unsupported")
        raw_length = self.headers.get("Content-Length", "0")
        try:
            length = int(raw_length)
        except ValueError as error:
            raise ValueError("invalid content length") from error
        if length < 0 or length > MAX_BODY_BYTES:
            raise OverflowError("request body is too large")
        return self.rfile.read(length) if length else b""

    def _health(self) -> None:
        connection = http.client.HTTPConnection(UPSTREAM_HOST, UPSTREAM_PORT, timeout=5)
        try:
            connection.request("GET", "/_matrix/client/versions", headers={"Accept": "application/json"})
            response = connection.getresponse()
            response.read(MAX_BODY_BYTES + 1)
            if response.status != HTTPStatus.OK:
                raise RuntimeError("Synapse is unavailable")
        finally:
            connection.close()
        self._send_json(HTTPStatus.OK, {"schema": SCHEMA, "status": "healthy"})

    def _proxy(self) -> None:
        if self.path == "/healthz" and self.command == "GET":
            try:
                self._health()
            except Exception:
                self._send_json(HTTPStatus.SERVICE_UNAVAILABLE, {"schema": SCHEMA, "status": "unavailable"})
            return
        if not route_allowed(self.command, self.path):
            self._send_json(HTTPStatus.NOT_FOUND, {"schema": SCHEMA, "status": "denied"})
            return
        try:
            body = self._body()
        except OverflowError:
            self._send_json(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, {"schema": SCHEMA, "status": "denied"})
            return
        except ValueError:
            self._send_json(HTTPStatus.BAD_REQUEST, {"schema": SCHEMA, "status": "denied"})
            return
        headers = filtered_headers(self.headers, REQUEST_HEADERS)
        headers["Host"] = f"{UPSTREAM_HOST}:{UPSTREAM_PORT}"
        headers["Connection"] = "close"
        if body:
            headers["Content-Length"] = str(len(body))
        connection = http.client.HTTPConnection(UPSTREAM_HOST, UPSTREAM_PORT, timeout=UPSTREAM_TIMEOUT_SECONDS)
        response_started = False
        try:
            connection.request(self.command, self.path, body=body or None, headers=headers)
            upstream = connection.getresponse()
            response_body = upstream.read(MAX_BODY_BYTES + 1)
            if len(response_body) > MAX_BODY_BYTES:
                raise OverflowError("upstream response is too large")
            response_headers = filtered_headers(upstream.headers, RESPONSE_HEADERS)
            response_started = True
            self.send_response(upstream.status)
            for name, value in response_headers.items():
                self.send_header(name, value)
            self.send_header("Content-Length", str(len(response_body)))
            self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.write(response_body)
        except Exception:
            if not response_started and not self.wfile.closed:
                self._send_json(HTTPStatus.BAD_GATEWAY, {"schema": SCHEMA, "status": "unavailable"})
            else:
                self.close_connection = True
        finally:
            connection.close()

    do_GET = _proxy
    do_POST = _proxy
    do_PUT = _proxy
    do_DELETE = _proxy
    do_OPTIONS = _proxy


class BoundedThreadingHTTPServer(ThreadingHTTPServer):
    daemon_threads = True
    request_queue_size = 32

    def __init__(self, *args, **kwargs):
        self._worker_slots = threading.BoundedSemaphore(32)
        super().__init__(*args, **kwargs)

    def process_request(self, request, client_address) -> None:
        self._worker_slots.acquire()
        try:
            super().process_request(request, client_address)
        except Exception:
            self._worker_slots.release()
            raise

    def process_request_thread(self, request, client_address) -> None:
        try:
            super().process_request_thread(request, client_address)
        finally:
            self._worker_slots.release()


def main() -> None:
    server = BoundedThreadingHTTPServer((LISTEN_ADDRESS, LISTEN_PORT), MatrixLoopbackHandler)
    server.serve_forever(poll_interval=0.25)


if __name__ == "__main__":
    main()
