"""Sample backend pass-through for ceres-client.js (Python 3.10+, standard library only). PoC — the same behaviour as
proxy/node/server.mjs: /ceres/* → Ceres with the API key added here (only /health, /v1/info, /v1/ask, /v1/profiles), /* → the example pages
and the library, so pages and API share one origin (no CORS). In a real app, the /ceres route goes into your existing backend
(FastAPI, Django, Flask …), behind your login.

    CERES_URL=http://127.0.0.1:8300 CERES_API_KEY_FILE=/path/to/ceres-api-key python3 proxy/python/server.py   (port 8321)
"""
import http.client
import json
import mimetypes
import os
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CERES_URL = os.environ.get("CERES_URL", "http://127.0.0.1:8300").rstrip("/")
KEY = os.environ.get("CERES_API_KEY") or (Path(os.environ["CERES_API_KEY_FILE"]).read_text().strip() if os.environ.get("CERES_API_KEY_FILE") else "")
MAX_BODY = 65536  # bytes of request body (the same cap as Ceres)
UPSTREAM_TIMEOUT = float(os.environ.get("UPSTREAM_TIMEOUT_S", "300"))
PORT = int(os.environ.get("PORT", "8321"))
HOST = os.environ.get("HOST", "127.0.0.1")
ALLOWED = {("GET", "/health"), ("GET", "/v1/info"), ("GET", "/v1/profiles"), ("POST", "/v1/ask")}
mimetypes.add_type("text/javascript", ".js")
# Static files come only from these directories. A request is served only when its real path (after decoding,
# normalisation and symlink resolution) lies inside one of them; anything else is a 404.
SERVED = [(ROOT / d).resolve() for d in ("examples", "src")]


def resolve_served(path: str) -> Path | None:
    """The real file a request path names, or None when it is missing or lies outside SERVED."""
    rel = urllib.parse.unquote("/examples/index.html" if path == "/" else path)
    try:
        target = Path(os.path.realpath(ROOT / rel.lstrip("/")))
        if target.is_dir():
            target = Path(os.path.realpath(target / "index.html"))
        if not any(target == d or d in target.parents for d in SERVED) or not target.is_file():
            return None
    except (ValueError, OSError):
        return None
    return target


class Handler(BaseHTTPRequestHandler):
    def _send(self, status: int, body: bytes, ctype: str = "application/json") -> None:
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _fail(self, status: int, detail: str) -> None:
        self._send(status, json.dumps({"detail": detail}).encode())

    def _pass_through(self, path: str) -> None:
        if (self.command, path) not in ALLOWED:
            return self._send(404, b"")
        # The body cap is enforced on the declared length, before anything is read. A chunked body has no length to check, so it
        # is refused rather than read without a bound.
        if "Transfer-Encoding" in self.headers:
            return self._fail(411, "chunked request bodies are not accepted; send a Content-Length")
        declared = (self.headers.get("Content-Length") or "0").strip()
        if not (declared.isascii() and declared.isdigit()):
            return self._fail(400, "invalid Content-Length")
        if int(declared) > MAX_BODY:
            return self._fail(413, f"request body exceeds {MAX_BODY} bytes")
        data = self.rfile.read(int(declared)) if self.command == "POST" else None
        headers = {"Content-Type": "application/json", **({"X-API-Key": KEY} if KEY else {})}
        # This sample does not authenticate users. A real backend must verify the user's session or token here
        # (self.headers["Authorization"]) before forwarding.
        req = urllib.request.Request(CERES_URL + path, data=data, headers=headers, method=self.command)
        try:
            try:
                with urllib.request.urlopen(req, timeout=UPSTREAM_TIMEOUT) as r:
                    status, body, ctype = r.status, r.read(), r.headers.get("Content-Type", "application/json")
            except urllib.error.HTTPError as e:
                status, body, ctype = e.code, e.read(), e.headers.get("Content-Type", "application/json")
        except (TimeoutError, urllib.error.URLError, http.client.HTTPException, OSError) as e:
            timed_out = isinstance(e, TimeoutError) or (isinstance(e, urllib.error.URLError) and isinstance(e.reason, TimeoutError))
            if timed_out:
                return self._fail(504, "upstream_timeout")  # gave up waiting for Ceres
            return self._fail(502, "upstream_unreachable")  # could not reach Ceres, or it hung up
        self._send(status, body, ctype)

    def _file(self, path: str) -> None:
        target = resolve_served(path)
        if target is None:
            return self._send(404, b"")
        self._send(200, target.read_bytes(), mimetypes.guess_type(target.name)[0] or "application/octet-stream")

    def _route(self) -> None:
        path = self.path.split("?", 1)[0]
        if path.startswith("/ceres/"):
            return self._pass_through(path[len("/ceres"):])
        return self._file(path)

    do_GET = do_POST = _route


if __name__ == "__main__":
    print(f"ceres-client demo on http://{HOST}:{PORT}  →  Ceres {CERES_URL}" + ("" if KEY else "  (no key: Ceres must run with --no-auth)"))
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
