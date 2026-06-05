import { query } from "./db.js";

/** Upsert one daily record */
export async function upsertS3Daily({ accountId, region, bucket, day, bytesTotal, bytesByClass = {}, objectsTotal = 0 }){
  await query(
    `insert into s3_bucket_daily(account_id, region, bucket, day, bytes_total, bytes_by_class, objects_total)
     values($1,$2,$3,$4,$5,$6::jsonb,$7)
     on conflict (account_id, region, bucket, day)
     do update set bytes_total = excluded.bytes_total,
                   bytes_by_class = excluded.bytes_by_class,
                   objects_total = excluded.objects_total,
                   updated_at = now()`,
    [accountId, region, bucket, day, Number(bytesTotal||0), JSON.stringify(bytesByClass||{}), Number(objectsTotal||0)]
  );
}

/** Query a time series for a bucket between start and end (inclusive).
 *  If accountId is null/undefined, select across any account for this bucket+region.
 */
export async function getS3SeriesFromDb({ accountId=null, region, bucket, start, end }){
  const out = await query(
    `select day, bytes_total, bytes_by_class, objects_total
       from s3_bucket_daily
      where ($1::text is null or account_id=$1) and region=$2 and bucket=$3 and day >= $4 and day <= $5
      order by day asc`,
    [accountId??null, region, bucket, start, end]
  );
  return out.rows || [];
}

/** Latest snapshot for all buckets (most recent day present) */
export async function getS3LatestSnapshot({ accounts = [], regions = [] }){
  const accountIds = Array.from(new Set(accounts.map(a => {
    if (!a) return null;
    if (typeof a === "string") return a;
    if (typeof a === "object" && a.accountId) return String(a.accountId);
    return null;
  }).filter(Boolean)));

  const regionList = Array.from(new Set(regions.filter(Boolean)));

  const params = [];
  const filters = [];
  if (accountIds.length) {
    params.push(accountIds);
    filters.push(`account_id = ANY($${params.length}::text[])`);
  }
  if (regionList.length) {
    params.push(regionList);
    filters.push(`region = ANY($${params.length}::text[])`);
  }

  const whereClause = filters.length ? `where ${filters.join(" and ")}` : "";

  const out = await query(
    `with filtered as (
       select *
         from s3_bucket_daily
        ${whereClause}
     ),
     latest as (
       select account_id, region, bucket, max(day) as max_day
         from filtered
        group by account_id, region, bucket
     )
     select f.account_id, f.region, f.bucket, f.day, f.bytes_total, f.bytes_by_class, f.objects_total
       from filtered f
       join latest l on l.account_id=f.account_id and l.region=f.region and l.bucket=f.bucket and l.max_day = f.day
     order by f.bytes_total desc`,
    params
  );
  return out.rows || [];
}
