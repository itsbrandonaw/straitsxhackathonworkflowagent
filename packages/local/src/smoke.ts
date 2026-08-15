import { createServer } from "node:http";
import { LocalPlaywrightBrowserSessions } from "./local-playwright.js";
import { assertSafePublicUrl } from "@happy/core";

const query = process.env.SMOKE_PRODUCT_QUERY ?? "wireless mechanical keyboard";
const startLabel = process.env.SMOKE_START_LABEL ?? "Google";
const startUrl = process.env.SMOKE_START_URL ?? "https://www.google.com/";
const targetSite = process.env.SMOKE_TARGET_SITE ?? "shopee.sg";
const targetLabel = process.env.SMOKE_TARGET_LABEL ?? "Shopee";
const targetUrl = process.env.SMOKE_TARGET_URL ?? `https://shopee.sg/search?keyword=${encodeURIComponent(query)}`;
const directRoute = process.env.LOCAL_SMOKE_DIRECT_ROUTE === "true";
const routeUrls = (process.env.SMOKE_ROUTE_URLS ?? "").split("|").map((value) => value.trim()).filter(Boolean);
const routeLabels = (process.env.SMOKE_ROUTE_LABELS ?? "").split("|").map((value) => value.trim());
const port = Number(process.env.LOCAL_SMOKE_VIEWER_PORT ?? "3002");
const holdMs = Number(process.env.LOCAL_SMOKE_HOLD_MS ?? "60000");
const targetSettleMs = Number(process.env.LOCAL_SMOKE_TARGET_SETTLE_MS ?? "5000");
const routeStepMs = Number(process.env.LOCAL_SMOKE_ROUTE_STEP_MS ?? "5000");
const frameIntervalMs = Number(process.env.LOCAL_SMOKE_FRAME_INTERVAL_MS ?? "400");
let latest: Uint8Array | undefined;
let stage = "Starting Chromium";
let currentUrl = "about:blank";
let frameSequence = 0;
let captureBusy = false;
let liveCapture: ReturnType<typeof setInterval> | undefined;

const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;"
})[character]!);

const trafficBlocked = (url: string, text: string): boolean =>
  url.includes("/verify/traffic/") || url.includes("/sorry/") ||
  ["captcha", "automated traffic", "verify you are human", "page unavailable"]
    .some((value) => text.toLowerCase().includes(value));

const server = createServer((request, response) => {
  if (request.url === "/state") {
    response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(JSON.stringify({ stage, url: currentUrl, frameSequence }));
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
  response.end(`<!doctype html><html><head><meta charset="utf-8"><title>Happy local browser smoke</title><style>body{font-family:system-ui;background:#eef2ed;color:#14221d;margin:0;padding:24px}main{max-width:1100px;margin:auto}.meta{display:flex;gap:12px;margin-bottom:12px;flex-wrap:wrap}.pill{background:white;padding:8px 12px;border-radius:999px}.viewer{position:relative;aspect-ratio:16/9;overflow:hidden;border:1px solid #ccd6cf;border-radius:12px;background:white}.viewer img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;opacity:0;transition:opacity 180ms ease}.viewer img.active{opacity:1}</style></head><body><main><h1>Happy local browser smoke test</h1><div class="meta"><span class="pill" id="stage">${escapeHtml(stage)}</span><span class="pill" id="url">${escapeHtml(currentUrl)}</span><span class="pill" id="feed">Connecting</span></div><div class="viewer"><img id="frame-a" alt="Current Chromium view"><img id="frame-b" alt="Current Chromium view"></div></main><script>const images=[document.getElementById('frame-a'),document.getElementById('frame-b')];const urls=[null,null];let active=-1;let seen=-1;function show(blob){const next=active===0?1:0;const previous=active;if(urls[next])URL.revokeObjectURL(urls[next]);const url=URL.createObjectURL(blob);urls[next]=url;images[next].onload=()=>{images[next].classList.add('active');if(previous>=0){images[previous].classList.remove('active');const old=urls[previous];setTimeout(()=>{if(urls[previous]===old){URL.revokeObjectURL(old);urls[previous]=null}},220)}active=next};images[next].src=url}async function refresh(){const state=await fetch('/state').then(r=>r.json()).catch(()=>null);if(!state)return;document.getElementById('stage').textContent=state.stage;document.getElementById('url').textContent=state.url;if(state.frameSequence!==seen){seen=state.frameSequence;const response=await fetch('/snapshot?t='+seen);if(response.ok){show(await response.blob());document.getElementById('feed').textContent='Live'}}}setInterval(refresh,200);refresh();addEventListener('beforeunload',()=>urls.forEach(url=>url&&URL.revokeObjectURL(url)))</script></body></html>`);
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
  frameSequence += 1;
  console.log(`${stage}: ${currentUrl}`);
};

const navigatePublic = async (value: string): Promise<boolean> => {
  const safeUrl = assertSafePublicUrl(value).toString();
  try {
    await session.page.goto(safeUrl);
    return false;
  } catch (error) {
    const loadedUrl = await session.page.url();
    if (error instanceof Error && error.message.includes("Timeout") && loadedUrl !== "about:blank") {
      assertSafePublicUrl(loadedUrl);
      return true;
    }
    throw error;
  }
};

const visit = async (label: string, value: string, nextLabel?: string): Promise<void> => {
  const timedOut = await navigatePublic(value);
  await new Promise((resolve) => setTimeout(resolve, targetSettleMs));
  const loadedUrl = await session.page.url();
  const pageText = await session.page.text(2_000);
  await capture(timedOut
    ? `${label} navigation timed out; showing current page`
    : trafficBlocked(loadedUrl, pageText)
    ? `${label} blocked automated traffic${nextLabel ? `; continuing to ${nextLabel}` : ""}`
    : `Opened ${label}`);
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
  if (routeUrls.length > 0) {
    for (const [index, url] of routeUrls.entries()) {
      const label = routeLabels[index] || new URL(assertSafePublicUrl(url)).hostname;
      const nextUrl = routeUrls[index + 1];
      const nextLabel = nextUrl
        ? routeLabels[index + 1] || new URL(assertSafePublicUrl(nextUrl)).hostname
        : undefined;
      await visit(label, url, nextLabel);
      if (nextUrl) await new Promise((resolve) => setTimeout(resolve, routeStepMs));
    }
  } else {
    await visit(startLabel, startUrl, targetLabel);
    if (!directRoute) {
    const googleTimedOut = await navigatePublic(`https://www.google.com/search?q=${encodeURIComponent(`${query} site:${targetSite}`)}`);
    const googleUrl = await session.page.url();
    const googleText = await session.page.text(2_000);
    await capture(googleTimedOut
      ? `Google search navigation timed out; opening ${targetLabel} directly`
      : trafficBlocked(googleUrl, googleText)
      ? `Google blocked automated traffic; opening ${targetLabel} directly`
      : `Searched Google for ${targetLabel}`);
    }
    await visit(targetLabel, targetUrl);
  }
  liveCapture = setInterval(() => {
    if (captureBusy) return;
    captureBusy = true;
    void Promise.all([session.page.url(), session.page.screenshot()]).then(([url, screenshot]) => {
      currentUrl = url;
      latest = screenshot;
      frameSequence += 1;
    }).catch(() => undefined).finally(() => { captureBusy = false; });
  }, frameIntervalMs);
  console.log(`Keeping the viewer open for ${Math.round(holdMs / 1000)} seconds. Press Ctrl+C to stop early.`);
  await new Promise((resolve) => setTimeout(resolve, holdMs));
} catch (error) {
  stage = `Navigation stopped: ${error instanceof Error ? error.message : String(error)}`;
  console.error(stage);
  await new Promise((resolve) => setTimeout(resolve, Math.min(holdMs, 15_000)));
} finally {
  await cleanup();
}
