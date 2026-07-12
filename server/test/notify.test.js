import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeApp, authAgent, makeVehicle, addRecord, addReminder, today, addMonths } from './helpers.js';
import { collectDue, sendNotifications } from '../src/notify.js';

let dataDir;
let savedEnv;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'carmaint-notify-'));
  savedEnv = {
    CRON_SECRET: process.env.CRON_SECRET,
    APP_PASSWORD: process.env.APP_PASSWORD,
    NTFY_URL: process.env.NTFY_URL,
    NOTIFY_WEBHOOK_URL: process.env.NOTIFY_WEBHOOK_URL,
  };
  // Keep auth off and no real notify targets configured by default.
  delete process.env.APP_PASSWORD;
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
  for (const key of Object.keys(savedEnv)) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

// A fake fetch that records every call and never touches the network.
function recordingFetch() {
  const calls = [];
  const impl = async (url, options) => {
    calls.push({ url, options });
    return { ok: true, status: 200 };
  };
  impl.calls = calls;
  return impl;
}

// Seed one reminder that is overdue relative to whatever "today" is when the test
// runs (record a year ago + 6-month interval → next due 6 months ago). Owned by a
// freshly-registered user; collectDue (global) still sees it since it is owned.
async function seedOverdue(app) {
  const agent = await authAgent(app);
  const v = await makeVehicle(agent);
  await addRecord(agent, v.id, { type: 'oil_change', date: addMonths(today(), -12), mileage: 1000 });
  await addReminder(agent, v.id, { interval_months: 6 });
  return v;
}

describe('collectDue', () => {
  it('buckets reminders into overdue and due_soon', async () => {
    const app = makeApp(dataDir);
    await seedOverdue(app);

    const due = await collectDue(app.locals.ctx.db);
    expect(due.overdue).toHaveLength(1);
    expect(due.due_soon).toHaveLength(0);
    expect(due.overdue[0].type).toBe('oil_change');
    expect(typeof due.overdue[0].vehicle_name).toBe('string');
  });

  it('returns empty buckets when nothing is due', async () => {
    const app = makeApp(dataDir);
    const agent = await authAgent(app);
    await makeVehicle(agent); // no reminders at all
    const due = await collectDue(app.locals.ctx.db);
    expect(due).toEqual({ overdue: [], due_soon: [] });
  });
});

describe('sendNotifications', () => {
  const DUE = {
    overdue: [
      {
        type: 'oil_change',
        vehicle_name: '2020 Toyota Corolla',
        next_due_date: '2025-01-01',
        next_due_mileage: null,
        status: 'overdue',
      },
    ],
    due_soon: [],
  };

  it('posts plain text with a Title header to ntfy', async () => {
    const fetchImpl = recordingFetch();
    const summary = await sendNotifications({ ntfyUrl: 'http://ntfy.local/carmaint' }, DUE, fetchImpl);

    expect(fetchImpl.calls).toHaveLength(1);
    const { url, options } = fetchImpl.calls[0];
    expect(url).toBe('http://ntfy.local/carmaint');
    expect(options.method).toBe('POST');
    expect(options.headers.Title).toBe('CarMaint: 1 maintenance reminder due');
    expect(options.headers['Content-Type']).toMatch(/text\/plain/);
    expect(typeof options.body).toBe('string');
    expect(options.body).toContain('Overdue:');
    expect(summary.ntfy).toBe(true);
    expect(summary.sent).toBe(true);
  });

  it('posts JSON to the webhook target', async () => {
    const fetchImpl = recordingFetch();
    await sendNotifications({ notifyWebhookUrl: 'http://hook.local/notify' }, DUE, fetchImpl);

    expect(fetchImpl.calls).toHaveLength(1);
    const { url, options } = fetchImpl.calls[0];
    expect(url).toBe('http://hook.local/notify');
    expect(options.headers['Content-Type']).toBe('application/json');
    const payload = JSON.parse(options.body);
    expect(payload).toMatchObject({
      title: 'CarMaint: 1 maintenance reminder due',
      overdue: DUE.overdue,
      due_soon: [],
    });
    expect(typeof payload.body).toBe('string');
  });

  it('is a no-op when nothing is due', async () => {
    const fetchImpl = recordingFetch();
    const summary = await sendNotifications(
      { ntfyUrl: 'http://ntfy.local/x', notifyWebhookUrl: 'http://hook.local/x' },
      { overdue: [], due_soon: [] },
      fetchImpl
    );
    expect(fetchImpl.calls).toHaveLength(0);
    expect(summary.sent).toBe(false);
  });
});

describe('cron routes', () => {
  const SECRET = 'top-secret-cron-token';

  it('/api/cron/notify 401s when the bearer is missing or wrong', async () => {
    process.env.CRON_SECRET = SECRET;
    const app = makeApp(dataDir);

    const missing = await request(app).get('/api/cron/notify');
    expect(missing.status).toBe(401);
    expect(missing.body.ok).toBe(false);

    const wrong = await request(app)
      .get('/api/cron/notify')
      .set('Authorization', 'Bearer nope');
    expect(wrong.status).toBe(401);
    expect(wrong.body.ok).toBe(false);
  });

  it('/api/cron/notify returns {ok:true} with the right bearer', async () => {
    process.env.CRON_SECRET = SECRET;
    const app = makeApp(dataDir);
    // No targets configured and nothing due → no network calls.
    const res = await request(app)
      .get('/api/cron/notify')
      .set('Authorization', `Bearer ${SECRET}`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('/api/cron/backup 401s without the bearer', async () => {
    process.env.CRON_SECRET = SECRET;
    const app = makeApp(dataDir);
    const res = await request(app).get('/api/cron/backup');
    expect(res.status).toBe(401);
    expect(res.body.ok).toBe(false);
  });

  it('/api/cron/backup with the right bearer produces a listed backup', async () => {
    process.env.CRON_SECRET = SECRET;
    const app = makeApp(dataDir);
    const agent = await authAgent(app);
    await makeVehicle(agent); // some data to snapshot

    const res = await request(app)
      .get('/api/cron/backup')
      .set('Authorization', `Bearer ${SECRET}`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(typeof res.body.filename).toBe('string');

    // The stored-backups list is a GLOBAL DR endpoint: it needs both a session
    // (agent) and the CRON_SECRET bearer when CRON_SECRET is set.
    const list = await agent.get('/api/backups').set('Authorization', `Bearer ${SECRET}`);
    expect(list.status).toBe(200);
    expect(list.body.some((b) => b.filename === res.body.filename)).toBe(true);
  });
});
