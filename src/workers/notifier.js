import { migrate, pool } from "../db.js";
import { claimEvent, completeEvent, failEvent } from "../outbox.js";
import { sleep, startHealthServer } from "../worker-runtime.js";

const SERVICE = "notification-worker";
const status = { processed: 0, errors: 0, lastProcessedAt: null };

async function createInAppNotification(event) {
  const matchId = Number(event.payload.matchId ?? event.aggregate_id);
  const result = await pool.query(`
    INSERT INTO notifications(profile_id,match_id,channel)
    SELECT profile_id,id,'in_app' FROM matches WHERE id=$1
    ON CONFLICT(match_id) DO NOTHING RETURNING id
  `, [matchId]);
  return result.rowCount;
}

async function run() {
  await migrate();
  startHealthServer(SERVICE, status);
  console.log(JSON.stringify({ level: "info", service: SERVICE, message: "event loop started", channel: "in_app" }));
  while (true) {
    const event = await claimEvent(["match.created"]);
    if (!event) { await sleep(750); continue; }
    try {
      const created = await createInAppNotification(event);
      await completeEvent(event.id);
      status.processed += 1;
      status.lastProcessedAt = new Date().toISOString();
      console.log(JSON.stringify({ level: "info", service: SERVICE, eventId: event.id, notificationCreated: created }));
    } catch (error) {
      status.errors += 1;
      await failEvent(event, error);
      console.error(JSON.stringify({ level: "error", service: SERVICE, eventId: event.id, message: error.message }));
    }
  }
}

run().catch((error) => { console.error(JSON.stringify({ level: "fatal", service: SERVICE, message: error.message })); process.exit(1); });
