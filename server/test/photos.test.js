import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeApp, makeVehicle, uploadPhoto, PNG_1x1 } from './helpers.js';

let dataDir;
let app;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'carmaint-'));
  app = makeApp(dataDir);
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function photoPath(filename) {
  return path.join(dataDir, 'photos', filename);
}

describe('POST /api/vehicles/:id/photos', () => {
  it('uploads a PNG, first photo becomes primary, file lands on disk', async () => {
    const v = await makeVehicle(app);
    const res = await uploadPhoto(app, v.id);
    expect(res.status).toBe(201);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(1);

    const photo = res.body[0];
    expect(photo.vehicle_id).toBe(v.id);
    expect(photo.is_primary).toBe(1);
    expect(photo.original_name).toBe('a.png');
    expect(photo.filename).toMatch(/^[0-9a-f-]{36}\.png$/i);

    const onDisk = photoPath(photo.filename);
    expect(fs.existsSync(onDisk)).toBe(true);
    expect(Buffer.compare(fs.readFileSync(onDisk), PNG_1x1)).toBe(0);
  });

  it('second photo is not primary; GET vehicle lists primary first', async () => {
    const v = await makeVehicle(app);
    const first = (await uploadPhoto(app, v.id, { filename: 'a.png' })).body[0];
    const secondRes = await uploadPhoto(app, v.id, { filename: 'b.png' });
    expect(secondRes.status).toBe(201);
    const second = secondRes.body[0];
    expect(second.is_primary).toBe(0);

    const detail = await request(app).get(`/api/vehicles/${v.id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.photos).toHaveLength(2);
    expect(detail.body.photos[0].id).toBe(first.id);
    expect(detail.body.photos[0].is_primary).toBe(1);
    expect(detail.body.photos[1].id).toBe(second.id);
  });

  it('accepts multiple files in one request; only the first-ever is primary', async () => {
    const v = await makeVehicle(app);
    const res = await request(app)
      .post(`/api/vehicles/${v.id}/photos`)
      .attach('photos', PNG_1x1, { filename: 'a.png', contentType: 'image/png' })
      .attach('photos', PNG_1x1, { filename: 'b.png', contentType: 'image/png' });
    expect(res.status).toBe(201);
    expect(res.body).toHaveLength(2);
    expect(res.body[0].is_primary).toBe(1);
    expect(res.body[1].is_primary).toBe(0);
    expect(res.body.filter((p) => p.is_primary === 1)).toHaveLength(1);

    const detail = await request(app).get(`/api/vehicles/${v.id}`);
    expect(detail.body.photos).toHaveLength(2);
  });

  it('rejects an upload of more than 10 files with 400', async () => {
    const v = await makeVehicle(app);
    let req = request(app).post(`/api/vehicles/${v.id}/photos`);
    for (let i = 0; i < 11; i++) {
      req = req.attach('photos', PNG_1x1, { filename: `p${i}.png`, contentType: 'image/png' });
    }
    const res = await req;
    expect(res.status).toBe(400);
    expect(typeof res.body.error).toBe('string');
  });

  it('rejects an upload with zero files with 400', async () => {
    const v = await makeVehicle(app);
    const res = await request(app)
      .post(`/api/vehicles/${v.id}/photos`)
      .field('note', 'no files attached');
    expect(res.status).toBe(400);
    expect(typeof res.body.error).toBe('string');
  });

  it('rejects a bad mimetype with 400', async () => {
    const v = await makeVehicle(app);
    const res = await uploadPhoto(app, v.id, {
      buf: Buffer.from('hello, not an image'),
      filename: 'a.txt',
      contentType: 'text/plain',
    });
    expect(res.status).toBe(400);
    expect(typeof res.body.error).toBe('string');
  });

  it('returns 404 for an unknown vehicle', async () => {
    const res = await uploadPhoto(app, 99999);
    expect(res.status).toBe(404);
    expect(typeof res.body.error).toBe('string');
  });
});

describe('PUT /api/photos/:id/primary', () => {
  it('switches the primary photo and clears the sibling', async () => {
    const v = await makeVehicle(app);
    const first = (await uploadPhoto(app, v.id, { filename: 'a.png' })).body[0];
    const second = (await uploadPhoto(app, v.id, { filename: 'b.png' })).body[0];

    const res = await request(app).put(`/api/photos/${second.id}/primary`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(second.id);
    expect(res.body.is_primary).toBe(1);

    const detail = await request(app).get(`/api/vehicles/${v.id}`);
    const photos = detail.body.photos;
    expect(photos.find((p) => p.id === second.id).is_primary).toBe(1);
    expect(photos.find((p) => p.id === first.id).is_primary).toBe(0);
    expect(photos[0].id).toBe(second.id); // primary sorts first
  });

  it('returns 404 for an unknown photo id', async () => {
    const res = await request(app).put('/api/photos/99999/primary');
    expect(res.status).toBe(404);
    expect(typeof res.body.error).toBe('string');
  });
});

describe('DELETE /api/photos/:id', () => {
  it('deleting the primary promotes the remaining photo and removes the file', async () => {
    const v = await makeVehicle(app);
    const first = (await uploadPhoto(app, v.id, { filename: 'a.png' })).body[0];
    const second = (await uploadPhoto(app, v.id, { filename: 'b.png' })).body[0];
    expect(first.is_primary).toBe(1);

    const del = await request(app).delete(`/api/photos/${first.id}`);
    expect(del.status).toBe(204);
    expect(fs.existsSync(photoPath(first.filename))).toBe(false);
    expect(fs.existsSync(photoPath(second.filename))).toBe(true);

    const detail = await request(app).get(`/api/vehicles/${v.id}`);
    expect(detail.body.photos).toHaveLength(1);
    expect(detail.body.photos[0].id).toBe(second.id);
    expect(detail.body.photos[0].is_primary).toBe(1);
  });

  it('with three photos, deleting the primary promotes the earliest remaining by id', async () => {
    const v = await makeVehicle(app);
    const first = (await uploadPhoto(app, v.id, { filename: 'a.png' })).body[0];
    const second = (await uploadPhoto(app, v.id, { filename: 'b.png' })).body[0];
    const third = (await uploadPhoto(app, v.id, { filename: 'c.png' })).body[0];
    expect(first.is_primary).toBe(1);

    const del = await request(app).delete(`/api/photos/${first.id}`);
    expect(del.status).toBe(204);
    expect(fs.existsSync(photoPath(first.filename))).toBe(false);

    const detail = await request(app).get(`/api/vehicles/${v.id}`);
    expect(detail.body.photos).toHaveLength(2);
    // The oldest remaining photo (second, lowest id) becomes primary.
    expect(detail.body.photos[0].id).toBe(second.id);
    expect(detail.body.photos[0].is_primary).toBe(1);
    expect(detail.body.photos.find((p) => p.id === third.id).is_primary).toBe(0);
  });

  it('deleting a non-primary photo leaves the primary alone', async () => {
    const v = await makeVehicle(app);
    const first = (await uploadPhoto(app, v.id, { filename: 'a.png' })).body[0];
    const second = (await uploadPhoto(app, v.id, { filename: 'b.png' })).body[0];

    const del = await request(app).delete(`/api/photos/${second.id}`);
    expect(del.status).toBe(204);
    expect(fs.existsSync(photoPath(second.filename))).toBe(false);

    const detail = await request(app).get(`/api/vehicles/${v.id}`);
    expect(detail.body.photos).toHaveLength(1);
    expect(detail.body.photos[0].id).toBe(first.id);
    expect(detail.body.photos[0].is_primary).toBe(1);
  });

  it('returns 404 for an unknown photo id', async () => {
    const res = await request(app).delete('/api/photos/99999');
    expect(res.status).toBe(404);
    expect(typeof res.body.error).toBe('string');
  });
});

describe('GET /photos/:filename', () => {
  it('serves the uploaded bytes', async () => {
    const v = await makeVehicle(app);
    const photo = (await uploadPhoto(app, v.id)).body[0];

    const res = await request(app).get(`/photos/${photo.filename}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/image\/png/);
    expect(Buffer.compare(Buffer.from(res.body), PNG_1x1)).toBe(0);
  });
});

describe('v3 photo url fields (disk store)', () => {
  it('upload response carries url = /photos/<filename> for each row', async () => {
    const v = await makeVehicle(app);
    const res = await uploadPhoto(app, v.id);
    expect(res.status).toBe(201);
    const photo = res.body[0];
    expect(photo.url).toBe(`/photos/${photo.filename}`);
  });

  it('GET vehicle detail attaches url to every photo row', async () => {
    const v = await makeVehicle(app);
    const first = (await uploadPhoto(app, v.id, { filename: 'a.png' })).body[0];
    const second = (await uploadPhoto(app, v.id, { filename: 'b.png' })).body[0];

    const detail = await request(app).get(`/api/vehicles/${v.id}`);
    expect(detail.status).toBe(200);
    const byId = new Map(detail.body.photos.map((p) => [p.id, p]));
    expect(byId.get(first.id).url).toBe(`/photos/${first.filename}`);
    expect(byId.get(second.id).url).toBe(`/photos/${second.filename}`);
  });

  it('PUT primary response carries the url field', async () => {
    const v = await makeVehicle(app);
    await uploadPhoto(app, v.id, { filename: 'a.png' });
    const second = (await uploadPhoto(app, v.id, { filename: 'b.png' })).body[0];

    const res = await request(app).put(`/api/photos/${second.id}/primary`);
    expect(res.status).toBe(200);
    expect(res.body.url).toBe(`/photos/${second.filename}`);
  });

  it('vehicles list exposes primary_photo_url alongside primary_photo, null when no photo', async () => {
    const bare = await makeVehicle(app, { make: 'Bare' });
    const withPhoto = await makeVehicle(app, { make: 'Shot' });
    const primary = (await uploadPhoto(app, withPhoto.id, { filename: 'a.png' })).body[0];

    const res = await request(app).get('/api/vehicles');
    expect(res.status).toBe(200);
    const bareItem = res.body.find((x) => x.id === bare.id);
    const photoItem = res.body.find((x) => x.id === withPhoto.id);

    expect(bareItem.primary_photo).toBeNull();
    expect(bareItem.primary_photo_url).toBeNull();

    expect(photoItem.primary_photo).toBe(primary.filename);
    expect(photoItem.primary_photo_url).toBe(`/photos/${primary.filename}`);
  });
});

describe('vehicle delete cascade', () => {
  it('removes photo files from disk when the vehicle is deleted', async () => {
    const v = await makeVehicle(app);
    const p1 = (await uploadPhoto(app, v.id, { filename: 'a.png' })).body[0];
    const p2 = (await uploadPhoto(app, v.id, { filename: 'b.png' })).body[0];
    expect(fs.existsSync(photoPath(p1.filename))).toBe(true);
    expect(fs.existsSync(photoPath(p2.filename))).toBe(true);

    const del = await request(app).delete(`/api/vehicles/${v.id}`);
    expect(del.status).toBe(204);
    expect(fs.existsSync(photoPath(p1.filename))).toBe(false);
    expect(fs.existsSync(photoPath(p2.filename))).toBe(false);
  });
});
