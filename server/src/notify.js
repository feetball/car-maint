import { labelFor } from './serviceTypes.js';
import { dueReminders } from './reminderStatus.js';

// Splits the aggregated due list (reuse of the reminder-status logic) into the
// two buckets the notification body renders. Each item already carries
// vehicle_name and the computed next_due_* fields.
export async function collectDue(db) {
  const due = await dueReminders(db);
  return {
    overdue: due.filter((r) => r.status === 'overdue'),
    due_soon: due.filter((r) => r.status === 'due_soon'),
  };
}

function formatItem(item) {
  const bits = [`${labelFor(item.type)} — ${item.vehicle_name}`];
  if (item.next_due_date) bits.push(`by ${item.next_due_date}`);
  if (item.next_due_mileage != null) bits.push(`at ${item.next_due_mileage} mi`);
  return bits.join(' ');
}

function buildBody(overdue, due_soon) {
  const lines = [];
  if (overdue.length) {
    lines.push('Overdue:');
    for (const it of overdue) lines.push(`- ${formatItem(it)}`);
  }
  if (due_soon.length) {
    if (lines.length) lines.push('');
    lines.push('Due soon:');
    for (const it of due_soon) lines.push(`- ${formatItem(it)}`);
  }
  return lines.join('\n');
}

// Posts due-reminder notifications to the configured targets. No-op (nothing
// sent) when nothing is due. ntfy gets plain text with a Title header; the
// webhook gets JSON { title, body, overdue, due_soon }. fetchImpl is injectable
// for tests; each target is best-effort and isolated from the other.
export async function sendNotifications(cfg, due, fetchImpl = fetch) {
  const overdue = due?.overdue ?? [];
  const due_soon = due?.due_soon ?? [];
  const total = overdue.length + due_soon.length;

  const summary = {
    overdue: overdue.length,
    due_soon: due_soon.length,
    ntfy: false,
    webhook: false,
    sent: false,
  };
  if (total === 0) return summary;

  const title = `CarMaint: ${total} maintenance reminder${total === 1 ? '' : 's'} due`;
  const body = buildBody(overdue, due_soon);

  if (cfg?.ntfyUrl) {
    try {
      const resp = await fetchImpl(cfg.ntfyUrl, {
        method: 'POST',
        headers: { Title: title, 'Content-Type': 'text/plain; charset=utf-8' },
        body,
      });
      summary.ntfy = !resp || resp.ok !== false;
    } catch {
      summary.ntfy = false;
    }
  }

  if (cfg?.notifyWebhookUrl) {
    try {
      const resp = await fetchImpl(cfg.notifyWebhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, body, overdue, due_soon }),
      });
      summary.webhook = !resp || resp.ok !== false;
    } catch {
      summary.webhook = false;
    }
  }

  summary.sent = summary.ntfy || summary.webhook;
  return summary;
}

// Convenience wrapper used by the index.js timer and the cron/notify route:
// collect what is due and dispatch it.
export async function runNotify(ctx, fetchImpl = fetch) {
  const due = await collectDue(ctx.db);
  return sendNotifications(ctx.config, due, fetchImpl);
}
