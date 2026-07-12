import { Router } from 'express';
import { asyncHandler, badRequest, notFound, HttpError } from '../helpers.js';

// Admin router — every route is behind an admin SESSION (auth.requireAdminSession):
// a valid cookie whose user has is_admin=1. Non-admin sessions get 403, missing
// sessions 401 (the latter is normally produced by the global auth gate before this
// router even runs). Admin powers are cross-account and live ONLY here; is_admin does
// NOT widen any per-user route (/api/vehicles etc. still scope by req.user.id).
//
// Cross-driver note: user deletion removes the account's whole vehicle tree with
// EXPLICIT deletes inside one transaction rather than relying on FK ON DELETE CASCADE,
// because the two drivers differ on FK enforcement (better-sqlite3 sets
// foreign_keys=ON; the libsql facade does not) — mirroring routes/vehicles.js.
export function adminRouter(ctx) {
  const router = Router();
  const db = ctx.db;

  // Guard ONLY the /admin/* subtree. This router is mounted at /api, so it also sees
  // unrelated /api requests (e.g. /api/vehicles, /api/cron/*) that fall through to
  // later routers — scoping the guard to /admin lets those pass untouched instead of
  // being 403'd/401'd here.
  router.use('/admin', ctx.auth.requireAdminSession);

  const loadUser = async (id) => db.get('SELECT * FROM users WHERE id = ?', [id]);

  // --- USER MANAGEMENT -----------------------------------------------------

  // GET /api/admin/users → every account with its vehicle count. is_admin is a real
  // boolean in the response.
  router.get(
    '/admin/users',
    asyncHandler(async (req, res) => {
      const rows = await db.all(
        `SELECT u.id, u.username, u.is_admin, u.created_at,
           (SELECT COUNT(*) FROM vehicles v WHERE v.user_id = u.id) AS vehicle_count
         FROM users u
         ORDER BY u.id ASC`
      );
      res.json(
        rows.map((r) => ({
          id: r.id,
          username: r.username,
          is_admin: !!r.is_admin,
          created_at: r.created_at,
          vehicle_count: r.vehicle_count,
        }))
      );
    })
  );

  // POST /api/admin/users/:id/admin { is_admin: bool } → promote/demote.
  router.post(
    '/admin/users/:id/admin',
    asyncHandler(async (req, res) => {
      const id = Number(req.params.id);
      if (!Number.isInteger(id)) throw badRequest('invalid user id');
      const desired = req.body?.is_admin;
      if (typeof desired !== 'boolean') throw badRequest('is_admin must be a boolean');

      if (desired) {
        // Promotion has no lockout concern. A single guarded UPDATE: changes===0 means
        // no such row (SQLite/libsql count a matched row as changed even when the value
        // is unchanged, so an already-admin still yields changes===1).
        const info = await db.run('UPDATE users SET is_admin = 1 WHERE id = ?', [id]);
        if (info.changes === 0) throw notFound('User not found');
      } else {
        // Demotion is the lockout-sensitive path. Fold the last-admin check INTO the
        // UPDATE so the count and the write are one atomic statement — this closes the
        // check-then-update TOCTOU where two concurrent demotes could both pass a
        // separate count() and drop admins to zero. The write only lands while MORE THAN
        // ONE admin remains; the losing racer sees changes===0 and is rejected below.
        const info = await db.run(
          'UPDATE users SET is_admin = 0 WHERE id = ? AND (SELECT COUNT(*) FROM users WHERE is_admin = 1) > 1',
          [id]
        );
        if (info.changes === 0) {
          // No row changed — disambiguate the reasons with one follow-up read:
          //   - no such user            → 404
          //   - user is still an admin  → the count guard blocked it, i.e. the last
          //                               remaining admin → 409 (lockout)
          //   - user is already non-admin → desired state already holds → no-op success
          const row = await loadUser(id);
          if (!row) throw notFound('User not found');
          if (row.is_admin) throw new HttpError(409, 'cannot demote the last remaining admin');
        }
      }

      // Re-read the row so the response reflects the actual persisted state.
      const row = await loadUser(id);
      res.json({ id, username: row.username, is_admin: !!row.is_admin });
    })
  );

  // DELETE /api/admin/users/:id → delete the account, its whole vehicle tree, sessions,
  // and photo files. Refuses to remove the last remaining admin (409). Deleting your
  // OWN account is allowed (unless you are that last admin); your sessions are dropped
  // by this same delete, so your cookie is invalidated immediately afterward.
  router.delete(
    '/admin/users/:id',
    asyncHandler(async (req, res) => {
      const id = Number(req.params.id);
      if (!Number.isInteger(id)) throw badRequest('invalid user id');

      // One transaction: explicit child-before-parent deletes so behavior is identical
      // regardless of FK enforcement. The last-admin guard is folded into the PARENT
      // delete so the admin count and the write are atomic (no check-then-delete TOCTOU),
      // and it runs LAST — after the children are gone — so the FK-enforcing sqlite
      // driver (vehicles.user_id REFERENCES users(id), no cascade) doesn't reject it.
      // If the guard blocks (changes===0 → 404 or 409) we throw, rolling the whole
      // cascade back. Photo filenames are gathered inside the same tx (consistent
      // snapshot) and returned so the files are unlinked only after a committed delete.
      const photos = await db.tx(async (t) => {
        const rows = await t.all(
          `SELECT p.filename FROM photos p JOIN vehicles v ON v.id = p.vehicle_id
            WHERE v.user_id = ?`,
          [id]
        );
        await t.run('DELETE FROM photos WHERE vehicle_id IN (SELECT id FROM vehicles WHERE user_id = ?)', [id]);
        await t.run('DELETE FROM records WHERE vehicle_id IN (SELECT id FROM vehicles WHERE user_id = ?)', [id]);
        await t.run('DELETE FROM reminders WHERE vehicle_id IN (SELECT id FROM vehicles WHERE user_id = ?)', [id]);
        await t.run('DELETE FROM recalls_cache WHERE vehicle_id IN (SELECT id FROM vehicles WHERE user_id = ?)', [id]);
        await t.run('DELETE FROM vehicles WHERE user_id = ?', [id]);
        await t.run('DELETE FROM sessions WHERE user_id = ?', [id]);

        // Atomic last-admin guard: delete the user unless they are the sole admin.
        const del = await t.run(
          'DELETE FROM users WHERE id = ? AND NOT (is_admin = 1 AND (SELECT COUNT(*) FROM users WHERE is_admin = 1) <= 1)',
          [id]
        );
        if (del.changes === 0) {
          // changes===0 → distinguish with one follow-up read: gone/never-existed → 404,
          // still present (guard blocked) → the last remaining admin → 409.
          const row = await t.get('SELECT is_admin FROM users WHERE id = ?', [id]);
          if (!row) throw notFound('User not found');
          throw new HttpError(409, 'cannot delete the last remaining admin');
        }
        return rows;
      });

      for (const p of photos) {
        await ctx.store.delete(p.filename);
      }

      res.json({ deleted: true, id });
    })
  );

  // --- CROSS-ACCOUNT VEHICLE VIEW / ADOPTION -------------------------------

  // GET /api/admin/vehicles → every vehicle across all accounts, read-only, with the
  // owner's username (null for NULL-owned / orphaned legacy vehicles).
  router.get(
    '/admin/vehicles',
    asyncHandler(async (req, res) => {
      const rows = await db.all(
        `SELECT v.*, u.username AS owner_username
           FROM vehicles v
           LEFT JOIN users u ON u.id = v.user_id
          ORDER BY v.id ASC`
      );
      res.json(rows);
    })
  );

  // POST /api/admin/vehicles/:id/owner { user_id: number|null } → reassign a vehicle's
  // owner. Primary use is adopting a NULL-owned legacy vehicle onto a real account;
  // user_id:null hands a vehicle back to the unowned pool. Target user must exist.
  router.post(
    '/admin/vehicles/:id/owner',
    asyncHandler(async (req, res) => {
      const id = Number(req.params.id);
      if (!Number.isInteger(id)) throw badRequest('invalid vehicle id');

      const userId = req.body?.user_id;
      if (userId !== null && !Number.isInteger(userId)) {
        throw badRequest('user_id must be an integer or null');
      }

      const vehicle = await db.get('SELECT id FROM vehicles WHERE id = ?', [id]);
      if (!vehicle) throw notFound('Vehicle not found');

      if (userId !== null) {
        const owner = await loadUser(userId);
        if (!owner) throw notFound('User not found');
      }

      await db.run('UPDATE vehicles SET user_id = ? WHERE id = ?', [userId, id]);
      res.json(await db.get('SELECT * FROM vehicles WHERE id = ?', [id]));
    })
  );

  // POST /api/admin/vehicles/adopt-orphans { user_id } → bulk-assign EVERY currently
  // NULL-owned vehicle to one existing user. Convenience for migrating legacy data.
  router.post(
    '/admin/vehicles/adopt-orphans',
    asyncHandler(async (req, res) => {
      const userId = req.body?.user_id;
      if (!Number.isInteger(userId)) throw badRequest('user_id must be an integer');

      const owner = await loadUser(userId);
      if (!owner) throw notFound('User not found');

      const info = await db.run('UPDATE vehicles SET user_id = ? WHERE user_id IS NULL', [userId]);
      res.json({ adopted: info.changes, user_id: userId });
    })
  );

  return router;
}
