import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yauzl from 'yauzl';
import yazl from 'yazl';
import { makeApp, authAgent, makeVehicle, addRecord, addReminder, uploadPhoto, PNG_1x1 } from './helpers.js';

let dataDir;
let app;
let agent;
let dataDir2;

beforeEach(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'carmaint-'));
  app = makeApp(dataDir);
  agent = await authAgent(app);
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
  if (dataDir2) {
    fs.rmSync(dataDir2, { recursive: true, force: true });
    dataDir2 = undefined;
  }
});

// A second app on its own dataDir plus a fresh authenticated agent (a different
// user), for restore/isolation round-trips.
async function makeApp2() {
  dataDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'carmaint2-'));
  const app2 = makeApp(dataDir2);
  const agent2 = await authAgent(app2);
  return { app2, agent2 };
}

// supertest binary body parser: collects the raw response bytes into a Buffer.
function binaryParser(res, cb) {
  res.setEncoding('binary');
  let data = '';
  res.on('data', (chunk) => {
    data += chunk;
  });
  res.on('end', () => cb(null, Buffer.from(data, 'binary')));
}

function downloadBuffer(agentReq) {
  return agentReq.buffer().parse(binaryParser);
}

// Read a zip Buffer into a Map<entryName, contentBuffer> using yauzl (a server dep).
function readZipEntries(buffer) {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (err, zip) => {
      if (err) return reject(err);
      const entries = new Map();
      zip.on('entry', (entry) => {
        if (/\/$/.test(entry.fileName)) {
          zip.readEntry();
          return;
        }
        zip.openReadStream(entry, (streamErr, stream) => {
          if (streamErr) return reject(streamErr);
          const chunks = [];
          stream.on('data', (c) => chunks.push(c));
          stream.on('error', reject);
          stream.on('end', () => {
            entries.set(entry.fileName, Buffer.concat(chunks));
            zip.readEntry();
          });
        });
      });
      zip.on('error', reject);
      zip.on('end', () => resolve(entries));
      zip.readEntry();
    });
  });
}

// Build a zip Buffer from [{ name, content }] with yazl (a server dep). yazl rejects
// '..'/absolute entry names at build time, so traversal zips use buildRawZip below.
function buildZip(entries) {
  return new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile();
    for (const { name, content } of entries) {
      zip.addBuffer(Buffer.isBuffer(content) ? content : Buffer.from(content), name);
    }
    const chunks = [];
    zip.outputStream.on('data', (c) => chunks.push(c));
    zip.outputStream.on('error', reject);
    zip.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
    zip.end();
  });
}

// Minimal CRC-32 + stored (uncompressed) zip writer. Unlike yazl this imposes no name
// validation, so it can emit a malicious '..' entry to exercise the restore sanitizer.
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function buildRawZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const { name, content } of entries) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content);
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, nameBuf, data);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(0, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(offset, 42);
    centralParts.push(cd, nameBuf);

    offset += local.length + nameBuf.length + data.length;
  }
  const central = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, central, eocd]);
}

// Seed one of everything (owned by agent `a`) and return the raw backup zip Buffer
// plus the photo row.
async function seedAndBackup(a = agent) {
  const v = await makeVehicle(a, { name: 'Backup Rig', current_mileage: 42000 });
  await addRecord(a, v.id, { date: '2024-01-01', cost: 20, mileage: 41000 });
  await addReminder(a, v.id, { interval_months: 6 });
  const photo = (await uploadPhoto(a, v.id)).body[0];
  const res = await downloadBuffer(a.get('/api/backup'));
  return { v, photo, res };
}

// Reusable valid manifest.json + carmaint.db buffers, extracted from a real backup.
async function goodParts() {
  const { photo, res } = await seedAndBackup(agent);
  const entries = await readZipEntries(res.body);
  return {
    manifest: entries.get('manifest.json'),
    db: entries.get('carmaint.db'),
    photo,
  };
}

describe('GET /api/backup', () => {
  it('returns an application/zip attachment named carmaint-backup-<date>.zip', async () => {
    await seedAndBackup(agent);
    const res = await downloadBuffer(agent.get('/api/backup'));
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/zip/);
    expect(res.headers['content-disposition']).toMatch(/attachment/);
    expect(res.headers['content-disposition']).toMatch(/carmaint-backup-\d{4}-\d{2}-\d{2}\.zip/);
    expect(Buffer.isBuffer(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);
  });

  it('zip contains manifest.json with app/version and correct counts', async () => {
    const { res } = await seedAndBackup(agent);
    const entries = await readZipEntries(res.body);
    expect(entries.has('manifest.json')).toBe(true);

    const manifest = JSON.parse(entries.get('manifest.json').toString('utf8'));
    expect(manifest.app).toBe('carmaint');
    expect(manifest.version).toBe(1);
    expect(typeof manifest.exported_at).toBe('string');
    expect(manifest.counts).toMatchObject({ vehicles: 1, records: 1, reminders: 1, photos: 1 });
  });

  it('zip contains carmaint.db and photos/<filename> for an uploaded photo', async () => {
    const { photo, res } = await seedAndBackup(agent);
    const entries = await readZipEntries(res.body);

    expect(entries.has('carmaint.db')).toBe(true);
    expect(entries.get('carmaint.db').length).toBeGreaterThan(0);

    const photoEntry = `photos/${photo.filename}`;
    expect(entries.has(photoEntry)).toBe(true);
    expect(Buffer.compare(entries.get(photoEntry), PNG_1x1)).toBe(0);
  });
});

describe('POST /api/restore round-trip', () => {
  it('imports vehicles, records and photo files into the restoring user account', async () => {
    const { photo, res } = await seedAndBackup(agent);
    const { agent2 } = await makeApp2();

    const restore = await agent2
      .post('/api/restore')
      .attach('backup', res.body, { filename: 'backup.zip', contentType: 'application/zip' });
    expect(restore.status).toBe(200);
    expect(restore.body).toMatchObject({ restored: true });

    const list = await agent2.get('/api/vehicles');
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(1);
    // Restore is additive with fresh ids owned by the importer; match on content.
    const imported = list.body[0];
    expect(imported.name).toBe('Backup Rig');
    expect(imported.photo_count).toBe(1);

    const records = await agent2.get(`/api/vehicles/${imported.id}/records`);
    expect(records.body).toHaveLength(1);
    expect(records.body[0].date).toBe('2024-01-01');

    // The restored photo file is served (to its new owner) with the original bytes.
    const served = await downloadBuffer(agent2.get(`/photos/${photo.filename}`));
    expect(served.status).toBe(200);
    expect(Buffer.compare(served.body, PNG_1x1)).toBe(0);
  });
});

describe('POST /api/restore rejections leave target data untouched', () => {
  async function expectRejected(zipBuffer) {
    const { agent2 } = await makeApp2();
    const keep = await makeVehicle(agent2, { name: 'KEEP ME' });

    const restore = await agent2
      .post('/api/restore')
      .attach('backup', zipBuffer, { filename: 'bad.zip', contentType: 'application/zip' });
    expect(restore.status).toBe(400);
    expect(typeof restore.body.error).toBe('string');

    const after = await agent2.get('/api/vehicles');
    expect(after.body).toHaveLength(1);
    expect(after.body[0].id).toBe(keep.id);
    expect(after.body[0].name).toBe('KEEP ME');
  }

  it('rejects a non-zip garbage buffer', async () => {
    await expectRejected(Buffer.from('this is definitely not a zip file'));
  });

  it('rejects a zip with no manifest.json', async () => {
    const { db } = await goodParts();
    const zip = await buildZip([{ name: 'carmaint.db', content: db }]);
    await expectRejected(zip);
  });

  it('rejects a zip whose manifest has the wrong app', async () => {
    const { db } = await goodParts();
    const manifest = JSON.stringify({ app: 'notcarmaint', version: 1, counts: {} });
    const zip = await buildZip([
      { name: 'manifest.json', content: manifest },
      { name: 'carmaint.db', content: db },
    ]);
    await expectRejected(zip);
  });

  it('rejects a zip whose manifest has the wrong version', async () => {
    const { db } = await goodParts();
    const manifest = JSON.stringify({ app: 'carmaint', version: 999, counts: {} });
    const zip = await buildZip([
      { name: 'manifest.json', content: manifest },
      { name: 'carmaint.db', content: db },
    ]);
    await expectRejected(zip);
  });

  it('rejects a zip with a path-traversal entry name (..)', async () => {
    const { db, manifest } = await goodParts();
    // Hand-built so the entry name can contain '..' (yazl forbids that at build time).
    const zip = buildRawZip([
      { name: 'manifest.json', content: manifest },
      { name: 'carmaint.db', content: db },
      { name: '../evil.txt', content: 'pwned' },
    ]);
    await expectRejected(zip);
  });
});

describe('GET /api/backups', () => {
  it('returns [] when there is no backups directory', async () => {
    const res = await agent.get('/api/backups');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('lists filename and size for a zip placed in <dataDir>/backups', async () => {
    const backupsDir = path.join(dataDir, 'backups');
    fs.mkdirSync(backupsDir, { recursive: true });
    const bytes = Buffer.from('PK fake backup payload');
    const filename = 'carmaint-backup-20240101-000000.zip';
    fs.writeFileSync(path.join(backupsDir, filename), bytes);

    const res = await agent.get('/api/backups');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].filename).toBe(filename);
    expect(res.body[0].size).toBe(bytes.length);
    expect(res.body[0].created_at).toBeTruthy();
  });

  it('downloads a specific backup by filename', async () => {
    const backupsDir = path.join(dataDir, 'backups');
    fs.mkdirSync(backupsDir, { recursive: true });
    const bytes = Buffer.from('PK fake backup payload for download');
    const filename = 'carmaint-backup-20240102-000000.zip';
    fs.writeFileSync(path.join(backupsDir, filename), bytes);

    const res = await downloadBuffer(agent.get(`/api/backups/${filename}`));
    expect(res.status).toBe(200);
    expect(Buffer.compare(res.body, bytes)).toBe(0);
  });

  it('returns 404 for an unknown backup filename', async () => {
    fs.mkdirSync(path.join(dataDir, 'backups'), { recursive: true });
    const res = await agent.get('/api/backups/nope.zip');
    expect(res.status).toBe(404);
    expect(typeof res.body.error).toBe('string');
  });

  it('returns 404 for a path-traversal backup filename', async () => {
    const backupsDir = path.join(dataDir, 'backups');
    fs.mkdirSync(backupsDir, { recursive: true });
    fs.writeFileSync(path.join(backupsDir, 'real.zip'), Buffer.from('x'));
    // URL-encoded "../carmaint.db" must not escape the backups directory.
    const res = await agent.get('/api/backups/..%2Fcarmaint.db');
    expect(res.status).toBe(404);
  });
});

describe('GET /api/export.csv (all vehicles)', () => {
  const HEADER = 'vehicle,date,type,mileage,cost,shop,description,notes';

  it('exports every vehicle, header, name/fallback vehicle column, date ASC across vehicles', async () => {
    const v1 = await makeVehicle(agent, { name: 'Truck', make: 'Ford', model: 'F-150', year: 2021 });
    const v2 = await makeVehicle(agent, { make: 'Mazda', model: '3', year: 2017 }); // no name -> fallback
    await addRecord(agent, v1.id, { type: 'oil_change', date: '2024-02-01', cost: 30 });
    await addRecord(agent, v2.id, { type: 'repair', date: '2024-01-01', cost: 10 });

    const res = await agent.get('/api/export.csv');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.headers['content-disposition']).toMatch(/attachment/);

    const lines = res.text.split(/\r?\n/);
    expect(lines[0]).toBe(HEADER);

    // vehicle column: nickname for v1, "<year> <make> <model>" fallback for v2.
    expect(res.text).toContain('Truck,2024-02-01,oil_change');
    expect(res.text).toContain('2017 Mazda 3,2024-01-01,repair');

    // date ASC across vehicles: v2's Jan row precedes v1's Feb row.
    const idxJan = res.text.indexOf('2024-01-01');
    const idxFeb = res.text.indexOf('2024-02-01');
    expect(idxJan).toBeGreaterThan(-1);
    expect(idxFeb).toBeGreaterThan(-1);
    expect(idxJan).toBeLessThan(idxFeb);
  });
});

describe('GET /api/export.json', () => {
  it('returns the app/version/exported_at envelope with nested vehicle data', async () => {
    const v = await makeVehicle(agent, { name: 'JSON Rig' });
    await addRecord(agent, v.id, { type: 'oil_change', date: '2024-05-01', cost: 40 });
    await addRecord(agent, v.id, { type: 'repair', date: '2024-02-01', cost: 100 });
    await addReminder(agent, v.id, { interval_months: 6 });
    const photo = (await uploadPhoto(agent, v.id)).body[0];

    const res = await agent.get('/api/export.json');
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toMatch(/attachment/);
    expect(res.body.app).toBe('carmaint');
    expect(res.body.version).toBe(1);
    expect(typeof res.body.exported_at).toBe('string');
    expect(res.body.exported_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    expect(res.body.vehicles).toHaveLength(1);
    const vj = res.body.vehicles[0];
    expect(vj.id).toBe(v.id);

    // records: date ASC.
    expect(vj.records.map((r) => r.date)).toEqual(['2024-02-01', '2024-05-01']);
    expect(Array.isArray(vj.reminders)).toBe(true);
    expect(vj.reminders).toHaveLength(1);

    // photos: metadata array of { filename, original_name, is_primary }.
    expect(vj.photos).toHaveLength(1);
    expect(vj.photos[0]).toMatchObject({
      filename: photo.filename,
      original_name: 'a.png',
      is_primary: 1,
    });
  });
});
