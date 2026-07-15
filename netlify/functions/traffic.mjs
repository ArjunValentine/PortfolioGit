// Pinellas Traffic Oracle — live corridor speeds from TomTom.
//
// Server-side proxy to TomTom's Flow Segment Data API, one probe point per
// corridor shown on the Oracle. Runs on Netlify so TOMTOM_API_KEY never
// reaches the browser — the client only ever sees this endpoint's normalized
// JSON, same-origin, no CORS wrangling and no key in view-source.
//
// This is a *current-conditions* feed, not a forecast: TomTom has no opinion
// about 3 hours from now. The Oracle's predictive layer (time-of-day, school
// calendar, weather, ballgame/event calendar, RSS incidents) still owns every
// horizon other than "now" — see traffic-oracle/index.html's blending logic.

const POINTS = {
  '275':  { lat: 27.9236, lon: -82.6203, label: 'Howard Frankland Bridge' },
  us19:   { lat: 28.0084, lon: -82.7369, label: 'US-19 @ SR-590' },
  sr60:   { lat: 27.9740, lon: -82.6890, label: 'Courtney Campbell Causeway' },
  ulm:    { lat: 27.9107, lon: -82.7267, label: 'Ulmerton Rd @ US-19' },
  gandy:  { lat: 27.8776, lon: -82.6120, label: 'Gandy Bridge' },
  sky:    { lat: 27.6222, lon: -82.6556, label: 'Sunshine Skyway Bridge' },
};

async function fetchPoint(key, corridor, point) {
  const url = `https://api.tomtom.com/traffic/services/4/flowSegmentData/absolute/10/json`
    + `?key=${key}&unit=MPH&point=${point.lat},${point.lon}`;
  try {
    const r = await fetch(url);
    if (!r.ok) return { corridor, ok: false, error: `TomTom responded ${r.status}` };
    const d = (await r.json())?.flowSegmentData;
    if (!d || !Number.isFinite(d.currentSpeed) || !Number.isFinite(d.freeFlowSpeed)) {
      return { corridor, ok: false, error: 'no flow data at point' };
    }
    const cf = d.freeFlowTravelTime > 0 ? d.currentTravelTime / d.freeFlowTravelTime : null;
    return {
      corridor,
      ok: true,
      label: point.label,
      currentSpeed: d.currentSpeed,
      freeFlowSpeed: d.freeFlowSpeed,
      cf: cf ? Math.round(cf * 100) / 100 : null,
      confidence: d.confidence ?? null,
      roadClosure: !!d.roadClosure,
    };
  } catch (err) {
    return { corridor, ok: false, error: String((err && err.message) || err) };
  }
}

export default async (req) => {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    // TomTom flow tiles refresh every 1-2 min in probed areas; 90s shared cache
    // keeps us well under rate limits without going stale.
    'Cache-Control': 'public, max-age=90, s-maxage=90',
  };
  if (req.method === 'OPTIONS') return new Response('', { status: 204, headers });

  const key = Netlify.env.get('TOMTOM_API_KEY');
  if (!key) {
    return new Response(
      JSON.stringify({ ok: false, error: 'TOMTOM_API_KEY not configured' }),
      { status: 500, headers }
    );
  }

  const results = await Promise.all(
    Object.entries(POINTS).map(([corridor, point]) => fetchPoint(key, corridor, point))
  );

  const corridors = {};
  for (const r of results) corridors[r.corridor] = r;

  return new Response(
    JSON.stringify({
      ok: true,
      source: 'TomTom Traffic Flow',
      fetchedAt: new Date().toISOString(),
      corridors,
    }),
    { status: 200, headers }
  );
};
