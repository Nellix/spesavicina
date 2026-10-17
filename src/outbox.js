import { pool } from "./db.js";

export async function claimEvent(eventTypes) {
  const { rows } = await pool.query(`
    UPDATE outbox_events SET locked_at=now(),attempts=attempts+1
    WHERE id=(
      SELECT id FROM outbox_events
      WHERE processed_at IS NULL AND event_type=ANY($1::text[]) AND available_at <= now()
        AND (locked_at IS NULL OR locked_at < now() - interval '5 minutes')
      ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1
    )
    RETURNING *
  `, [eventTypes]);
  return rows[0] ?? null;
}

export async function completeEvent(id) {
  await pool.query(`UPDATE outbox_events SET processed_at=now(),locked_at=NULL,last_error=NULL WHERE id=$1`, [id]);
}

export async function failEvent(event, error) {
  const delaySeconds = Math.min(300, 2 ** Math.min(event.attempts, 8));
  await pool.query(`UPDATE outbox_events SET locked_at=NULL,last_error=$1,available_at=now()+($2::text || ' seconds')::interval WHERE id=$3`, [error.message.slice(0, 1000), delaySeconds, event.id]);
}
