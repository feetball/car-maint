import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeApp, authAgent, makeVehicle } from './helpers.js';

// A local stub for the two NHTSA endpoints the server proxies (vPIC decode +
// recallsByVehicle). It runs on an ephemeral port, counts hits per endpoint (so
// cache behavior is observable), and can be flipped to fail. No test touches the
// real internet: the app is pointed at this base via createApp options.
const VPIC_BODY = {
  Results: [
    {
      ModelYear: '2020',
      Make: 'TOYOTA',
      Model: 'Corolla',
      Trim: 'LE',
      BodyClass: 'Sedan/Saloon',
      DisplacementL: '1.8',
      EngineCylinders: '4',
      EngineModel: '2ZR-FE',
      PlantCity: 'TAKAOKA',
      PlantState: '',
      PlantCountry: 'JAPAN',
    },
  ],
};

const RECALLS_BODY = {
  results: [
    {
      NHTSACampaignNumber: '23V456000',
      Component: 'SERVICE BRAKES, HYDRAULIC',
      Summary: 'The brake line may corrode and leak.',
      Consequence: 'A leak increases stopping distance.',
      Remedy: 'Dealers will inspect and replace the brake line, free of charge.',
      ReportReceivedDate: '2023-05-01',
    },
  ],
};

let stub;

function startStub() {
  const state = { vpicHits: 0, recallsHits: 0, vpicFail: false, recallsFail: false };
  const server = http.createServer((req, res) => {
    const url = req.url || '';
    if (url.startsWith('/DecodeVinValues/')) {
      state.vpicHits += 1;
      if (state.vpicFail) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        return res.end('vpic down');
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(VPIC_BODY));
    }
    if (url.startsWith('/recalls/recallsByVehicle')) {
      state.recallsHits += 1;
      if (state.recallsFail) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        return res.end('recalls down');
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(RECALLS_BODY));
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, state, base: `http://127.0.0.1:${port}` });
    });
  });
}

beforeAll(async () => {
  stub = await startStub();
});

afterAll(() => {
  stub.server.close();
});

let dataDir;
let app;
let agent;

beforeEach(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'carmaint-nhtsa-'));
  stub.state.vpicHits = 0;
  stub.state.recallsHits = 0;
  stub.state.vpicFail = false;
  stub.state.recallsFail = false;
  app = makeApp(dataDir, { nhtsaVpicBase: stub.base, nhtsaRecallsBase: stub.base });
  agent = await authAgent(app);
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('GET /api/vin/:vin', () => {
  it('rejects a too-short VIN with 400 without hitting upstream', async () => {
    const res = await agent.get('/api/vin/ABC');
    expect(res.status).toBe(400);
    expect(typeof res.body.error).toBe('string');
    expect(stub.state.vpicHits).toBe(0);
  });

  it('rejects a VIN containing the letter I with 400', async () => {
    // 17 chars but with an I, which is never used in real VINs.
    const res = await agent.get('/api/vin/1HGBH41JXMN109I86');
    expect(res.status).toBe(400);
    expect(typeof res.body.error).toBe('string');
    expect(stub.state.vpicHits).toBe(0);
  });

  it('decodes a valid VIN and maps the vPIC fields', async () => {
    const res = await agent.get('/api/vin/1hgbh41jxmn109186');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      vin: '1HGBH41JXMN109186', // echoed uppercased
      year: 2020,
      make: 'TOYOTA',
      model: 'Corolla',
      trim: 'LE',
      body_class: 'Sedan/Saloon',
      engine: '1.8L 4-cyl 2ZR-FE',
      plant: 'TAKAOKA, JAPAN', // blank PlantState dropped
    });
    expect(stub.state.vpicHits).toBe(1);
  });

  it('maps an upstream 500 to a 502', async () => {
    stub.state.vpicFail = true;
    const res = await agent.get('/api/vin/1HGBH41JXMN109186');
    expect(res.status).toBe(502);
    expect(typeof res.body.error).toBe('string');
  });
});

describe('GET /api/vehicles/:id/recalls', () => {
  it('fetches and maps recalls on a cold cache', async () => {
    const v = await makeVehicle(agent, { make: 'Toyota', model: 'Corolla', year: 2020 });
    const res = await agent.get(`/api/vehicles/${v.id}/recalls`);
    expect(res.status).toBe(200);
    expect(typeof res.body.fetched_at).toBe('string');
    expect(res.body.recalls).toHaveLength(1);
    expect(res.body.recalls[0]).toEqual({
      campaign_number: '23V456000',
      component: 'SERVICE BRAKES, HYDRAULIC',
      summary: 'The brake line may corrode and leak.',
      consequence: 'A leak increases stopping distance.',
      remedy: 'Dealers will inspect and replace the brake line, free of charge.',
      report_date: '2023-05-01',
    });
    expect(stub.state.recallsHits).toBe(1);
  });

  it('serves a fresh cache on the second call without re-hitting upstream', async () => {
    const v = await makeVehicle(agent);
    const first = await agent.get(`/api/vehicles/${v.id}/recalls`);
    expect(first.status).toBe(200);
    expect(stub.state.recallsHits).toBe(1);

    const second = await agent.get(`/api/vehicles/${v.id}/recalls`);
    expect(second.status).toBe(200);
    expect(stub.state.recallsHits).toBe(1); // cache hit — no new upstream call
    expect(second.body).toEqual(first.body);
  });

  it('?refresh=1 bypasses the cache and re-hits upstream', async () => {
    const v = await makeVehicle(agent);
    await agent.get(`/api/vehicles/${v.id}/recalls`);
    expect(stub.state.recallsHits).toBe(1);

    const refreshed = await agent.get(`/api/vehicles/${v.id}/recalls?refresh=1`);
    expect(refreshed.status).toBe(200);
    expect(stub.state.recallsHits).toBe(2);
  });

  it('falls back to the warm cache when upstream starts failing', async () => {
    const v = await makeVehicle(agent);
    const warm = await agent.get(`/api/vehicles/${v.id}/recalls`);
    expect(warm.status).toBe(200);

    // Upstream now fails; a forced refresh must fall back to the cached payload.
    stub.state.recallsFail = true;
    const res = await agent.get(`/api/vehicles/${v.id}/recalls?refresh=1`);
    expect(res.status).toBe(200);
    expect(res.body.recalls).toHaveLength(1);
    expect(res.body.recalls[0].campaign_number).toBe('23V456000');
  });

  it('returns 502 on a cold upstream failure with no cache', async () => {
    stub.state.recallsFail = true;
    const v = await makeVehicle(agent);
    const res = await agent.get(`/api/vehicles/${v.id}/recalls`);
    expect(res.status).toBe(502);
    expect(typeof res.body.error).toBe('string');
  });
});
