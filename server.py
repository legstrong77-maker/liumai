"""
六脈 LIUMAI — 台股 AI 戰情艙 · local proxy + static server.

Why: TWSE MIS (mis.twse.com.tw) doesn't send CORS headers, so a browser
can't call it directly. This lightweight server solves it by:
  1. Serving the static site   (http://127.0.0.1:8787/)
  2. Acting as an open CORS proxy at /proxy?url=...
  3. Exposing a few convenience endpoints

No external dependencies — uses only the Python 3.8+ stdlib.

Run:  python server.py
Then: open http://127.0.0.1:8787/ in your browser
"""

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs, unquote, quote
from urllib.request import Request, urlopen
from urllib.error import URLError, HTTPError
import socketserver, os, sys, mimetypes, ssl, gzip, io, json
from pathlib import Path

ROOT = Path(__file__).parent.resolve()
PORT = int(os.environ.get("STK_PORT", "8787"))

ALLOWED_HOSTS = {
    "mis.twse.com.tw",
    "openapi.twse.com.tw",
    "www.tpex.org.tw",
    "api.finmindtrade.com",
    "news.google.com",
    "tw.stock.yahoo.com",
    "query1.finance.yahoo.com",
    "query2.finance.yahoo.com",
    "www.wantgoo.com",
    "goodinfo.tw",
    "histock.tw",
}

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")


def _ssl_ctx():
    """
    Unverified context for whitelisted public-market-data hosts.

    TWSE MIS (mis.twse.com.tw) ships a certificate with a non-standard
    extension layout that Python 3.13+ refuses to verify ("Missing Subject
    Key Identifier"). We're only talking to the hosts in ALLOWED_HOSTS —
    all public read-only market data — so skipping verification is fine
    here. No secrets are transmitted.
    """
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    return ctx


class Handler(BaseHTTPRequestHandler):
    # silence default request log spam
    def log_message(self, fmt, *args):
        if "--verbose" in sys.argv:
            sys.stderr.write("[%s] %s\n" % (self.log_date_time_string(), fmt % args))

    # --- CORS ---
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    # --- routes ---
    def do_GET(self):
        u = urlparse(self.path)

        if u.path == "/health":
            return self._json({"ok": True, "service": "stk-proxy", "port": PORT})

        if u.path == "/proxy":
            return self._proxy(u)

        if u.path == "/quote":
            return self._quote(u)

        # static files
        return self._static(u)

    # --- /proxy?url=...  (generic) ---
    def _proxy(self, u):
        q = parse_qs(u.query)
        raw = q.get("url", [""])[0]
        if not raw:
            return self._err(400, "missing url")
        target = unquote(raw)
        host = urlparse(target).hostname or ""
        if host not in ALLOWED_HOSTS:
            return self._err(403, f"host not allowed: {host}")
        # re-percent-encode any non-ASCII chars for urlopen
        target_enc = quote(target, safe=":/?&=%#+,;@[]!$'()*~")
        try:
            req = Request(target_enc, headers={
                "User-Agent": UA,
                "Accept": "*/*",
                "Accept-Language": "zh-TW,zh;q=0.9,en;q=0.8",
                "Referer": f"https://{host}/",
            })
            ctx = _ssl_ctx()
            with urlopen(req, context=ctx, timeout=10) as r:
                body = r.read()
                if r.headers.get("Content-Encoding") == "gzip":
                    body = gzip.decompress(body)
                ctype = r.headers.get("Content-Type", "application/json")
                self.send_response(200)
                self._cors()
                self.send_header("Content-Type", ctype)
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                self.wfile.write(body)
        except HTTPError as e:
            self._err(e.code, f"upstream http error: {e.reason}")
        except (URLError, socketserver.socket.timeout, TimeoutError) as e:
            self._err(502, f"upstream network error: {e}")
        except Exception as e:
            self._err(500, f"proxy crash: {e}")

    # --- /quote?code=2330,2317 (convenience: MIS snapshot) ---
    def _quote(self, u):
        q = parse_qs(u.query)
        codes_s = q.get("code", [""])[0]
        if not codes_s:
            return self._err(400, "missing code")
        codes = [c.strip() for c in codes_s.split(",") if c.strip()]
        # attempt TSE then OTC fallback
        ex_chs = "|".join([f"tse_{c}.tw" for c in codes])
        url = f"https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch={ex_chs}&json=1&delay=0"
        ctx = _ssl_ctx()
        try:
            req = Request(url, headers={"User-Agent": UA, "Referer": "https://mis.twse.com.tw/"})
            with urlopen(req, context=ctx, timeout=8) as r:
                data = json.loads(r.read().decode("utf-8"))
            found = {row.get("c") for row in (data.get("msgArray") or [])}
            missing = [c for c in codes if c not in found]
            if missing:
                ex_otc = "|".join([f"otc_{c}.tw" for c in missing])
                url2 = f"https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch={ex_otc}&json=1&delay=0"
                try:
                    req2 = Request(url2, headers={"User-Agent": UA, "Referer": "https://mis.twse.com.tw/"})
                    with urlopen(req2, context=ctx, timeout=8) as r2:
                        d2 = json.loads(r2.read().decode("utf-8"))
                        data.setdefault("msgArray", []).extend(d2.get("msgArray", []))
                except Exception:
                    pass
            return self._json(data)
        except Exception as e:
            return self._err(502, f"mis upstream failed: {e}")

    # --- static serving ---
    def _static(self, u):
        path = unquote(u.path).lstrip("/")
        if path in ("", "index", "index.html"):
            path = "index.html"
        full = (ROOT / path).resolve()
        try:
            full.relative_to(ROOT)
        except ValueError:
            return self._err(403, "path outside root")
        if not full.exists() or not full.is_file():
            return self._err(404, f"not found: {path}")
        ctype, _ = mimetypes.guess_type(str(full))
        self.send_response(200)
        self._cors()
        self.send_header("Content-Type", ctype or "application/octet-stream")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        with open(full, "rb") as f:
            self.wfile.write(f.read())

    # --- helpers ---
    def _json(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self._cors()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _err(self, code, msg):
        return self._json({"error": msg}, status=code)


class _Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def main():
    srv = _Server(("127.0.0.1", PORT), Handler)
    url = f"http://127.0.0.1:{PORT}/"
    print("============================================================")
    print("   六脈 LIUMAI · 台股 AI 戰情艙")
    print("   六識盤面 · 一劍斷勢")
    print("------------------------------------------------------------")
    print(f"   打開這個網址 ->  {url}")
    print(f"   代理端點    ->  {url}proxy?url=ENCODED_URL")
    print(f"   即時報價捷徑 ->  {url}quote?code=2330,2317")
    print("   按 Ctrl+C 關閉伺服器")
    print("============================================================")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
    finally:
        srv.server_close()


if __name__ == "__main__":
    main()
