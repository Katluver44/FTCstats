// Google Analytics 4 and Cloudflare Web Analytics, each loaded only when its ID is set in
// config.js. The site is a single page, so each route change is sent to GA as its own page view;
// the Cloudflare beacon's SPA mode tracks hash routes by itself.
// Ads personalization and Google signals are off: many visitors are students.
import { CONFIG } from "./config.js";

const id = CONFIG.gaMeasurementId?.trim();
const cfToken = CONFIG.cfAnalyticsToken?.trim();

export function initAnalytics() {
  // local development visits shouldn't show up in the numbers
  if (["localhost", "127.0.0.1", "[::1]"].includes(location.hostname)) return;
  if (cfToken && /^[0-9a-f]{32}$/i.test(cfToken)) initCloudflare();
  if (!id || !/^G-[A-Z0-9]+$/.test(id)) return;
  window.dataLayer = window.dataLayer || [];
  window.gtag = function gtag() { window.dataLayer.push(arguments); };
  window.gtag("js", new Date());
  window.gtag("config", id, {
    send_page_view: false,
    allow_google_signals: false,
    allow_ad_personalization_signals: false,
  });
  // gtag.js is ~180 KB of script: fetch it only once the page has loaded and gone idle,
  // so it never competes with first paint. Calls made before then wait in dataLayer.
  const inject = () => {
    const s = document.createElement("script");
    s.async = true;
    s.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(id)}`;
    document.head.appendChild(s);
  };
  const whenIdle = () => (window.requestIdleCallback ? requestIdleCallback(inject, { timeout: 5000 }) : setTimeout(inject, 2000));
  if (document.readyState === "complete") whenIdle();
  else addEventListener("load", whenIdle, { once: true });
}

// Cloudflare's beacon is small (~6 KB) and cookieless; same lazy load so it never competes
// with first paint. "spa": true makes it report every hash-route change on its own.
function initCloudflare() {
  const inject = () => {
    const s = document.createElement("script");
    s.defer = true;
    s.src = "https://static.cloudflareinsights.com/beacon.min.js";
    s.setAttribute("data-cf-beacon", JSON.stringify({ token: cfToken, spa: true }));
    document.head.appendChild(s);
  };
  const whenIdle = () => (window.requestIdleCallback ? requestIdleCallback(inject, { timeout: 5000 }) : setTimeout(inject, 2000));
  if (document.readyState === "complete") whenIdle();
  else addEventListener("load", whenIdle, { once: true });
}

// Called by the router after every navigation. Paths look like "/2025/team/20265".
export function trackPage(path, title) {
  if (!window.gtag || !id) return;
  window.gtag("event", "page_view", {
    page_location: `${location.origin}${location.pathname}#${path}`,
    page_path: path,
    page_title: title,
  });
}
