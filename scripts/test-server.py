#!/usr/bin/env python3
"""Serve the repo for test/run.html and wait for the page to POST its report.

Prints the report, then exits 0 if the suite passed, 1 if it failed and 2 if no
report arrived in time. scripts/test.sh runs this alongside headless Brave.
"""
import argparse
import http.server
import os
import sys
import threading


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--timeout", type=float, default=60)
    args = parser.parse_args()

    os.chdir(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
    received = {}

    class Handler(http.server.SimpleHTTPRequestHandler):
        def do_POST(self):
            if self.path != "/report":
                self.send_error(404)
                return
            length = int(self.headers.get("Content-Length", 0))
            received["report"] = self.rfile.read(length).decode("utf-8")
            self.send_response(204)
            self.end_headers()
            threading.Thread(target=server.shutdown).start()

        def log_message(self, *args):
            pass

    server = http.server.ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    timer = threading.Timer(args.timeout, server.shutdown)
    timer.start()
    server.serve_forever()
    timer.cancel()

    report = received.get("report")
    if report is None:
        print(f"No report from the test page within {args.timeout:.0f}s.", file=sys.stderr)
        return 2
    print(report)
    return 0 if "ALL PASSED" in report else 1


if __name__ == "__main__":
    sys.exit(main())
