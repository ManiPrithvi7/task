#!/usr/bin/env python3
"""Serve OTA firmware with required X-Firmware-Version header."""
import os
import socket
import sys
from http.server import HTTPServer, SimpleHTTPRequestHandler

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
ARTIFACT_DIR = os.environ.get("OTA_ARTIFACT_DIR", os.path.join(SCRIPT_DIR, "artifacts"))
FIRMWARE_FILE = os.environ.get("OTA_FIRMWARE_FILE", "firmware-target.bin")
VERSION = os.environ.get("OTA_FIRMWARE_VERSION", "4.3.1-mvp")
PORT = int(os.environ.get("OTA_FIRMWARE_PORT", "8765"))


class ReuseHTTPServer(HTTPServer):
    allow_reuse_address = True


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ARTIFACT_DIR, **kwargs)

    def end_headers(self):
        if self.path.endswith(FIRMWARE_FILE):
            self.send_header("X-Firmware-Version", VERSION)
            self.send_header("Content-Type", "application/octet-stream")
        super().end_headers()


def port_in_use(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            s.bind(("0.0.0.0", port))
            return False
        except OSError:
            return True


if __name__ == "__main__":
    os.makedirs(ARTIFACT_DIR, exist_ok=True)
    bin_path = os.path.join(ARTIFACT_DIR, FIRMWARE_FILE)
    if not os.path.isfile(bin_path):
        print(f"Missing firmware: {bin_path}", file=sys.stderr)
        print("Build target firmware first — see OTA_E2E_TEST.md §4", file=sys.stderr)
        sys.exit(1)
    if port_in_use(PORT):
        print(f"Port {PORT} already in use — firmware server likely running.")
        sys.exit(0)
    print(f"Serving {ARTIFACT_DIR} on 0.0.0.0:{PORT}")
    print(f"  file={FIRMWARE_FILE}  X-Firmware-Version={VERSION}")
    ReuseHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
