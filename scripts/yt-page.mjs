// Video details from YouTube's own player data, for when the Data API quota is used up.
// Returns the same shape as a Data API `videos` item (snippet, liveStreamingDetails,
// contentDetails, status), or null for a private / deleted video. Throws { blocked: true }
// when YouTube asks us to sign in (too many requests): stop and try later, don't push on.

const UA = { "Content-Type": "application/json", "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126 Safari/537.36" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function pageDetails(id) {
  const r = await fetch("https://www.youtube.com/youtubei/v1/player?prettyPrint=false", { method: "POST", headers: UA,
    body: JSON.stringify({ context: { client: { clientName: "WEB", clientVersion: "2.20240726.00.00", hl: "en", gl: "US" } }, videoId: id }) })
    .then((x) => x.json()).catch(() => null);
  const st = r?.playabilityStatus?.status;
  if (!r || st === "LOGIN_REQUIRED" && !r.videoDetails) throw Object.assign(new Error("YouTube wants a sign-in (rate limited)"), { blocked: true });
  const d = r.videoDetails, mf = r.microformat?.playerMicroformatRenderer;
  if (!d || !mf) return null;
  const live = mf.liveBroadcastDetails;
  const countries = mf.availableCountries;
  return {
    id,
    snippet: { title: d.title, description: d.shortDescription ?? "", channelId: d.channelId, publishedAt: new Date(mf.publishDate ?? mf.uploadDate).toISOString() },
    liveStreamingDetails: live?.startTimestamp ? { actualStartTime: live.startTimestamp, ...(live.endTimestamp ? { actualEndTime: live.endTimestamp } : {}) } : undefined,
    contentDetails: { duration: `PT${+d.lengthSeconds || 0}S`, ...(countries?.length && !countries.includes("US") ? { regionRestriction: { allowed: countries } } : {}) },
    status: { embeddable: r.playabilityStatus?.playableInEmbed !== false },
  };
}

// many ids, politely; stops at the first block and returns what it has
export async function pageDetailsMany(ids, { gap = 700, log = () => {} } = {}) {
  const out = {};
  for (const [i, id] of ids.entries()) {
    try { const v = await pageDetails(id); if (v) out[id] = v; }
    catch (e) { if (e.blocked) { log(`  YouTube rate limit after ${i} of ${ids.length}; the rest wait for next run`); out.__blocked = ids.slice(i); return out; } throw e; }
    await sleep(gap);
  }
  return out;
}
