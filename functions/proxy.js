// 六脈 LIUMAI · Cloudflare Pages Function
// Route: /proxy?url=<ENCODED_URL>
// Whitelisted public market-data hosts only. No auth, no cookies.

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

const CORS_HEADERS = {
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
      ...CORS_HEADERS,
    },
  });
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export async function onRequestGet({ request }) {
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
        ...CORS_HEADERS,
      },
    });
  } catch (err) {
    return jsonResp({ error: `upstream error: ${err.message || err}` }, 502);
  }
}
