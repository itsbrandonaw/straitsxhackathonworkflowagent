import { createServer } from "node:http";
import { LocalPlaywrightBrowserSessions } from "./local-playwright.js";
import { assertSafePublicUrl } from "@happy/core";

const query = process.env.SMOKE_PRODUCT_QUERY ?? "wireless mechanical keyboard";
const targetSite = process.env.SMOKE_TARGET_SITE ?? "shopee.sg";
const targetLabel = process.env.SMOKE_TARGET_LABEL ?? "Shopee";
const targetUrl = process.env.SMOKE_TARGET_URL ?? `https://shopee.sg/search?keyword=${encodeURIComponent(query)}`;
const port = Number(process.env.LOCAL_SMOKE_VIEWER_PORT ?? "3002");
const holdMs = Number(process.env.LOCAL_SMOKE_HOLD_MS ?? "60000");
const targetSettleMs = Number(process.env.LOCAL_SMOKE_TARGET_SETTLE_MS ?? "5000");
let latest: Uint8Array | undefined;
let stage = "Starting Chromium";
let currentUrl = "about:blank";
let liveCapture: ReturnType<typeof setInterval> | undefined;

const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;"
})[character]!);

const server = createServer((request, response) => {
  if (request.url === "/state") {
    response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(JSON.stringify({ stage, url: currentUrl }));
    return;
  }
  if (request.url?.startsWith("/snapshot")) {
    if (!latest) {
      response.writeHead(404).end("No snapshot yet");
      return;
    }
    response.writeHead(200, { "content-type": "image/jpeg", "cache-control": "no-store" });
    response.end(Buffer.from(latest));
    return;
  }
  response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  response.end(`<!doctype html><html><head><meta charset="utf-8"><title>Happy local browser smoke</title><style>body{font-family:system-ui;background:#eef2ed;color:#14221d;margin:0;padding:24px}main{max-width:1100px;margin:auto}img{width:100%;border:1px solid #ccd6cf;border-radius:12px;background:white}.meta{display:flex;gap:12px;margin-bottom:12px}.pill{background:white;padding:8px 12px;border-radius:999px}</style></head><body><main><h1>Happy local browser smoke test</h1><div class="meta"><span class="pill" id="stage">${escapeHtml(stage)}</span><span class="pill" id="url">${escapeHtml(currentUrl)}</span></div><img id="shot" alt="Current Chromium view"></main><script>setInterval(async()=>{document.getElementById('shot').src='/snapshot?t='+Date.now();const state=await fetch('/state').then(r=>r.json()).catch(()=>null);if(state){document.getElementById('stage').textContent=state.stage;document.getElementById('url').textContent=state.url}},1000)</script></body></html>`);
});

await new Promise<void>((resolve, reject) => {
  server.once("error", reject);
  server.listen(port, "127.0.0.1", resolve);
});

const sessions = new LocalPlaywrightBrowserSessions({ headless: process.env.LOCAL_BROWSER_HEADLESS !== "false" });
const session = await sessions.start({ activityId: "smoke", itemId: "smoke", scoutId: "smoke", locale: "en-SG" });
const capture = async (nextStage: string) => {
  stage = nextStage;
  currentUrl = await session.page.url();
  latest = await session.page.screenshot();
  console.log(`${stage}: ${currentUrl}`);
};

const cleanup = async () => {
  clearInterval(liveCapture);
  await sessions.stop(session).catch(() => undefined);
  await sessions.close().catch(() => undefined);
  await new Promise<void>((resolve) => server.close(() => resolve()));
};
process.once("SIGINT", () => void cleanup().finally(() => process.exit(0)));
process.once("SIGTERM", () => void cleanup().finally(() => process.exit(0)));

try {
  console.log(`Local browser viewer: http://127.0.0.1:${port}`);
  await session.page.goto(assertSafePublicUrl("https://www.google.com/").toString());
  await capture("Opened Google");
  await session.page.goto(assertSafePublicUrl(`https://www.google.com/search?q=${encodeURIComponent(`${query} site:${targetSite}`)}`).toString());
  await capture(`Searched Google for ${targetLabel}`);
  await session.page.goto(assertSafePublicUrl(targetUrl).toString());
  await new Promise((resolve) => setTimeout(resolve, targetSettleMs));
  await capture(`Opened ${targetLabel}`);
  liveCapture = setInterval(() => {
    void Promise.all([session.page.url(), session.page.screenshot()]).then(([url, screenshot]) => {
      currentUrl = url;
      latest = screenshot;
    }).catch(() => undefined);
  }, 2_000);
  console.log(`Keeping the viewer open for ${Math.round(holdMs / 1000)} seconds. Press Ctrl+C to stop early.`);
  await new Promise((resolve) => setTimeout(resolve, holdMs));
} catch (error) {
  stage = `Navigation stopped: ${error instanceof Error ? error.message : String(error)}`;
  console.error(stage);
  await new Promise((resolve) => setTimeout(resolve, Math.min(holdMs, 15_000)));
} finally {
  await cleanup();
}
