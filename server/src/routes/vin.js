import { Router } from 'express';
import { asyncHandler, badRequest, HttpError } from '../helpers.js';

// VIN = 11–17 chars, alphanumeric excluding I/O/Q (the letters never used in a
// real VIN). Case-insensitive; the response echoes the normalized uppercase VIN.
const VIN_RE = /^[A-HJ-NPR-Z0-9]{11,17}$/i;

// vPIC returns "" (and occasionally null) for fields it has no data for. Treat
// those as null; keep everything else verbatim (trimmed).
function blank(value) {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s === '' ? null : s;
}

// vPIC has no single "Engine" field, so compose a human-readable descriptor from
// the parts it does expose (displacement, cylinders, engine model). Null when
// none are present, honoring the spec's "nulls for blanks".
function composeEngine(r) {
  const parts = [];
  const disp = blank(r.DisplacementL);
  const cyl = blank(r.EngineCylinders);
  const model = blank(r.EngineModel);
  if (disp) parts.push(`${disp}L`);
  if (cyl) parts.push(`${cyl}-cyl`);
  if (model) parts.push(model);
  return parts.length ? parts.join(' ') : null;
}

function composePlant(r) {
  const s = [blank(r.PlantCity), blank(r.PlantState), blank(r.PlantCountry)]
    .filter(Boolean)
    .join(', ');
  return s || null;
}

export function vinRouter(ctx) {
  const router = Router();

  router.get(
    '/vin/:vin',
    asyncHandler(async (req, res) => {
      const raw = req.params.vin;
      if (!VIN_RE.test(raw)) throw badRequest('VIN must be 11–17 characters, letters/numbers only (no I, O, Q)');
      const vin = raw.toUpperCase();

      const url = `${ctx.config.nhtsaVpicBase}/DecodeVinValues/${encodeURIComponent(vin)}?format=json`;

      let data;
      try {
        const resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
        if (!resp.ok) throw new Error(`vPIC responded ${resp.status}`);
        data = await resp.json();
      } catch {
        throw new HttpError(502, 'VIN decode service is unavailable');
      }

      const r = Array.isArray(data?.Results) ? data.Results[0] : null;
      if (!r) throw new HttpError(502, 'VIN decode service returned no data');

      const yearStr = blank(r.ModelYear);
      const year = yearStr && /^\d+$/.test(yearStr) ? Number(yearStr) : null;

      res.json({
        vin,
        year,
        make: blank(r.Make),
        model: blank(r.Model),
        trim: blank(r.Trim),
        body_class: blank(r.BodyClass),
        engine: composeEngine(r),
        plant: composePlant(r),
      });
    })
  );

  return router;
}
