// 六脈 LIUMAI · Cloudflare Pages Function
// Route: /health
export async function onRequestGet() {
  return new Response(
    JSON.stringify({ ok: true, service: "liumai-proxy", runtime: "cf-pages-functions" }),
    { headers: { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" } }
  );
}
