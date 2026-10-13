# Local dev server for site/: like `python3 -m http.server`, but tells the
# browser not to cache, so edits show up on a normal reload.
#   python3 scripts/serve.py [port]
import functools, http.server, sys

class NoCache(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

port = int(sys.argv[1]) if len(sys.argv) > 1 else 5173
handler = functools.partial(NoCache, directory="site")
http.server.ThreadingHTTPServer(("", port), handler).serve_forever()
