import { pool, query } from "./db.js";

let schemaReady = false;

async function ensureCacheSchema() {
  if (schemaReady) return;
  await query(`
    create table if not exists aws_api_cache (
      cache_key text primary key,
      payload jsonb not null,
      fetched_at timestamptz not null default now(),
      expires_at timestamptz not null,
      updated_at timestamptz not null default now()
    );
    create index if not exists idx_aws_api_cache_expires_at on aws_api_cache (expires_at);
  `);
  schemaReady = true;
}

function parseTtlSeconds(value, fallback = 21600) {
  const n = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}

function isExpired(expiresAt, now = Date.now()) {
  const t = Date.parse(String(expiresAt || ""));
  return !Number.isFinite(t) || t <= now;
}

async function readEntry(cacheKey) {
  const { rows } = await query(
    `select payload, fetched_at, expires_at
       from aws_api_cache
      where cache_key = $1`,
    [cacheKey]
  );
  return rows?.[0] || null;
}

async function upsertEntry(client, cacheKey, payload, ttlSeconds) {
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
  const { rows } = await client.query(
    `insert into aws_api_cache (cache_key, payload, fetched_at, expires_at, updated_at)
     values ($1, $2::jsonb, now(), $3::timestamptz, now())
     on conflict (cache_key)
     do update set payload = excluded.payload,
                   fetched_at = now(),
                   expires_at = excluded.expires_at,
                   updated_at = now()
     returning fetched_at, expires_at`,
    [cacheKey, JSON.stringify(payload), expiresAt]
  );
  return rows?.[0] || { fetched_at: new Date().toISOString(), expires_at: expiresAt };
}

export async function getOrSetAwsCache({
  cacheKey,
  ttlSeconds = 21600,
  forceRefresh = false,
  fetcher
}) {
  if (typeof fetcher !== "function") {
    throw new Error("getOrSetAwsCache requires a fetcher function");
  }
  const key = String(cacheKey || "").trim();
  if (!key) {
    throw new Error("getOrSetAwsCache requires a non-empty cacheKey");
  }
  await ensureCacheSchema();

  const ttl = parseTtlSeconds(ttlSeconds, 21600);
  if (!forceRefresh) {
    const hit = await readEntry(key);
    if (hit && !isExpired(hit.expires_at)) {
      return {
        value: hit.payload,
        meta: {
          cache: "hit",
          fetchedAt: hit.fetched_at,
          expiresAt: hit.expires_at
        }
      };
    }
  }

  const client = await pool.connect();
  try {
    await client.query("select pg_advisory_lock(hashtext($1))", [key]);
    if (!forceRefresh) {
      const lockedRead = await client.query(
        `select payload, fetched_at, expires_at
           from aws_api_cache
          where cache_key = $1`,
        [key]
      );
      const row = lockedRead.rows?.[0];
      if (row && !isExpired(row.expires_at)) {
        return {
          value: row.payload,
          meta: {
            cache: "hit_after_lock",
            fetchedAt: row.fetched_at,
            expiresAt: row.expires_at
          }
        };
      }
    }

    const freshValue = await fetcher();
    const saved = await upsertEntry(client, key, freshValue, ttl);
    return {
      value: freshValue,
      meta: {
        cache: "miss_refresh",
        fetchedAt: saved.fetched_at,
        expiresAt: saved.expires_at
      }
    };
  } finally {
    try {
      await client.query("select pg_advisory_unlock(hashtext($1))", [key]);
    } catch {
      // no-op on unlock errors; connection is released immediately after
    }
    client.release();
  }
}

export async function purgeExpiredAwsCache() {
  await ensureCacheSchema();
  await query("delete from aws_api_cache where expires_at <= now()");
}
