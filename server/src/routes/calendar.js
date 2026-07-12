import { asyncHandler, vehicleName } from '../helpers.js';
import { labelFor } from '../serviceTypes.js';
import { addDays } from '../dates.js';
import { vehicleReminders } from '../reminderStatus.js';

// RFC 5545 TEXT escaping: backslash first, then ; , and finally newlines → \n.
function escapeText(value) {
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

// RFC 5545 line folding: split content lines longer than 75 octets, continuing
// with a leading space. Char-based (adequate for the mostly-ASCII content here).
function foldLine(line) {
  if (line.length <= 74) return line;
  const out = [line.slice(0, 74)];
  let i = 74;
  while (i < line.length) {
    out.push(' ' + line.slice(i, i + 73));
    i += 73;
  }
  return out.join('\r\n');
}

function icsDateTimeUTC(d) {
  const p = (n) => String(n).padStart(2, '0');
  return (
    `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`
  );
}

const icsDate = (ymd) => ymd.replace(/-/g, '');

// GET /calendar.ics — an all-day VEVENT for every reminder (belonging to the
// token's owner) that has a computable next_due_date. Per-user token-gated: the
// high-entropy calendar_token identifies the user via the indexed users column
// (cookies aren't usable by calendar subscribers). Only that user's vehicles emit
// events; an unknown/missing token is a 401.
export function calendarHandler(ctx) {
  return asyncHandler(async (req, res) => {
    const db = ctx.db;
    const token = req.query.token;
    const user =
      typeof token === 'string' && token
        ? await db.get('SELECT id FROM users WHERE calendar_token = ?', [token])
        : undefined;
    if (!user) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const vehicles = await db.all('SELECT * FROM vehicles WHERE user_id = ? ORDER BY id ASC', [
      user.id,
    ]);
    const dtstamp = icsDateTimeUTC(new Date());

    const lines = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//CarMaint//Maintenance Reminders//EN',
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
    ];

    for (const vehicle of vehicles) {
      const reminders = await vehicleReminders(db, vehicle);
      const vname = vehicleName(vehicle);
      for (const r of reminders) {
        if (!r.next_due_date) continue;

        const label = labelFor(r.type);
        const summary = `${label} due — ${vname}`;

        const descParts = [];
        if (r.description) descParts.push(String(r.description));
        if (r.next_due_mileage != null) {
          descParts.push(
            `Due at ${r.next_due_mileage} mi (current ${vehicle.current_mileage} mi).`
          );
        }
        descParts.push(`Last ${label.toLowerCase()}: ${r.last_date ?? 'none'}.`);
        const description = descParts.join(' ');

        lines.push('BEGIN:VEVENT');
        lines.push(`UID:reminder-${r.id}@carmaint`);
        lines.push(`DTSTAMP:${dtstamp}`);
        lines.push(`DTSTART;VALUE=DATE:${icsDate(r.next_due_date)}`);
        lines.push(`DTEND;VALUE=DATE:${icsDate(addDays(r.next_due_date, 1))}`);
        lines.push(`SUMMARY:${escapeText(summary)}`);
        lines.push(`DESCRIPTION:${escapeText(description)}`);
        lines.push('END:VEVENT');
      }
    }

    lines.push('END:VCALENDAR');

    const body = lines.map(foldLine).join('\r\n') + '\r\n';
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.send(body);
  });
}
