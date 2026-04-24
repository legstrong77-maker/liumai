// 六脈 LIUMAI · Cloudflare Pages Function
// Route: /quote?code=2330,2317
// MIS snapshot convenience endpoint — tries TSE first, then OTC for misses.

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

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export async function onRequestGet({ request }) {
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
