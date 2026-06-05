import { CloudWatchClient, GetMetricDataCommand } from "@aws-sdk/client-cloudwatch";
import { S3Client, ListBucketsCommand, GetBucketLocationCommand } from "@aws-sdk/client-s3";
import { upsertS3Daily } from "./s3-db.js";
import { query } from "./db.js";
import { loadAccountsConfig } from "./config.js";

const STORAGE_TYPES = [
  "StandardStorage",
  "IntelligentTieringFAStorage",
  "IntelligentTieringIAStorage",
  "IntelligentTieringAAStorage",
  "GlacierInstantRetrievalStorage",
  "GlacierStorage",
  "StandardIAStorage",
  "OneZoneIAStorage",
  // Deep Archive classes were previously omitted which caused buckets fully stored in
  // Glacier Deep Archive to report near-zero usage when building the cached time series.
  // Requesting these metrics ensures we persist the correct byte counts for those buckets.
  "DeepArchiveStorage",
  "DeepArchiveStagingStorage",
  "DeepArchiveObjectOverhead",
  "DeepArchiveS3ObjectOverhead"
];

function parseArgs(argv){
  const out = { from: null, to: null };
  for (let i=0;i<argv.length;i++){
    const a = argv[i];
    if (a==="--from") out.from = argv[++i];
    else if (a==="--to") out.to = argv[++i];
  }
  if (!out.from || !out.to) throw new Error("Usage: node src/ingest-s3-range.js --from YYYY-MM-DD --to YYYY-MM-DD");
  return out;
}

function dateDay(s){ const d = new Date(s+"T00:00:00Z"); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())); }

function makeCredentials(acct){
  if (acct && acct.accessKeyId && acct.secretAccessKey){
    return { accessKeyId: acct.accessKeyId, secretAccessKey: acct.secretAccessKey, sessionToken: acct.sessionToken||undefined };
  }
  return undefined;
}

function buildExcludedSet(config = {}){
  const fromEnv = String(process.env.INGEST_EXCLUDE_ACCOUNTS || process.env.INGEST_SKIP_ACCOUNTS || "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);
  const fromConfig = Array.isArray(config?.excludeAccounts)
    ? config.excludeAccounts.map(v => String(v).trim()).filter(Boolean)
    : [];
  return new Set([...fromEnv, ...fromConfig]);
}

async function loadAccounts(){
  const accountsConfig = loadAccountsConfig();
  const excluded = buildExcludedSet(accountsConfig);

  // Prefer DB accounts (organizations) if available, else fall back to static config if present
  try {
    const rows = await query("select account_id::text as account_id from accounts where active is true");
    if (rows?.rows?.length) {
      return { accounts: rows.rows.map(r=>({ accountId: r.account_id })), excluded };
    }
  } catch {}

  const staticAccounts = Array.isArray(accountsConfig?.static)
    ? accountsConfig.static
    : [];
  if (staticAccounts.length){
    const mapped = staticAccounts.map(a => ({
      accountId: a.accountId,
      accessKeyId: a.accessKeyId,
      secretAccessKey: a.secretAccessKey,
      sessionToken: a.sessionToken
    }));
    return { accounts: mapped, excluded };
  }

  throw new Error("No accounts found (db or accounts-config.json)");
}

async function resolveBucketRegion({ s3, bucket }){
  try {
    const out = await s3.send(new GetBucketLocationCommand({ Bucket: bucket }));
    return out.LocationConstraint || "us-east-1";
  } catch { return "us-east-1"; }
}

function buildQueries(bucket){
  const queries = [];
  let id=1;
  for (const st of STORAGE_TYPES){
    queries.push({
      Id: `m${id++}`,
      Label: `BucketSizeBytes ${st}`,
      MetricStat: {
        Metric: { Namespace: "AWS/S3", MetricName: "BucketSizeBytes",
          Dimensions: [{ Name: "BucketName", Value: bucket }, { Name: "StorageType", Value: st }] },
        Period: 86400, Stat: "Average"
      },
      ReturnData: true
    });
  }
  queries.push({
    Id: `m${id++}`,
    Label: "NumberOfObjects AllStorageTypes",
    MetricStat: {
      Metric: { Namespace: "AWS/S3", MetricName: "NumberOfObjects",
        Dimensions: [{ Name: "BucketName", Value: bucket }, { Name: "StorageType", Value: "AllStorageTypes" }] },
      Period: 86400, Stat: "Average"
    },
    ReturnData: true
  });
  return queries;
}

function indexByDay(results){
  const map = new Map();
  for (const r of (results||[])){
    const ts = r.Timestamps||[];
    const vals = r.Values||[];
    for (let i=0;i<Math.min(ts.length, vals.length);i++){
      const day = new Date(ts[i]); day.setUTCHours(0,0,0,0);
      const key = day.toISOString().slice(0,10);
      let row = map.get(key); if (!row) { row = { classes:{}, objects:0 }; map.set(key,row); }
      if ((r.Label||"").startsWith("BucketSizeBytes ")) {
        const klass = r.Label.split(" ")[1]; row.classes[klass] = Number(vals[i]||0);
      } else if (r.Label==="NumberOfObjects AllStorageTypes") {
        row.objects = Number(vals[i]||0);
      }
    }
  }
  return map;
}

async function run(){
  const { from, to } = parseArgs(process.argv.slice(2));
  const start = dateDay(from);
  const end = dateDay(to);
  const { accounts: allAccounts, excluded } = await loadAccounts();
  const accounts = allAccounts.filter(acct => !excluded.has(String(acct.accountId||"")));
  if (excluded.size && accounts.length !== allAccounts.length){
    const skipped = allAccounts.length - accounts.length;
    console.log(`[S3 RANGE] Skipping ${skipped} account(s) due to configured exclusions.`);
  }
  if (!accounts.length){
    console.log("[S3 RANGE] No eligible accounts after applying exclusions.");
    return;
  }

  for (const acct of accounts){
    const s3 = new S3Client({ region: "us-east-1", credentials: makeCredentials(acct) });
    const list = await s3.send(new ListBucketsCommand({}));
    const buckets = (list.Buckets||[]).map(b=>b.Name).filter(Boolean);

    // Resolve bucket region per bucket
    const bucketRegion = new Map();
    for (const b of buckets){
      bucketRegion.set(b, await resolveBucketRegion({ s3, bucket: b }));
    }

    for (const b of buckets){
      const region = bucketRegion.get(b)||"us-east-1";
      const cw = new CloudWatchClient({ region, credentials: makeCredentials(acct) });
      const out = await cw.send(new GetMetricDataCommand({
        StartTime: start,
        EndTime: new Date(end.getTime()+86399000),
        MetricDataQueries: buildQueries(b)
      }));
      const map = indexByDay(out.MetricDataResults);
      for (const [day, row] of map.entries()){
        const bytesTotal = Object.values(row.classes).reduce((a,v)=>a+Number(v||0), 0);
        await upsertS3Daily({
          accountId: acct.accountId, region, bucket: b, day,
          bytesTotal, bytesByClass: row.classes, objectsTotal: row.objects||0
        });
      }
      console.log(`[S3 RANGE] ${acct.accountId} ${region} ${b} -> ${map.size} days`);
    }
  }
}
run().catch(e=>{ console.error(e); process.exit(1); });
