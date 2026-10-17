import pg from "pg";

const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSLMODE && process.env.PGSSLMODE !== "disable"
    ? { rejectUnauthorized: process.env.PGSSL_REJECT_UNAUTHORIZED !== "false" }
    : false,
  max: Number(process.env.DB_POOL_SIZE ?? 10),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  application_name: process.env.SERVICE_NAME ?? "spesavicina",
});

pool.on("error", (error) => console.error(JSON.stringify({ level: "error", service: process.env.SERVICE_NAME, message: "postgres pool error", error: error.message })));

export async function transaction(callback) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

const migrations = [
  [1, `
    CREATE TABLE IF NOT EXISTS profiles (
      id BIGINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      name TEXT NOT NULL DEFAULT 'Nello',
      email TEXT NOT NULL DEFAULT 'demo@spesavicina.local',
      postcode TEXT NOT NULL DEFAULT '10153',
      address TEXT NOT NULL DEFAULT 'Corso Belgio 74, Torino',
      default_min_saving NUMERIC(10,2) NOT NULL DEFAULT 1 CHECK (default_min_saving >= 0),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS stores (
      id TEXT PRIMARY KEY,
      retailer TEXT NOT NULL,
      name TEXT NOT NULL,
      address TEXT NOT NULL,
      latitude DOUBLE PRECISION NOT NULL,
      longitude DOUBLE PRECISION NOT NULL,
      distance_km NUMERIC(8,2) NOT NULL,
      source_type TEXT NOT NULL,
      enabled BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS profile_stores (
      profile_id BIGINT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
      store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
      selected BOOLEAN NOT NULL DEFAULT true,
      PRIMARY KEY (profile_id, store_id)
    );
    CREATE TABLE IF NOT EXISTS products (
      id TEXT PRIMARY KEY,
      brand TEXT NOT NULL,
      product_name TEXT NOT NULL,
      variant TEXT NOT NULL DEFAULT '',
      pack_size TEXT NOT NULL DEFAULT '',
      category TEXT NOT NULL DEFAULT '',
      search_text TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','merged','retired')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS product_aliases (
      id BIGSERIAL PRIMARY KEY,
      product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      alias TEXT NOT NULL,
      normalized_alias TEXT NOT NULL UNIQUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS product_identifiers (
      id BIGSERIAL PRIMARY KEY,
      product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      scheme TEXT NOT NULL CHECK (scheme IN ('gtin','ean','retailer_sku')),
      retailer TEXT NOT NULL DEFAULT '',
      value TEXT NOT NULL,
      UNIQUE (scheme, retailer, value)
    );
    CREATE TABLE IF NOT EXISTS watch_items (
      id BIGSERIAL PRIMARY KEY,
      profile_id BIGINT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
      product_id TEXT NOT NULL REFERENCES products(id),
      min_saving NUMERIC(10,2) NOT NULL DEFAULT 1 CHECK (min_saving >= 0),
      active BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (profile_id, product_id)
    );
    CREATE TABLE IF NOT EXISTS offers (
      id BIGSERIAL PRIMARY KEY,
      source_id TEXT NOT NULL,
      retailer TEXT NOT NULL,
      store_id TEXT NOT NULL REFERENCES stores(id),
      product_id TEXT REFERENCES products(id),
      product_name TEXT NOT NULL,
      brand TEXT NOT NULL,
      variant TEXT NOT NULL DEFAULT '',
      pack_size TEXT NOT NULL DEFAULT '',
      price NUMERIC(10,2) NOT NULL CHECK (price >= 0),
      list_price NUMERIC(10,2),
      unit_price TEXT NOT NULL DEFAULT '',
      condition_text TEXT NOT NULL DEFAULT '',
      valid_from DATE,
      valid_until DATE,
      source_url TEXT NOT NULL,
      source_evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
      confidence NUMERIC(4,3) NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
      status TEXT NOT NULL CHECK(status IN ('approved','review','rejected','expired')),
      first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (retailer, source_id)
    );
    CREATE TABLE IF NOT EXISTS matches (
      id BIGSERIAL PRIMARY KEY,
      profile_id BIGINT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
      watch_id BIGINT NOT NULL REFERENCES watch_items(id) ON DELETE CASCADE,
      offer_id BIGINT NOT NULL REFERENCES offers(id) ON DELETE CASCADE,
      saving NUMERIC(10,2) NOT NULL,
      reason TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (watch_id, offer_id)
    );
    CREATE TABLE IF NOT EXISTS notifications (
      id BIGSERIAL PRIMARY KEY,
      profile_id BIGINT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
      match_id BIGINT NOT NULL UNIQUE REFERENCES matches(id) ON DELETE CASCADE,
      channel TEXT NOT NULL DEFAULT 'in_app' CHECK(channel = 'in_app'),
      read_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS feedback (
      id BIGSERIAL PRIMARY KEY,
      profile_id BIGINT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
      notification_id BIGINT NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
      value TEXT NOT NULL CHECK(value IN ('useful','not_useful','bought')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (profile_id, notification_id)
    );
    CREATE TABLE IF NOT EXISTS ingestion_runs (
      id BIGSERIAL PRIMARY KEY,
      source TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('running','success','failed')),
      offers_found INTEGER NOT NULL DEFAULT 0,
      review_count INTEGER NOT NULL DEFAULT 0,
      message TEXT NOT NULL DEFAULT '',
      diagnostics JSONB NOT NULL DEFAULT '[]'::jsonb,
      started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      finished_at TIMESTAMPTZ
    );
    CREATE TABLE IF NOT EXISTS outbox_events (
      id BIGSERIAL PRIMARY KEY,
      event_type TEXT NOT NULL,
      aggregate_type TEXT NOT NULL,
      aggregate_id TEXT NOT NULL,
      payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      locked_at TIMESTAMPTZ,
      processed_at TIMESTAMPTZ,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_outbox_pending ON outbox_events (event_type, available_at, id) WHERE processed_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_offers_active ON offers (store_id, product_id, valid_until) WHERE status = 'approved';
    CREATE INDEX IF NOT EXISTS idx_matches_profile ON matches (profile_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_notifications_profile ON notifications (profile_id, created_at DESC);
  `],
  [2, `
    ALTER TABLE profiles ADD COLUMN IF NOT EXISTS latitude DOUBLE PRECISION;
    ALTER TABLE profiles ADD COLUMN IF NOT EXISTS longitude DOUBLE PRECISION;
    ALTER TABLE profiles ADD COLUMN IF NOT EXISTS location_accuracy DOUBLE PRECISION;
    ALTER TABLE profiles ADD COLUMN IF NOT EXISTS geolocated_at TIMESTAMPTZ;

    ALTER TABLE stores ADD COLUMN IF NOT EXISTS external_id TEXT;
    ALTER TABLE stores ADD COLUMN IF NOT EXISTS logo_key TEXT NOT NULL DEFAULT 'market';
    ALTER TABLE stores ADD COLUMN IF NOT EXISTS source_url TEXT;
    ALTER TABLE stores ADD COLUMN IF NOT EXISTS discovered_at TIMESTAMPTZ;
    ALTER TABLE stores ADD COLUMN IF NOT EXISTS offers_last_analyzed_at TIMESTAMPTZ;
    ALTER TABLE stores ADD COLUMN IF NOT EXISTS analysis_status TEXT NOT NULL DEFAULT 'not_started'
      CHECK (analysis_status IN ('not_started','queued','running','ready','failed','unsupported'));
    CREATE UNIQUE INDEX IF NOT EXISTS idx_stores_external_id ON stores(external_id) WHERE external_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS store_analysis_jobs (
      id BIGSERIAL PRIMARY KEY,
      profile_id BIGINT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
      store_id TEXT REFERENCES stores(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK(kind IN ('nearby_discovery','offer_analysis')),
      status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','completed','failed')),
      request JSONB NOT NULL DEFAULT '{}'::jsonb,
      result JSONB NOT NULL DEFAULT '{}'::jsonb,
      error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      started_at TIMESTAMPTZ,
      finished_at TIMESTAMPTZ
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_analysis_one_active
      ON store_analysis_jobs(profile_id,kind,COALESCE(store_id,'')) WHERE status IN ('queued','running');
    CREATE INDEX IF NOT EXISTS idx_analysis_recent ON store_analysis_jobs(profile_id,created_at DESC);

    CREATE TABLE IF NOT EXISTS service_notifications (
      id BIGSERIAL PRIMARY KEY,
      profile_id BIGINT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      message TEXT NOT NULL,
      data JSONB NOT NULL DEFAULT '{}'::jsonb,
      read_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_service_notifications_profile ON service_notifications(profile_id,created_at DESC);
  `],
  [3, `
    ALTER TABLE profiles ADD COLUMN IF NOT EXISTS discovery_radius_km NUMERIC(4,1) NOT NULL DEFAULT 3.0
      CHECK (discovery_radius_km >= 0.5 AND discovery_radius_km <= 25);
  `],
  [4, `
    ALTER TABLE profiles DROP CONSTRAINT IF EXISTS profiles_id_check;
    CREATE SEQUENCE IF NOT EXISTS profiles_id_seq;
    SELECT setval('profiles_id_seq', GREATEST((SELECT COALESCE(MAX(id),1) FROM profiles),1), true);
    ALTER SEQUENCE profiles_id_seq OWNED BY profiles.id;
    ALTER TABLE profiles ALTER COLUMN id SET DEFAULT nextval('profiles_id_seq');
    ALTER TABLE profiles ALTER COLUMN name DROP DEFAULT;
    ALTER TABLE profiles ALTER COLUMN email DROP DEFAULT;
    ALTER TABLE profiles ALTER COLUMN postcode SET DEFAULT '';
    ALTER TABLE profiles ALTER COLUMN address SET DEFAULT '';
    ALTER TABLE profiles ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT false;
    UPDATE profiles SET is_admin=true WHERE id=1;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_profiles_email_unique ON profiles(lower(email));

    CREATE TABLE IF NOT EXISTS password_credentials (
      profile_id BIGINT PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
      password_digest TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS auth_identities (
      id BIGSERIAL PRIMARY KEY,
      profile_id BIGINT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
      provider TEXT NOT NULL CHECK(provider IN ('google')),
      subject TEXT NOT NULL,
      email TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_login_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(provider,subject)
    );
    CREATE INDEX IF NOT EXISTS idx_auth_identities_profile ON auth_identities(profile_id);

    CREATE TABLE IF NOT EXISTS auth_sessions (
      id BIGSERIAL PRIMARY KEY,
      profile_id BIGINT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      user_agent TEXT NOT NULL DEFAULT '',
      expires_at TIMESTAMPTZ NOT NULL,
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      revoked_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_auth_sessions_active ON auth_sessions(token_hash,expires_at) WHERE revoked_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_auth_sessions_profile ON auth_sessions(profile_id,created_at DESC);

    CREATE TABLE IF NOT EXISTS oauth_login_attempts (
      state_hash TEXT PRIMARY KEY,
      nonce TEXT NOT NULL,
      code_verifier TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `],
  [5, `
    ALTER TABLE profile_stores ADD COLUMN IF NOT EXISTS distance_km NUMERIC(8,2);
    UPDATE profile_stores ps SET distance_km=s.distance_km FROM stores s WHERE s.id=ps.store_id AND ps.distance_km IS NULL;
  `],
  [6, `
    SELECT 1;
  `],
  [7, `
    DELETE FROM offers WHERE lower(retailer)='amazon' OR store_id='amazon-it-online';
    DELETE FROM stores WHERE id='amazon-it-online' OR lower(retailer)='amazon';
  `],
];

export async function migrate() {
  await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  await transaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(74192026)");
    for (const [version, sql] of migrations) {
      const exists = await client.query("SELECT 1 FROM schema_migrations WHERE version=$1", [version]);
      if (exists.rowCount) continue;
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations(version) VALUES ($1)", [version]);
    }
  });
}

export async function closePool() {
  await pool.end();
}
