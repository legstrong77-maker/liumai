// 六脈 LIUMAI · Cloudflare Worker (with Static Assets)
// ----------------------------------------------------
// Handles /health, /proxy, /quote as API routes and
// falls through to static assets (index.html, css, js)
// for everything else.
//
// Runs identically to server.py (local) and to the
// /functions/*.js Pages Functions version.

const ALLOWED_HOSTS = new Set([
  "mis.twse.com.tw",
  "openapi.twse.com.tw",
  "www.tpex.org.tw",
  "api.finmindtrade.com",
  "news.google.com",
  "tw.stock.yahoo.com",
  "query1.finance.yahoo.com",
  "query2.finance.yahoo.com",
]);

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0 Safari/537.36";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function jsonResp(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...CORS,
    },
  });
}

function handleHealth() {
  return jsonResp({ ok: true, service: "liumai", runtime: "cloudflare-worker" });
}

async function handleProxy(request) {
  const u = new URL(request.url);
  const raw = u.searchParams.get("url");
  if (!raw) return jsonResp({ error: "missing url" }, 400);

  let target;
  try { target = new URL(raw); } catch { return jsonResp({ error: "bad url" }, 400); }
  if (!ALLOWED_HOSTS.has(target.hostname)) {
    return jsonResp({ error: `host not allowed: ${target.hostname}` }, 403);
  }

  try {
    const upstream = await fetch(target.toString(), {
      headers: {
        "User-Agent": UA,
        "Accept": "*/*",
        "Accept-Language": "zh-TW,zh;q=0.9,en;q=0.8",
        "Referer": `https://${target.hostname}/`,
      },
      cf: { cacheTtl: 0, cacheEverything: false },
    });
    const ctype = upstream.headers.get("Content-Type") || "application/json; charset=utf-8";
    const body = await upstream.arrayBuffer();
    return new Response(body, {
      status: upstream.status,
      headers: {
        "Content-Type": ctype,
        "Cache-Control": "no-store",
        ...CORS,
      },
    });
  } catch (err) {
    return jsonResp({ error: `upstream: ${err.message || err}` }, 502);
  }
}

async function fetchMIS(exChs) {
  const url =
    "https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=" +
    encodeURIComponent(exChs.join("|")) +
    "&json=1&delay=0&_=" + Date.now();
  const r = await fetch(url, {
    headers: { "User-Agent": UA, "Referer": "https://mis.twse.com.tw/" },
    cf: { cacheTtl: 0, cacheEverything: false },
  });
  if (!r.ok) throw new Error(`MIS ${r.status}`);
  return r.json();
}

async function handleQuote(request) {
  const u = new URL(request.url);
  const codesStr = u.searchParams.get("code");
  if (!codesStr) return jsonResp({ error: "missing code" }, 400);
  const codes = codesStr.split(",").map(c => c.trim()).filter(Boolean);
  if (!codes.length) return jsonResp({ error: "empty codes" }, 400);

  try {
    const tseData = await fetchMIS(codes.map(c => `tse_${c}.tw`));
    const seen = new Set((tseData.msgArray || []).map(r => r.c));
    const missing = codes.filter(c => !seen.has(c));
    let merged = tseData.msgArray || [];
    if (missing.length) {
      try {
        const otcData = await fetchMIS(missing.map(c => `otc_${c}.tw`));
        merged = merged.concat(otcData.msgArray || []);
      } catch {}
    }
    return jsonResp({ msgArray: merged });
  } catch (err) {
    return jsonResp({ error: `mis failed: ${err.message || err}` }, 502);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    // API routes
    if (url.pathname === "/health") return handleHealth();
    if (url.pathname === "/proxy")  return handleProxy(request);
    if (url.pathname === "/quote")  return handleQuote(request);

    // Everything else → static assets (index.html, css/, js/)
    return env.ASSETS.fetch(request);
  },
};
