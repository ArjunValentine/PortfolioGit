// Florida Hydrology — live gauge feed for the Winter Haven Chain.
//
// Server-side proxy to USGS real-time water data. Runs on Netlify (open egress),
// so the browser gets real readings same-origin with no CORS wrangling. This is
// the "scheduled ingest / Edge Function" role from the design guide, collapsed
// to an on-demand read with a short CDN cache.
//
// Source: USGS NWIS Instantaneous Values (real-time). We ask for lake/reservoir
// ELEVATION params first (62615 NAVD88 ft, 62614 NGVD29 ft, 00062 reservoir
// elev) and fall back to gage height (00065). The client never assumes a shared
// vertical datum across gauges — it works off each gauge's own drawdown below
// its recent full pool — so mixed datums here are safe, not garbage.
//
// NOTE: the guide flags waterservices.usgs.gov for decommission in Q1 2027; the
// forward path is the OGC API at api.waterdata.usgs.gov/ogcapi. Swap SOURCE_URL
// when migrating — the normalized shape returned below is the contract.

const BBOX = "-81.760,27.985,-81.675,28.078"; // W,S,E,N — Winter Haven Chain, Polk Co.
const PARAMS = "62615,62614,00062,00065";      // elevation preferred; gage height last
const PARAM_RANK = { "62615": 4, "62614": 3, "00062": 2, "00065": 1 };
const SOURCE_URL =
  `https://waterservices.usgs.gov/nwis/iv/?format=json` +
  `&bBox=${BBOX}&parameterCd=${PARAMS}&period=P30D&siteStatus=all`;

export default async (req) => {
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    // 5-min shared cache; USGS IV updates on a similar cadence.
    "Cache-Control": "public, max-age=300, s-maxage=300",
  };
  if (req.method === "OPTIONS") return new Response("", { status: 204, headers });

  try {
    const r = await fetch(SOURCE_URL, { headers: { Accept: "application/json" } });
    if (!r.ok) {
      return new Response(
        JSON.stringify({ ok: false, error: `USGS responded ${r.status}` }),
        { status: 502, headers }
      );
    }
    const data = await r.json();
    const series = data?.value?.timeSeries || [];

    // group by site; keep the highest-ranked parameter available per site
    const bySite = new Map();
    for (const t of series) {
      const si = t.sourceInfo || {};
      const id = si.siteCode?.[0]?.value;
      if (!id) continue;
      const param = t.variable?.variableCode?.[0]?.value;
      const rank = PARAM_RANK[param] || 0;
      const pts = (t.values?.[0]?.value || [])
        .map((v) => ({ t: v.dateTime, v: Number(v.value) }))
        .filter((p) => Number.isFinite(p.v) && p.v > -900); // -999999 = no data
      if (!pts.length) continue;

      const prev = bySite.get(id);
      if (prev && prev.rank >= rank) continue;
      const gl = si.geoLocation?.geogLocation || {};
      bySite.set(id, {
        rank,
        gauge: {
          id,
          name: cleanName(si.siteName || id),
          lat: Number(gl.latitude),
          lon: Number(gl.longitude),
          param,
          unit: t.variable?.unit?.unitCode || "ft",
          series: pts,
          latest: pts[pts.length - 1],
          fullPool: Math.max(...pts.map((p) => p.v)), // recent high = full-pool ref
        },
      });
    }

    const gauges = [...bySite.values()].map((x) => x.gauge);
    return new Response(
      JSON.stringify({
        ok: true,
        source: "USGS NWIS Instantaneous Values",
        bbox: BBOX,
        fetchedAt: new Date().toISOString(),
        count: gauges.length,
        gauges,
      }),
      { status: 200, headers }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ ok: false, error: String(err && err.message || err) }),
      { status: 502, headers }
    );
  }
};

// "LAKE HOWARD AT WINTER HAVEN, FL" -> "Lake Howard at Winter Haven"
function cleanName(s) {
  return String(s)
    .replace(/,?\s*FL\.?$/i, "")
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .replace(/\bAt\b/g, "at")
    .replace(/\bNear\b/g, "near")
    .trim();
}
