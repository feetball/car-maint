import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeApp, authAgent, makeVehicle, addRecord, addReminder, addMonths } from './helpers.js';

// The calendar feed is per-user now: /calendar.ics?token=<user calendar_token>.
// Each test registers a user, reads its feed URL from /api/calendar-url, and hits
// the feed with a plain (cookie-less) request, the way a calendar app would.
let dataDir;
let app;
let agent;
let feedUrl;

beforeEach(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'carmaint-cal-'));
  app = makeApp(dataDir);
  agent = await authAgent(app);
  const urlRes = await agent.get('/api/calendar-url');
  expect(urlRes.status).toBe(200);
  feedUrl = urlRes.body.url;
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('GET /calendar.ics', () => {
  it('exposes a per-user tokened feed URL', () => {
    expect(feedUrl).toMatch(/^\/calendar\.ics\?token=[0-9a-f]+$/);
  });

  it('401s without a token and with an unknown token', async () => {
    expect((await request(app).get('/calendar.ics')).status).toBe(401);
    expect((await request(app).get('/calendar.ics?token=deadbeef')).status).toBe(401);
  });

  it('serves text/calendar with CRLF line endings', async () => {
    const res = await request(app).get(feedUrl);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/calendar/);
    expect(res.headers['content-type']).toMatch(/charset=utf-8/);
    // CRLF line endings per RFC 5545.
    expect(res.text.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true);
    expect(res.text).toContain('END:VCALENDAR\r\n');
  });

  it('emits one VEVENT with the right UID, DTSTART and SUMMARY for a reminder with history', async () => {
    const v = await makeVehicle(agent, { name: 'Rig' });
    // oil_change record establishes last_date; the 6-month interval yields a
    // computable next_due_date = last_date + 6 months.
    await addRecord(agent, v.id, { type: 'oil_change', date: '2024-01-15', mileage: 30000 });
    const rem = await addReminder(agent, v.id, { interval_months: 6, interval_miles: 5000 });

    const res = await request(app).get(feedUrl);
    expect(res.status).toBe(200);

    const dtstart = addMonths('2024-01-15', 6).replace(/-/g, ''); // 20240715
    expect(res.text).toContain('BEGIN:VEVENT');
    expect(res.text).toContain(`UID:reminder-${rem.id}@carmaint`);
    expect(res.text).toContain(`DTSTART;VALUE=DATE:${dtstart}`);
    expect(res.text).toContain('SUMMARY:Oil Change due — Rig');
  });

  it('emits no VEVENT when a reminder has no computable due date', async () => {
    const v = await makeVehicle(agent);
    // Reminder with an interval but no matching record → no last_date → no due date.
    await addReminder(agent, v.id, { interval_months: 6 });

    const res = await request(app).get(feedUrl);
    expect(res.status).toBe(200);
    expect(res.text).toContain('BEGIN:VCALENDAR');
    expect(res.text).not.toContain('BEGIN:VEVENT');
  });

  it('escapes RFC 5545 special characters in the summary (comma, semicolon, backslash)', async () => {
    // Actual name chars: Al, Bo; C\y  → escaped to  Al\, Bo\; C\\y
    const v = await makeVehicle(agent, { name: 'Al, Bo; C\\y' });
    await addRecord(agent, v.id, { type: 'oil_change', date: '2024-01-15' });
    await addReminder(agent, v.id, { interval_months: 6 });

    const res = await request(app).get(feedUrl);
    expect(res.status).toBe(200);
    expect(res.text).toContain('SUMMARY:Oil Change due — Al\\, Bo\\; C\\\\y');
  });
});
