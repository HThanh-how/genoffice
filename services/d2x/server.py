"""Small, bounded HTTP gateway for LibreOffice's DOC to DOCX converter.

Run behind a Cloudflare Tunnel or another trusted reverse proxy. The converter
itself never listens on a public interface and uploaded documents are only
kept in an isolated temporary directory for the duration of the request.
"""

from collections import defaultdict, deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import threading
import time


HOST = os.environ.get("D2X_HOST", "127.0.0.1")
PORT = int(os.environ.get("D2X_PORT", "8765"))
MAX_INPUT = int(os.environ.get("D2X_MAX_INPUT", str(20 * 1024 * 1024)))
MAX_OUTPUT = int(os.environ.get("D2X_MAX_OUTPUT", str(50 * 1024 * 1024)))
TIMEOUT = int(os.environ.get("D2X_TIMEOUT", "45"))
HOURLY_LIMIT = int(os.environ.get("D2X_HOURLY_LIMIT", "30"))
GLOBAL_HOURLY_LIMIT = int(os.environ.get("D2X_GLOBAL_HOURLY_LIMIT", "120"))
CONVERTER = os.environ.get("D2X_SOFFICE", "/usr/bin/soffice")

_rate_lock = threading.Lock()
_requests = defaultdict(deque)
_global_calls = deque()
_conversion_slot = threading.BoundedSemaphore(1)


def allowed(key: str) -> bool:
    now = time.monotonic()
    with _rate_lock:
        while _global_calls and _global_calls[0] <= now - 3600:
            _global_calls.popleft()
        if len(_global_calls) >= GLOBAL_HOURLY_LIMIT:
            return False
        if len(_requests) > 4096:
            for old_key in list(_requests):
                if not _requests[old_key] or _requests[old_key][-1] <= now - 3600:
                    del _requests[old_key]
        calls = _requests[key]
        while calls and calls[0] <= now - 3600:
            calls.popleft()
        if len(calls) >= HOURLY_LIMIT:
            return False
        calls.append(now)
        _global_calls.append(now)
        return True


class Handler(BaseHTTPRequestHandler):
    server_version = "GenOffice-D2X/1"
    sys_version = ""

    def setup(self) -> None:
        super().setup()
        self.connection.settimeout(30)

    def send(self, status: int, body: bytes, content_type: str = "text/plain") -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        if self.path != "/health":
            self.send(404, b"Not found")
            return
        if not Path(CONVERTER).is_file():
            self.send(503, b"Converter unavailable")
            return
        self.send(200, b"ok")

    def do_POST(self) -> None:
        if self.path != "/v1/convert/docx":
            self.send(404, b"Not found")
            return
        try:
            size = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            size = 0
        if size < 1 or size > MAX_INPUT:
            self.send(413, b"Document is empty or too large")
            return
        if self.headers.get("Content-Type", "").split(";", 1)[0] != "application/msword":
            self.send(415, b"Only legacy .doc files are accepted")
            return
        # CF-Connecting-IP is overwritten by Cloudflare; the listener is bound
        # to loopback, so only the local tunnel or trusted local processes reach it.
        ip = self.headers.get("CF-Connecting-IP") or self.client_address[0]
        if not allowed(ip):
            self.send(429, b"Hourly conversion limit reached")
            return
        if not _conversion_slot.acquire(blocking=False):
            self.send(503, b"Converter busy; retry shortly")
            return
        try:
            source = self.rfile.read(size)
            if len(source) != size or not source.startswith(b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1"):
                self.send(422, b"Invalid legacy .doc file")
                return
            with tempfile.TemporaryDirectory(prefix="genoffice-d2x-") as directory:
                root = Path(directory)
                input_path = root / "input.doc"
                output_path = root / "input.docx"
                input_path.write_bytes(source)
                try:
                    result = subprocess.run(
                        [
                            CONVERTER,
                            f"-env:UserInstallation={(root / 'profile').as_uri()}",
                            "--headless",
                            "--convert-to",
                            "docx:Office Open XML Text",
                            "--outdir",
                            directory,
                            str(input_path),
                        ],
                        stdin=subprocess.DEVNULL,
                        stdout=subprocess.PIPE,
                        stderr=subprocess.PIPE,
                        timeout=TIMEOUT,
                        check=False,
                    )
                except subprocess.TimeoutExpired:
                    self.send(504, b"Conversion timed out")
                    return
                if result.returncode or not output_path.is_file():
                    self.send(422, b"Could not convert this document")
                    return
                if output_path.stat().st_size > MAX_OUTPUT:
                    self.send(413, b"Converted document is too large")
                    return
                converted = output_path.read_bytes()
                if not converted.startswith(b"PK"):
                    self.send(502, b"Converter returned an invalid DOCX")
                    return
                self.send(200, converted, "application/vnd.openxmlformats-officedocument.wordprocessingml.document")
        finally:
            _conversion_slot.release()

    def log_message(self, format: str, *args: object) -> None:
        # Never log filenames or document contents. The path and status suffice.
        print(f"{self.address_string()} {format % args}", flush=True)


def main() -> None:
    if not shutil.which(CONVERTER):
        raise SystemExit(f"Converter missing: {CONVERTER}")
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    server.daemon_threads = True
    server.serve_forever()


if __name__ == "__main__":
    main()
