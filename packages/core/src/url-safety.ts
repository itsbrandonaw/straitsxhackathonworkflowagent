import { isIP } from "node:net";

const blockedHostnames = new Set(["localhost", "localhost.localdomain"]);

function isPrivateIpv4(hostname: string): boolean {
  const parts = hostname.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return false;
  const [a, b] = parts as [number, number, number, number];
  return a === 10 || a === 127 || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a === 0;
}

function isPrivateIpv6(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === "::1" || normalized.startsWith("fc") ||
    normalized.startsWith("fd") || normalized.startsWith("fe80:");
}

export function assertSafePublicUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Blocked URL scheme: ${url.protocol}`);
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (blockedHostnames.has(hostname) || hostname.endsWith(".localhost")) {
    throw new Error("Blocked local hostname");
  }
  const ipVersion = isIP(hostname);
  if ((ipVersion === 4 && isPrivateIpv4(hostname)) || (ipVersion === 6 && isPrivateIpv6(hostname))) {
    throw new Error("Blocked private network address");
  }
  url.hash = "";
  return url;
}

export function canonicalizeListingUrl(value: string): string {
  const url = assertSafePublicUrl(value);
  const hostname = url.hostname.toLowerCase();
  const amazonProduct = hostname.includes("amazon.") ? url.pathname.match(/\/dp\/([a-z0-9]{8,})/i) : undefined;
  const shopeeProduct = hostname.endsWith("shopee.sg")
    ? url.pathname.match(/-i\.(\d+)\.(\d+)/i) ?? url.pathname.match(/\/product\/(\d+)\/(\d+)/i)
    : undefined;
  if (amazonProduct) {
    url.pathname = `/dp/${amazonProduct[1]!.toUpperCase()}`;
    url.search = "";
  } else if (shopeeProduct) {
    url.pathname = `/product/${shopeeProduct[1]}/${shopeeProduct[2]}`;
    url.search = "";
  } else if (hostname.endsWith("lazada.sg") && /\/products\/.+\.html$/i.test(url.pathname)) {
    url.search = "";
  }
  const removable = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "gclid", "fbclid"];
  for (const key of removable) url.searchParams.delete(key);
  url.hostname = hostname;
  if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/$/, "");
  return url.toString();
}

export function candidateDeduplicationKey(input: {
  canonicalUrl: string;
  merchant: string;
  seller: string;
  variant: string;
}): string {
  return [input.canonicalUrl, input.merchant, input.seller, input.variant]
    .map((part) => part.trim().toLowerCase())
    .join("|");
}
