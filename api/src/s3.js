

import { PricingClient, GetProductsCommand } from "@aws-sdk/client-pricing";

/** Map region code -> Pricing "location" */
const REGION_TO_LOCATION = {
  "us-east-1": "US East (N. Virginia)",
  "us-east-2": "US East (Ohio)",
  "us-west-1": "US West (N. California)",
  "us-west-2": "US West (Oregon)",
  "eu-central-1": "EU (Frankfurt)",
  "eu-west-1": "EU (Ireland)",
  "eu-west-2": "EU (London)",
  "eu-west-3": "EU (Paris)",
  "eu-north-1": "EU (Stockholm)",
  "eu-south-1": "EU (Milan)",
  "ap-south-1": "Asia Pacific (Mumbai)",
  "ap-south-2": "Asia Pacific (Hyderabad)",
  "ap-southeast-1": "Asia Pacific (Singapore)",
  "ap-southeast-2": "Asia Pacific (Sydney)",
  "ap-southeast-3": "Asia Pacific (Jakarta)",
  "ap-northeast-1": "Asia Pacific (Tokyo)",
  "ap-northeast-2": "Asia Pacific (Seoul)",
  "ap-northeast-3": "Asia Pacific (Osaka)",
  "ca-central-1": "Canada (Central)",
  "sa-east-1": "South America (São Paulo)"
};
// --- Added in fix30: static fallback prices for EU (Paris) if AWS Pricing is empty ---

const STATIC_S3_PRICES = {
  "eu-west-3": {
    // Per-GB-month, first-tier public rates as of 2025-10-25 (source: aws.amazon.com/s3/pricing/).
    // NB: Does not include request/retrieval/automation charges.
    StandardStorage: 0.024,
    StandardIAStorage: 0.0131,
    OneZoneIAStorage: 0.01048,
    GlacierInstantRetrievalStorage: 0.005,
    GlacierStorage: 0.00405,
	DeepArchiveStorage: 0.0018,
	DeepArchiveStagingStorage: 0,      
	DeepArchiveObjectOverhead: 0,      
	DeepArchiveS3ObjectOverhead: 0,    
    IntelligentTieringFAStorage: 0.024,
    IntelligentTieringIAStorage: 0.0131,
    IntelligentTieringAIAStorage: 0.005,    // Archive Instant Access
    IntelligentTieringAAStorage: 0.00405,   // Archive Access
    IntelligentTieringDAAStorage: 0.0018,   // Deep Archive Access
    ExpressOneZoneStorage: 0                 // N/A published for Paris -> treated as 0
  }
};

const DATA_FROM = String(process.env.DATA_FROM || process.env.data_from || "LOCAL_DB").toUpperCase();
const AWS_LIVE_ENABLED = ["1", "true", "yes", "on"].includes(String(process.env.AWS_LIVE_ENABLED || process.env.ALLOW_AWS_LIVE || "").toLowerCase());
const S3_PRICING_LIVE_ALLOWED = AWS_LIVE_ENABLED && DATA_FROM !== "LOCAL_DB" && DATA_FROM !== "DB";

export function getStaticS3PricingTable(region) {
  const reg = String(region || "").trim();
  const prices = STATIC_S3_PRICES[reg] ? { ...STATIC_S3_PRICES[reg] } : {};
  return { currency: "USD", prices, source: "static" };
}


/** Heuristic mapping from StorageType -> string patterns to identify products */
const STORAGE_PATTERNS = {
  StandardStorage: [/Standard(?!-IA)/i],
  StandardIAStorage: [/Standard-IA|Infrequent Access(?!.*One Zone)/i],
  OneZoneIAStorage: [/One Zone-IA|One Zone Infrequent/i],
  GlacierInstantRetrievalStorage: [/Glacier Instant Retrieval|Glacier IR/i],
  GlacierStorage: [/Glacier \(Flexible Retrieval\)|Glacier Flexible Retrieval(?!.*Deep)/i],
  DeepArchiveStorage: [/Glacier Deep Archive|Deep Archive/i],
  IntelligentTieringFAStorage: [/Intelligent(-| )Tiering.*Frequent/i],
  IntelligentTieringIAStorage: [/Intelligent(-| )Tiering.*Infrequent/i],
  IntelligentTieringAAStorage: [/Intelligent(-| )Tiering.*Archive(?!.*Instant|.*Deep)/i],
  IntelligentTieringAIAStorage: [/Intelligent(-| )Tiering.*Archive.*Instant/i],
  IntelligentTieringDAAStorage: [/Intelligent(-| )Tiering.*Deep Archive/i],
  ExpressOneZoneStorage: [/Express One Zone/i],
  ReducedRedundancyStorage: [/Reduced Redundancy/i]
};

/** Fetch S3 storage $/GB-month per class for a region via Pricing.
 * Returns { currency: "USD", prices: { StorageType: pricePerGBMonth } }
 */
export async function getS3PricingTable(region){
  if (!S3_PRICING_LIVE_ALLOWED) {
    return getStaticS3PricingTable(region);
  }
  const location = REGION_TO_LOCATION[region] || REGION_TO_LOCATION["us-east-1"];
  const pricing = new PricingClient({ region: "us-east-1" });
  const prices = {};
  // We request many products and then filter heuristically.
  // Pricing API paginates via NextToken.
  let nextToken = undefined;
  do {
    const out = await pricing.send(new GetProductsCommand({
      ServiceCode: "AmazonS3",
      Filters: [
        { Type: "TERM_MATCH", Field: "productFamily", Value: "Storage" },
        { Type: "TERM_MATCH", Field: "location", Value: location }
      ],
      NextToken: nextToken
    }));
    for (const priceStr of (out.PriceList || [])){
      let p;
      try { p = JSON.parse(priceStr); } catch { continue; }
      const attrs = p?.product?.attributes || {};
      const family = p?.product?.productFamily || "";
      if (String(family).toLowerCase() !== "storage") continue;
      const usage = String(attrs.usagetype || "");
      const descr = String(attrs.storageClass || attrs.volumeType || attrs.group || attrs.description || "");
      const label = (usage + " " + descr).trim();
      // Skip overhead-like or replication
      if (/Requests|Select|Replication|Early|Retrieval|PUT|GET|Lifecycle/i.test(label)) continue;
      if (!/TimedStorage-ByteHrs/i.test(usage)) continue;

      // Identify a StorageType using patterns
      let st = null;
      for (const [k, regs] of Object.entries(STORAGE_PATTERNS)){
        if (regs.some(rx => rx.test(label))){
          st = k; break;
        }
      }
      if (!st) continue;

      // Retrieve pricePerGBMonth USD from OnDemand terms
      const terms = p?.terms?.OnDemand || {};
      for (const term of Object.values(terms)){
        const dims = term?.priceDimensions || {};
        for (const d of Object.values(dims)){
          const unit = d?.unit;
          const per = d?.pricePerUnit?.USD ? Number(d.pricePerUnit.USD) : null;
          const descr2 = String(d?.description || "");
          if (unit === "GB-Mo" || /GB-Mo/i.test(descr2) || /GB-Month/i.test(descr2)){
            if (!prices[st] || (per && per < prices[st])){
              prices[st] = per;
            }
          }
          // Some SKUs use ByteHrs; convert to GB-Mo ~ 30.44 * 24 hours (but safer to rely on GB-Mo lines only)
        }
      }
    }
    nextToken = out.NextToken;
  } while (nextToken);

  
  // fix30: fallback to static public rates when Pricing returns nothing
  if (!prices || Object.keys(prices).length === 0) {
    const reg = String(region||'').trim();
    if (STATIC_S3_PRICES[reg]) {
      Object.assign(prices, STATIC_S3_PRICES[reg]);
    }
  }
return { currency: "USD", prices };
}

import { S3Client, ListBucketsCommand, GetBucketLocationCommand, GetBucketTaggingCommand } from "@aws-sdk/client-s3";
import { CloudWatchClient, GetMetricDataCommand } from "@aws-sdk/client-cloudwatch";

/** Make AWS credentials object from a static account (if provided) */
function makeCredentials(acc){
  if (acc && acc.accessKeyId && acc.secretAccessKey){
    return { accessKeyId: acc.accessKeyId, secretAccessKey: acc.secretAccessKey, sessionToken: acc.sessionToken || undefined };
  }
  return undefined;
}

/** Normalize S3 GetBucketLocation -> region string */
function normalizeBucketRegion(loc){
  if (!loc || !loc.LocationConstraint) return "us-east-1";
  const v = String(loc.LocationConstraint);
  // Historical compat (EU became eu-west-1)
  if (v === "EU") return "eu-west-1";
  return v;
}

const S3_BUCKETS_CONCURRENCY = Math.max(1, Number.parseInt(process.env.S3_BUCKETS_CONCURRENCY || process.env.S3_BUCKET_METRICS_CONCURRENCY || "5", 10) || 5);

async function mapWithConcurrency(items, limit, iterator){
  if (!Array.isArray(items) || items.length === 0) return [];
  const size = Math.max(1, Math.min(limit || 1, items.length));
  const results = new Array(items.length);
  let idx = 0;
  async function worker(){
    while (true){
      const current = idx++;
      if (current >= items.length) break;
      results[current] = await iterator(items[current], current);
    }
  }
  const workers = Array.from({ length: size }, () => worker());
  await Promise.all(workers);
  return results;
}

const STORAGE_TYPES = [
  "StandardStorage",
  "StandardIAStorage", "StandardIAObjectOverhead", "StandardIASizeOverhead",
  "OneZoneIAStorage", "OneZoneIASizeOverhead",
  "ReducedRedundancyStorage",
  "IntelligentTieringFAStorage", "IntelligentTieringIAStorage",
  "IntelligentTieringAAStorage", "IntelligentTieringAIAStorage", "IntelligentTieringDAAStorage",
  "GlacierInstantRetrievalStorage", "GlacierIRSizeOverhead",
  "GlacierStorage", "GlacierStagingStorage", "GlacierObjectOverhead", "GlacierS3ObjectOverhead",
  "DeepArchiveStorage", "DeepArchiveStagingStorage", "DeepArchiveObjectOverhead", "DeepArchiveS3ObjectOverhead",
  "ExpressOneZoneStorage" // S3 Express One Zone (directory buckets uniquement)
];

// Friendly labels for UI
const FRIENDLY_LABEL = {
  "StandardStorage": "Standard",
  "StandardIAStorage": "Standard IA",
  "StandardIAObjectOverhead": "Standard IA (overhead objets)",
  "StandardIASizeOverhead": "Standard IA (overhead taille)",
  "OneZoneIAStorage": "One Zone IA",
  "OneZoneIASizeOverhead": "One Zone IA (overhead taille)",
  "ReducedRedundancyStorage": "RRS (legacy)",
  "GlacierInstantRetrievalStorage": "Glacier Instant Retrieval",
  "GlacierIRSizeOverhead": "Glacier IR (overhead taille)",
  "GlacierStorage": "Glacier (Flexible Retrieval)",
  "GlacierStagingStorage": "Glacier (Staging)",
  "GlacierObjectOverhead": "Glacier (overhead objets)",
  "GlacierS3ObjectOverhead": "Glacier (overhead S3 objets)",
  "DeepArchiveStorage": "Glacier Deep Archive",
  "DeepArchiveStagingStorage": "Deep Archive (Staging)",
  "DeepArchiveObjectOverhead": "Deep Archive (overhead objets)",
  "DeepArchiveS3ObjectOverhead": "Deep Archive (overhead S3 objets)",
  "IntelligentTieringFAStorage": "Intelligent Tiering (Frequent)",
  "IntelligentTieringIAStorage": "Intelligent Tiering (Infrequent)",
  "IntelligentTieringAAStorage": "Intelligent Tiering (Archive)",
  "IntelligentTieringAIAStorage": "Intelligent Tiering (Archive IR)",
  "IntelligentTieringDAAStorage": "Intelligent Tiering (Deep Archive)",
  "ExpressOneZoneStorage": "S3 Express One Zone"
};

/** Fetch last datapoint for a given metric queries, returns a map key->valueBytes */
async function fetchLatestMetricMap(cw, MetricDataQueries, start, end){
  const out = await cw.send(new GetMetricDataCommand({
    StartTime: start, EndTime: end, MetricDataQueries, ScanBy: "TimestampDescending", MaxDatapoints: 500
  }));
  const map = new Map();
  for (const r of (out.MetricDataResults || [])){
    if (!r || !r.Id) continue;
    const idx = (r.Timestamps && r.Timestamps.length) ? 0 : -1;
    const val = idx === 0 && r.Values && r.Values.length ? r.Values[0] : undefined;
    if (typeof val === "number" && isFinite(val)) map.set(r.Id, val);
  }
  return map;
}

/** Fetch time series for BucketSizeBytes per storage class and build totals */
async function fetchSeriesByClass(cw, { bucket, start, end, storageTypes }){
  const MetricDataQueries = [];
  const toId = (s)=> ("s_"+s.replace(/[^a-z0-9]/gi,"_").toLowerCase());
  for (const s of storageTypes){
    MetricDataQueries.push({
      Id: toId(s).slice(0,64),
      MetricStat: {
        Metric: {
          Namespace: "AWS/S3",
          MetricName: "BucketSizeBytes",
          Dimensions: [
            { Name: "BucketName", Value: bucket },
            { Name: "StorageType", Value: s }
          ]
        },
        Period: 86400,
        Stat: "Average"
      },
      ReturnData: true
    });
  }
  // Add NumberOfObjects (AllStorageTypes) series too
  MetricDataQueries.push({
    Id: "objects",
    MetricStat: {
      Metric: {
        Namespace: "AWS/S3",
        MetricName: "NumberOfObjects",
        Dimensions: [
          { Name: "BucketName", Value: bucket },
          { Name: "StorageType", Value: "AllStorageTypes" }
        ]
      },
      Period: 86400,
      Stat: "Average"
    },
    ReturnData: true
  });
  const out = await cw.send(new GetMetricDataCommand({
    StartTime: start, EndTime: end, MetricDataQueries, ScanBy: "TimestampAscending", MaxDatapoints: 5000
  }));
  // Normalize
  const byId = new Map();
  for (const r of (out.MetricDataResults || [])){
    if (!r || !r.Id) continue;
    const points = [];
    const ts = r.Timestamps || [];
    const vs = r.Values || [];
    for (let i=0;i<ts.length;i++){
      const t = ts[i]; const v = vs[i];
      if (t && typeof v === "number" && isFinite(v)){ points.push({ t: new Date(t), v }); }
    }
    byId.set(r.Id, points);
  }
  // Union of all timestamps (day) and sum per day
  const allTsSet = new Set();
  for (const arr of byId.values()){
    for (const p of arr){ allTsSet.add(p.t.toISOString().slice(0,10)); }
  }
  const days = Array.from(allTsSet).sort();
  const totalSeries = [];
  const seriesByClass = {};
  const objectsSeries = [];
  const latestByClass = {};
  for (const day of days){
    let total = 0;
    for (const s of storageTypes){
      const id = ("s_"+s.replace(/[^a-z0-9]/gi,"_").toLowerCase()).slice(0,64);
      const arr = byId.get(id) || [];
      // find point for that day
      const p = arr.find(q => q.t.toISOString().slice(0,10) === day);
      if (p){ total += p.v; latestByClass[s] = p.v; }
      if (!seriesByClass[s]) seriesByClass[s] = [];
      seriesByClass[s].push({ t: day, bytes: p ? Math.round(p.v) : 0 });
    }
    totalSeries.push({ t: day, bytes: Math.round(total) });
    const oArr = byId.get("objects") || [];
    const op = oArr.find(q => q.t.toISOString().slice(0,10) === day);
    objectsSeries.push({ t: day, objects: op ? Math.round(op.v) : null });
  }
  return { totalSeries, objectsSeries, latestByClass, seriesByClass };
}


/** Get CW client in bucket region; if empty, fallback to us-east-1 */
function makeCloudWatch(region, credentials){
  const reg = region || "us-east-1";
  return new CloudWatchClient({ region: reg, credentials });
}

/** For one bucket, returns metrics by storage class + objects count */
async function getBucketMetrics({ account, bucket, region }){
  const credentials = makeCredentials(account);
  const now = new Date();
  const start = new Date(now.getTime() - 35*24*3600*1000);
  const end = now;

  // Prepare metric queries for each storage type (BucketSizeBytes)
  const mdq = [];
  const toId = (s)=> ("m_"+s.replace(/[^a-z0-9]/gi,"_").toLowerCase());
  for (const s of STORAGE_TYPES){
    mdq.push({
      Id: toId(s).slice(0,64),
      MetricStat: {
        Metric: {
          Namespace: "AWS/S3",
          MetricName: "BucketSizeBytes",
          Dimensions: [
            { Name: "BucketName", Value: bucket },
            { Name: "StorageType", Value: s }
          ]
        },
        Period: 86400,
        Stat: "Average"
      },
      ReturnData: true
    });
  }
  // NumberOfObjects (AllStorageTypes)
  mdq.push({
    Id: "objects",
    MetricStat: {
      Metric: {
        Namespace: "AWS/S3",
        MetricName: "NumberOfObjects",
        Dimensions: [
          { Name: "BucketName", Value: bucket },
          { Name: "StorageType", Value: "AllStorageTypes" }
        ]
      },
      Period: 86400,
      Stat: "Average"
    },
    ReturnData: true
  });

  // Try CW in bucket region, then fallback to us-east-1 if empty
  let cw = makeCloudWatch(region, credentials);
  let latest = await fetchLatestMetricMap(cw, mdq, start, end);
  // If we got zero datapoints, retry in us-east-1 (historical quirk for S3 metrics)
  if (latest.size === 0 && region !== "us-east-1"){
    cw = makeCloudWatch("us-east-1", credentials);
    latest = await fetchLatestMetricMap(cw, mdq, start, end);
  }

  let byClass = {};
  let totalBytes = 0;
  for (const s of STORAGE_TYPES){
    const id = toId(s).slice(0,64);
    const v = latest.get(id);
    if (typeof v === "number" && isFinite(v) && v > 0){
      byClass[s] = Math.round(v);
      totalBytes += v;
    }
  }
  let objects = latest.get("objects") || 0;
  // Fallback: if no datapoints or totalBytes is zero, derive from timeseries (more robust)
  if (!totalBytes || totalBytes <= 0) {
    try {
      let series = await fetchSeriesByClass(cw, { bucket, start, end, storageTypes: STORAGE_TYPES });
      if ((!series.totalSeries || series.totalSeries.length === 0) && region !== "us-east-1"){
        const cw2 = makeCloudWatch("us-east-1", credentials);
        series = await fetchSeriesByClass(cw2, { bucket, start, end, storageTypes: STORAGE_TYPES });
      }
      const latestByClass = series && series.latestByClass ? series.latestByClass : {};
      let sum = 0; const bc = {};
      for (const [cls, bytes] of Object.entries(latestByClass)) { const n = Number(bytes||0); if (n>0) { bc[cls] = Math.round(n); sum += n; } }
      if (sum > 0) { byClass = bc; totalBytes = sum; }
      if ((!objects || objects <= 0) && series && Array.isArray(series.objectsSeries) && series.objectsSeries.length){
        const lastObj = series.objectsSeries[series.objectsSeries.length-1]?.objects;
        if (typeof lastObj === "number" && isFinite(lastObj)) objects = Math.round(lastObj);
      }
    } catch (e) {
      // ignore and keep defaults
    }
  }

  return {
    totalBytes: Math.round(totalBytes),
    objects: Math.round(objects),
    classes: byClass
  };
}

/** List S3 buckets across accounts, annotate with region and metrics */

/** Timeseries for a single bucket (total size over time + latest per-class breakdown) */
export async function getBucketTimeseries({ account, bucket, region, start, end }){
  const credentials = makeCredentials(account);
  // CloudWatch in bucket region, fallback to us-east-1 if needed
  let cw = makeCloudWatch(region, credentials);
  let series = await fetchSeriesByClass(cw, { bucket, start: new Date(start), end: new Date(end), storageTypes: STORAGE_TYPES });
  if ((!series.totalSeries || series.totalSeries.length === 0) && region !== "us-east-1"){
    cw = makeCloudWatch("us-east-1", credentials);
    series = await fetchSeriesByClass(cw, { bucket, start: new Date(start), end: new Date(end), storageTypes: STORAGE_TYPES });
  }
  // Total objects latest
  const objects = (series.objectsSeries && series.objectsSeries.length) ? (series.objectsSeries[series.objectsSeries.length-1].objects || 0) : 0;
  return {
    series: series.totalSeries,
    seriesByClass: series.seriesByClass,
    objectsSeries: series.objectsSeries,
    classes: series.latestByClass,
    objects
  };
}
export async function listS3Buckets({ accounts, regions }){
  const items = [];
  const regionSet = new Set(Array.isArray(regions) ? regions : []);
  for (const acc of accounts){
    // List buckets for this account (global)
    const s3 = new S3Client({ region: "us-east-1", credentials: makeCredentials(acc) });
    let buckets = [];
    try {
      const out = await s3.send(new ListBucketsCommand({}));
      buckets = (out.Buckets || []).map(b => ({ name: b.Name, createdAt: b.CreationDate ? new Date(b.CreationDate).toISOString() : null }));
    } catch (e){
      // push a finding?
      continue;
    }
    const bucketDetails = await mapWithConcurrency(buckets, S3_BUCKETS_CONCURRENCY, async (b) => {
      let region = "us-east-1";
      try {
        const loc = await s3.send(new GetBucketLocationCommand({ Bucket: b.name }));
        region = normalizeBucketRegion(loc);
      } catch (e){}
      if (regionSet.size && !regionSet.has(region)) return null;

      const tagsPromise = (async () => {
        try {
          const tg = await s3.send(new GetBucketTaggingCommand({ Bucket: b.name }));
          const map = {};
          for (const t of (tg.TagSet || [])) { if (t.Key) map[t.Key] = t.Value || ""; }
          return map;
        } catch (e){
          return {};
        }
      })();

      let metrics = { totalBytes: 0, objects: 0, classes: {} };
      try {
        metrics = await getBucketMetrics({ account: acc, bucket: b.name, region });
      } catch (e){}

      const tags = await tagsPromise;

      return {
        accountId: String(acc.accountId || "unknown"),
        bucket: b.name,
        region,
        createdAt: b.createdAt || null,
        objects: metrics.objects || 0,
        totalBytes: metrics.totalBytes || 0,
        classes: metrics.classes || {},
        tags
      };
    });
    for (const detail of bucketDetails){
      if (detail) items.push(detail);
    }
  }
  // sort by size desc
  items.sort((a,b)=> (b.totalBytes||0) - (a.totalBytes||0));
  return items;
}

export function friendlyClassLabel(k){
  return FRIENDLY_LABEL[k] || k;
}
