import { migrate, pool, transaction } from "../db.js";
import { claimEvent, completeEvent, failEvent } from "../outbox.js";
import { sleep, startHealthServer } from "../worker-runtime.js";

const SERVICE = "matching-worker";
const status = { processed: 0, errors: 0, lastProcessedAt: null };
const eventTypes = ["offer.changed", "watch.changed", "store.changed", "catalogue.seeded"];

async function recomputeMatches() {
  return transaction(async (client) => {
    const { rows } = await client.query(`
      WITH inserted AS (
        INSERT INTO matches(profile_id,watch_id,offer_id,saving,reason)
        SELECT w.profile_id,w.id,o.id,round((o.list_price-o.price)::numeric,2),'canonical_product'
        FROM watch_items w
        JOIN profile_stores ps ON ps.profile_id=w.profile_id AND ps.selected=true
        JOIN offers o ON o.store_id=ps.store_id AND o.product_id=w.product_id
        WHERE w.active=true AND o.status='approved'
          AND (o.valid_from IS NULL OR o.valid_from <= CURRENT_DATE)
          AND (o.valid_until IS NULL OR o.valid_until >= CURRENT_DATE)
          AND o.list_price IS NOT NULL AND (o.list_price-o.price) >= w.min_saving
        ON CONFLICT(watch_id,offer_id) DO NOTHING
        RETURNING id,profile_id,watch_id,offer_id,saving,reason
      )
      INSERT INTO outbox_events(event_type,aggregate_type,aggregate_id,payload)
      SELECT 'match.created','match',id::text,jsonb_build_object('matchId',id,'profileId',profile_id,'watchId',watch_id,'offerId',offer_id,'saving',saving,'reason',reason)
      FROM inserted RETURNING id
    `);
    return rows.length;
  });
}

async function run() {
  await migrate();
  startHealthServer(SERVICE, status);
  console.log(JSON.stringify({ level: "info", service: SERVICE, message: "event loop started" }));
  while (true) {
    const event = await claimEvent(eventTypes);
    if (!event) { await sleep(750); continue; }
    try {
      const created = await recomputeMatches();
      await completeEvent(event.id);
      status.processed += 1;
      status.lastProcessedAt = new Date().toISOString();
      console.log(JSON.stringify({ level: "info", service: SERVICE, eventId: event.id, eventType: event.event_type, matchesCreated: created }));
    } catch (error) {
      status.errors += 1;
      await failEvent(event, error);
      console.error(JSON.stringify({ level: "error", service: SERVICE, eventId: event.id, message: error.message }));
    }
  }
}

run().catch((error) => { console.error(JSON.stringify({ level: "fatal", service: SERVICE, message: error.message })); process.exit(1); });
