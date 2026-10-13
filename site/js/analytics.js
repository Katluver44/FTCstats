// Google Analytics 4, loaded only when a measurement ID is set in config.js.
// The site is a single page, so each route change is sent as its own page view.
// Ads personalization and Google signals are off: many visitors are students.
import { CONFIG } from "./config.js";

const id = CONFIG.gaMeasurementId?.trim();

export function initAnalytics() {
  if (!id || !/^G-[A-Z0-9]+$/.test(id)) return;
  window.dataLayer = window.dataLayer || [];
  window.gtag = function gtag() { window.dataLayer.push(arguments); };
  window.gtag("js", new Date());
  window.gtag("config", id, {
    send_page_view: false,
    allow_google_signals: false,
    allow_ad_personalization_signals: false,
  });
  const s = document.createElement("script");
  s.async = true;
  s.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(id)}`;
  document.head.appendChild(s);
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
