import { Router } from 'express';
import { asyncHandler, getVehicleOr404, HttpError } from '../helpers.js';

const TTL_MS = 24 * 60 * 60 * 1000; // recalls_cache freshness window

function blank(value) {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s === '' ? null : s;
}

// The NHTSA recalls endpoint returns rows under `results` (lowercase); accept
// `Results` too, defensively. Map each row to the spec's compact shape.
function mapRecalls(data) {
  const rows = Array.isArray(data?.results)
    ? data.results
    : Array.isArray(data?.Results)
      ? data.Results
      : [];
  return rows.map((x) => ({
    campaign_number: blank(x.NHTSACampaignNumber),
    component: blank(x.Component),
    summary: blank(x.Summary),
    consequence: blank(x.Consequence),
    remedy: blank(x.Remedy),
    report_date: blank(x.ReportReceivedDate),
  }));
}

function parsePayload(raw) {
  try {
    const p = JSON.parse(raw);
    return p && typeof p === 'object' ? p : null;
  } catch {
    return null;
  }
}

async function fetchRecalls(ctx, vehicle) {
  const base = ctx.config.nhtsaRecallsBase;
  const url =
    `${base}/recalls/recallsByVehicle` +
    `?make=${encodeURIComponent(vehicle.make)}` +
    `&model=${encodeURIComponent(vehicle.model)}` +
    `&modelYear=${encodeURIComponent(vehicle.year)}`;
  const resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!resp.ok) throw new Error(`recalls responded ${resp.status}`);
  const data = await resp.json();
  return { fetched_at: new Date().toISOString(), recalls: mapRecalls(data) };
}

export function recallsRouter(ctx) {
  const router = Router();

  router.get(
    '/vehicles/:id/recalls',
    asyncHandler(async (req, res) => {
      const db = ctx.db;
      const vehicle = await getVehicleOr404(db, req.params.id, req.user.id);
      const refresh = req.query.refresh === '1';

      const cached = await db.get('SELECT * FROM recalls_cache WHERE vehicle_id = ?', [vehicle.id]);

      // Warm and fresh, and not force-refreshing → serve the cache.
      if (!refresh && cached && cached.fetched_at && cached.payload) {
        const age = Date.now() - Date.parse(cached.fetched_at);
        const parsed = parsePayload(cached.payload);
        if (parsed && Number.isFinite(age) && age >= 0 && age < TTL_MS) {
          return res.json(parsed);
        }
      }

      // Refresh from upstream. On failure, fall back to any (even stale) cache;
      // a cold miss surfaces as 502.
      let payload;
      try {
        payload = await fetchRecalls(ctx, vehicle);
      } catch {
        if (cached && cached.payload) {
          const parsed = parsePayload(cached.payload);
          if (parsed) return res.json(parsed);
        }
        throw new HttpError(502, 'Recall service is unavailable');
      }

      await db.run(
        `INSERT INTO recalls_cache (vehicle_id, fetched_at, payload)
         VALUES (?, ?, ?)
         ON CONFLICT(vehicle_id) DO UPDATE SET
           fetched_at = excluded.fetched_at,
           payload = excluded.payload`,
        [vehicle.id, payload.fetched_at, JSON.stringify(payload)]
      );

      res.json(payload);
    })
  );

  return router;
}
