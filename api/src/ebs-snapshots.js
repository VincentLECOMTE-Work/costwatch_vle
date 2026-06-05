import { query } from "./db.js";
import { estimateEbsVolumeMonthlyCost, getEbsPricingForRegions } from "./ebs-pricing.js";

function toIsoTimestamp(value) {
  const date = value instanceof Date ? value : new Date(value || Date.now());
  if (Number.isNaN(date.getTime())) return new Date().toISOString();
  return date.toISOString();
}

function floorHourIso(value) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value || Date.now());
  if (Number.isNaN(date.getTime())) return floorHourIso(new Date());
  date.setUTCMinutes(0, 0, 0);
  return date.toISOString();
}

function toIsoDate(value) {
  if (!value) return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10);
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

function parseList(value) {
  if (Array.isArray(value)) return value.map(String).map(s => s.trim()).filter(Boolean);
  return String(value || "").split(",").map(s => s.trim()).filter(Boolean);
}

function rowNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function nullableNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function pctDelta(first, latest) {
  const a = nullableNumber(first);
  const b = nullableNumber(latest);
  if (a === null || b === null || a === 0) return null;
  return ((b - a) / Math.abs(a)) * 100;
}

function normalizeTags(volume = {}) {
  if (volume.tagMap && typeof volume.tagMap === "object") {
    const out = {};
    for (const [key, value] of Object.entries(volume.tagMap)) {
      if (!key) continue;
      out[key] = value == null ? "" : String(value);
    }
    if (Object.keys(out).length) return out;
  }
  const tags = volume.tags || volume.Tags || [];
  if (!Array.isArray(tags)) return {};
  const out = {};
  for (const tag of tags) {
    const key = String(tag?.key ?? tag?.Key ?? "").trim();
    if (!key) continue;
    out[key] = tag?.value ?? tag?.Value ?? "";
  }
  return out;
}

function tagValue(tags = {}, key) {
  const exact = tags[key];
  if (exact != null) return String(exact);
  const lower = String(key).toLowerCase();
  for (const [tagKey, value] of Object.entries(tags)) {
    if (String(tagKey).toLowerCase() === lower) return String(value ?? "");
  }
  return "";
}

function volumeRegion(volume = {}) {
  const explicit = String(volume.region || volume.Region || "").trim();
  if (explicit) return explicit;
  const az = String(volume.availabilityZone || volume.az || volume.AvailabilityZone || "").trim();
  const match = az.match(/^(.+-\d)[a-z]$/i);
  return match ? match[1] : "";
}

function normalizeAttachments(volume = {}) {
  const attachments = volume.attachments || volume.Attachments || [];
  if (!Array.isArray(attachments)) return [];
  return attachments.map(item => ({
    instanceId: String(item?.instanceId ?? item?.InstanceId ?? item?.id ?? ""),
    device: String(item?.device ?? item?.Device ?? ""),
    state: String(item?.state ?? item?.State ?? "")
  })).filter(item => item.instanceId || item.device || item.state);
}

export async function ensureEbsSnapshotSchema() {
  await query(`
    create table if not exists ebs_volume_snapshots (
      snapshot_at timestamptz not null,
      snapshot_hour timestamptz not null,
      account_id text not null,
      region text not null,
      volume_id text not null,
      name text not null default '',
      volume_type text not null default '',
      state text not null default '',
      size_gib numeric not null default 0,
      iops integer,
      throughput integer,
      availability_zone text not null default '',
      encrypted boolean,
      multi_attach_enabled boolean,
      create_time timestamptz,
      attachments jsonb not null default '[]'::jsonb,
      tags jsonb not null default '{}'::jsonb,
      estimated_monthly_cost numeric,
      pricing_source text not null default '',
      updated_at timestamptz not null default now(),
      primary key (snapshot_hour, account_id, region, volume_id)
    );
    create index if not exists idx_ebs_volume_snapshots_hour on ebs_volume_snapshots(snapshot_hour desc);
    create index if not exists idx_ebs_volume_snapshots_account_region on ebs_volume_snapshots(account_id, region);
    create index if not exists idx_ebs_volume_snapshots_volume on ebs_volume_snapshots(volume_id);
    create index if not exists idx_ebs_volume_snapshots_type on ebs_volume_snapshots(volume_type);
  `);
}

export async function saveEbsVolumeSnapshot(volumes = [], { snapshotAt = new Date(), pricing = null } = {}) {
  await ensureEbsSnapshotSchema();
  const snapshotIso = toIsoTimestamp(snapshotAt);
  const snapshotHour = floorHourIso(snapshotAt);
  const volumeList = Array.isArray(volumes) ? volumes : [];
  if (!volumeList.length) {
    return {
      snapshotAt: snapshotIso,
      snapshotHour,
      scanned: 0,
      saved: 0,
      totalGiB: 0,
      estimatedMonthlyCost: null,
      costedVolumes: 0,
      byType: {}
    };
  }
  const regions = Array.from(new Set(volumeList.map(volumeRegion).filter(Boolean)));
  const types = Array.from(new Set(volumeList.map(v => String(v.volumeType || v.type || v.VolumeType || "").trim().toLowerCase()).filter(Boolean)));
  const pricingTable = pricing || await getEbsPricingForRegions(regions, types);
  let saved = 0;
  let totalGiB = 0;
  let estimatedMonthlyCost = 0;
  let costedVolumes = 0;
  const byType = new Map();

  for (const volume of volumeList) {
    const volumeId = String(volume.volumeId || volume.VolumeId || "").trim();
    const accountId = String(volume.accountId || volume.account_id || "").trim();
    const region = volumeRegion(volume);
    if (!volumeId || !accountId || !region) continue;
    const type = String(volume.volumeType || volume.type || volume.VolumeType || "").trim().toLowerCase();
    const sizeGiB = rowNumber(volume.sizeGiB ?? volume.size ?? volume.Size, 0);
    const iops = nullableNumber(volume.iops ?? volume.Iops);
    const throughput = nullableNumber(volume.throughput ?? volume.Throughput);
    const tags = normalizeTags(volume);
    const name = String(volume.name || tagValue(tags, "Name") || "");
    const attachments = normalizeAttachments(volume);
    const estimate = estimateEbsVolumeMonthlyCost(volume, pricingTable.regions || pricingTable);
    const monthlyCost = nullableNumber(estimate.monthly);

    await query(`
      insert into ebs_volume_snapshots (
        snapshot_at, snapshot_hour, account_id, region, volume_id, name, volume_type,
        state, size_gib, iops, throughput, availability_zone, encrypted,
        multi_attach_enabled, create_time, attachments, tags, estimated_monthly_cost,
        pricing_source, updated_at
      )
      values (
        $1::timestamptz, $2::timestamptz, $3, $4, $5, $6, $7,
        $8, $9::numeric, $10::integer, $11::integer, $12, $13::boolean,
        $14::boolean, $15::timestamptz, $16::jsonb, $17::jsonb, $18::numeric,
        $19, now()
      )
      on conflict (snapshot_hour, account_id, region, volume_id) do update set
        snapshot_at = excluded.snapshot_at,
        name = excluded.name,
        volume_type = excluded.volume_type,
        state = excluded.state,
        size_gib = excluded.size_gib,
        iops = excluded.iops,
        throughput = excluded.throughput,
        availability_zone = excluded.availability_zone,
        encrypted = excluded.encrypted,
        multi_attach_enabled = excluded.multi_attach_enabled,
        create_time = excluded.create_time,
        attachments = excluded.attachments,
        tags = excluded.tags,
        estimated_monthly_cost = excluded.estimated_monthly_cost,
        pricing_source = excluded.pricing_source,
        updated_at = now()
    `, [
      snapshotIso,
      snapshotHour,
      accountId,
      region,
      volumeId,
      name,
      type,
      String(volume.state || volume.State || ""),
      sizeGiB,
      iops,
      throughput,
      String(volume.availabilityZone || volume.az || volume.AvailabilityZone || ""),
      volume.encrypted ?? volume.Encrypted ?? null,
      volume.multiAttachEnabled ?? volume.MultiAttachEnabled ?? null,
      volume.createTime ? toIsoTimestamp(volume.createTime) : null,
      JSON.stringify(attachments),
      JSON.stringify(tags),
      monthlyCost,
      estimate.source || ""
    ]);

    saved += 1;
    totalGiB += sizeGiB;
    if (monthlyCost !== null) {
      estimatedMonthlyCost += monthlyCost;
      costedVolumes += 1;
    }
    byType.set(type || "unknown", (byType.get(type || "unknown") || 0) + 1);
  }

  return {
    snapshotAt: snapshotIso,
    snapshotHour,
    scanned: volumeList.length,
    saved,
    totalGiB,
    estimatedMonthlyCost: costedVolumes ? estimatedMonthlyCost : null,
    costedVolumes,
    byType: Object.fromEntries(byType.entries())
  };
}

function addSnapshotFilters(params, { start, end, accounts = [], regions = [], volumeTypes = [] } = {}, alias = "") {
  const conds = [];
  const prefix = alias ? `${alias}.` : "";
  if (start) {
    params.push(start);
    conds.push(`${prefix}snapshot_hour >= $${params.length}::timestamptz`);
  }
  if (end) {
    params.push(end);
    conds.push(`${prefix}snapshot_hour < $${params.length}::timestamptz`);
  }
  const accountList = parseList(accounts);
  if (accountList.length) {
    params.push(accountList);
    conds.push(`${prefix}account_id = any($${params.length})`);
  }
  const regionList = parseList(regions);
  if (regionList.length) {
    params.push(regionList);
    conds.push(`${prefix}region = any($${params.length})`);
  }
  const typeList = parseList(volumeTypes).map(s => s.toLowerCase());
  if (typeList.length) {
    params.push(typeList);
    conds.push(`${prefix}volume_type = any($${params.length})`);
  }
  return conds.length ? `where ${conds.join(" and ")}` : "";
}

function normalizeSeriesRow(row = {}) {
  const costedVolumes = rowNumber(row.costed_volumes);
  return {
    snapshotHour: row.snapshot_hour ? new Date(row.snapshot_hour).toISOString() : null,
    totalVolumes: rowNumber(row.total_volumes),
    totalGiB: rowNumber(row.total_gib),
    estimatedMonthlyCost: costedVolumes ? rowNumber(row.estimated_monthly_cost) : null,
    costedVolumes,
    totalIops: rowNumber(row.total_iops),
    totalThroughput: rowNumber(row.total_throughput)
  };
}

export async function getEbsSnapshotSummary(params = {}) {
  await ensureEbsSnapshotSchema();
  const p = [];
  const where = addSnapshotFilters(p, params);
  const latestParams = [];
  const latestWhere = addSnapshotFilters(latestParams, params);
  const latestOuterWhere = addSnapshotFilters(latestParams, params, "s").replace(/^where\s+/i, "and ");

  const [boundsResult, bySnapshotResult, latestByTypeResult, latestByAccountResult, latestItemsResult] = await Promise.all([
    query(`
      select min(snapshot_hour) as min_snapshot_hour,
             max(snapshot_hour) as max_snapshot_hour,
             count(distinct snapshot_hour)::int as snapshots,
             count(*)::int as rows
        from ebs_volume_snapshots
       ${where}
    `, p),
    query(`
      select snapshot_hour,
             count(*)::int as total_volumes,
             coalesce(sum(size_gib), 0)::float as total_gib,
             count(*) filter (where estimated_monthly_cost is not null)::int as costed_volumes,
             coalesce(sum(estimated_monthly_cost), 0)::float as estimated_monthly_cost,
             coalesce(sum(iops), 0)::float as total_iops,
             coalesce(sum(throughput), 0)::float as total_throughput
        from ebs_volume_snapshots
       ${where}
       group by snapshot_hour
       order by snapshot_hour asc
    `, p),
    query(`
      with latest as (
        select max(snapshot_hour) as snapshot_hour
          from ebs_volume_snapshots
         ${latestWhere}
      )
      select s.volume_type,
             count(*)::int as total_volumes,
             coalesce(sum(s.size_gib), 0)::float as total_gib,
             count(*) filter (where s.estimated_monthly_cost is not null)::int as costed_volumes,
             coalesce(sum(s.estimated_monthly_cost), 0)::float as estimated_monthly_cost,
             coalesce(sum(s.iops), 0)::float as total_iops,
             coalesce(sum(s.throughput), 0)::float as total_throughput
        from ebs_volume_snapshots s
        join latest l on l.snapshot_hour = s.snapshot_hour
       ${latestOuterWhere}
       group by s.volume_type
       order by estimated_monthly_cost desc nulls last, total_gib desc
    `, latestParams),
    query(`
      with latest as (
        select max(snapshot_hour) as snapshot_hour
          from ebs_volume_snapshots
         ${latestWhere}
      )
      select s.account_id,
             count(*)::int as total_volumes,
             coalesce(sum(s.size_gib), 0)::float as total_gib,
             count(*) filter (where s.estimated_monthly_cost is not null)::int as costed_volumes,
             coalesce(sum(s.estimated_monthly_cost), 0)::float as estimated_monthly_cost
        from ebs_volume_snapshots s
        join latest l on l.snapshot_hour = s.snapshot_hour
       ${latestOuterWhere}
       group by s.account_id
       order by estimated_monthly_cost desc nulls last, total_gib desc
    `, latestParams),
    query(`
      with latest as (
        select max(snapshot_hour) as snapshot_hour
          from ebs_volume_snapshots
         ${latestWhere}
      )
      select s.*
        from ebs_volume_snapshots s
        join latest l on l.snapshot_hour = s.snapshot_hour
       ${latestOuterWhere}
       order by s.estimated_monthly_cost desc nulls last, s.size_gib desc, s.account_id, s.volume_id
       limit 100
    `, latestParams)
  ]);

  const bounds = boundsResult.rows?.[0] || {};
  const snapshots = (bySnapshotResult.rows || []).map(normalizeSeriesRow);
  const first = snapshots[0] || null;
  const latest = snapshots[snapshots.length - 1] || null;
  const latestSnapshotHour = latest?.snapshotHour || (bounds.max_snapshot_hour ? new Date(bounds.max_snapshot_hour).toISOString() : null);
  const latestCost = latest?.estimatedMonthlyCost ?? null;
  const firstCost = first?.estimatedMonthlyCost ?? null;

  return {
    generatedAt: new Date().toISOString(),
    window: {
      start: params.start || toIsoDate(bounds.min_snapshot_hour),
      end: params.end || null,
      minSnapshotHour: bounds.min_snapshot_hour ? new Date(bounds.min_snapshot_hour).toISOString() : null,
      maxSnapshotHour: bounds.max_snapshot_hour ? new Date(bounds.max_snapshot_hour).toISOString() : null
    },
    summary: {
      snapshots: rowNumber(bounds.snapshots),
      rows: rowNumber(bounds.rows),
      latestSnapshotHour,
      latestVolumes: latest?.totalVolumes || 0,
      latestSizeGiB: latest?.totalGiB || 0,
      latestMonthlyCost: latestCost,
      firstSnapshotHour: first?.snapshotHour || null,
      firstSizeGiB: first?.totalGiB || 0,
      firstMonthlyCost: firstCost,
      deltaSizeGiB: latest && first ? latest.totalGiB - first.totalGiB : 0,
      deltaSizePct: latest && first ? pctDelta(first.totalGiB, latest.totalGiB) : null,
      deltaMonthlyCost: latestCost !== null && firstCost !== null ? latestCost - firstCost : null,
      deltaMonthlyCostPct: latestCost !== null && firstCost !== null ? pctDelta(firstCost, latestCost) : null
    },
    snapshots,
    latestByType: (latestByTypeResult.rows || []).map(row => ({
      volumeType: row.volume_type || "unknown",
      totalVolumes: rowNumber(row.total_volumes),
      totalGiB: rowNumber(row.total_gib),
      estimatedMonthlyCost: rowNumber(row.costed_volumes) ? rowNumber(row.estimated_monthly_cost) : null,
      costedVolumes: rowNumber(row.costed_volumes),
      totalIops: rowNumber(row.total_iops),
      totalThroughput: rowNumber(row.total_throughput)
    })),
    latestByAccount: (latestByAccountResult.rows || []).map(row => ({
      accountId: row.account_id,
      totalVolumes: rowNumber(row.total_volumes),
      totalGiB: rowNumber(row.total_gib),
      estimatedMonthlyCost: rowNumber(row.costed_volumes) ? rowNumber(row.estimated_monthly_cost) : null,
      costedVolumes: rowNumber(row.costed_volumes)
    })),
    latestItems: (latestItemsResult.rows || []).map(row => ({
      snapshotAt: row.snapshot_at ? new Date(row.snapshot_at).toISOString() : null,
      snapshotHour: row.snapshot_hour ? new Date(row.snapshot_hour).toISOString() : null,
      accountId: row.account_id,
      region: row.region,
      volumeId: row.volume_id,
      name: row.name,
      volumeType: row.volume_type,
      type: row.volume_type,
      state: row.state,
      sizeGiB: rowNumber(row.size_gib),
      iops: nullableNumber(row.iops),
      throughput: nullableNumber(row.throughput),
      availabilityZone: row.availability_zone,
      az: row.availability_zone,
      encrypted: row.encrypted,
      multiAttachEnabled: row.multi_attach_enabled,
      createTime: row.create_time ? new Date(row.create_time).toISOString() : null,
      attachments: row.attachments || [],
      tags: row.tags || {},
      estimatedMonthlyCost: nullableNumber(row.estimated_monthly_cost),
      costMonthly: nullableNumber(row.estimated_monthly_cost),
      currency: "USD",
      pricingSource: row.pricing_source || ""
    }))
  };
}
