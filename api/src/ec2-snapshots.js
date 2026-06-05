import { query } from "./db.js";

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
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const y = value.getFullYear();
    const m = String(value.getMonth() + 1).padStart(2, "0");
    const d = String(value.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10);
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

function parseList(value) {
  if (Array.isArray(value)) return value.map(String).map(s => s.trim()).filter(Boolean);
  return String(value || "").split(",").map(s => s.trim()).filter(Boolean);
}

function rowNumber(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? n : 0;
}

function normalizeTags(inst = {}) {
  if (inst.tagMap && typeof inst.tagMap === "object") {
    const out = {};
    for (const [key, value] of Object.entries(inst.tagMap)) {
      if (!key || String(key).toLowerCase() === key) continue;
      out[key] = value == null ? "" : String(value);
    }
    if (Object.keys(out).length) return out;
  }
  if (!Array.isArray(inst.tags)) return {};
  const out = {};
  for (const tag of inst.tags) {
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

export async function ensureEc2SnapshotSchema() {
  await query(`
    create table if not exists ec2_instance_snapshots (
      snapshot_at timestamptz not null,
      snapshot_hour timestamptz not null,
      account_id text not null,
      region text not null,
      instance_id text not null,
      name text not null default '',
      instance_type text not null default '',
      platform text not null default '',
      state text not null default '',
      private_ip text not null default '',
      public_ip text not null default '',
      launch_time timestamptz,
      availability_zone text not null default '',
      vpc_id text not null default '',
      subnet_id text not null default '',
      security_groups jsonb not null default '[]'::jsonb,
      tags jsonb not null default '{}'::jsonb,
      backup_tag_value text not null default '',
      updated_at timestamptz not null default now(),
      primary key (snapshot_hour, account_id, region, instance_id)
    );
    create index if not exists idx_ec2_instance_snapshots_hour on ec2_instance_snapshots(snapshot_hour desc);
    create index if not exists idx_ec2_instance_snapshots_state on ec2_instance_snapshots(state);
    create index if not exists idx_ec2_instance_snapshots_account_region on ec2_instance_snapshots(account_id, region);
    create index if not exists idx_ec2_instance_snapshots_instance on ec2_instance_snapshots(instance_id);
    create index if not exists idx_ec2_instance_snapshots_backup_tag on ec2_instance_snapshots(backup_tag_value) where backup_tag_value <> '';
  `);
}

export async function saveEc2InstanceSnapshot(instances = [], { snapshotAt = new Date() } = {}) {
  await ensureEc2SnapshotSchema();
  const snapshotIso = toIsoTimestamp(snapshotAt);
  const snapshotHour = floorHourIso(snapshotAt);
  let saved = 0;
  const states = new Map();
  for (const inst of Array.isArray(instances) ? instances : []) {
    const instanceId = String(inst.instanceId || inst.InstanceId || "").trim();
    const accountId = String(inst.accountId || inst.account_id || "").trim();
    const region = String(inst.region || "").trim();
    if (!instanceId || !accountId || !region) continue;
    const tags = normalizeTags(inst);
    const state = String(inst.state || inst.State || "").trim().toLowerCase();
    const backupTag = tagValue(tags, "VLE_Cost");
    await query(`
      insert into ec2_instance_snapshots (
        snapshot_at, snapshot_hour, account_id, region, instance_id, name, instance_type,
        platform, state, private_ip, public_ip, launch_time, availability_zone, vpc_id,
        subnet_id, security_groups, tags, backup_tag_value, updated_at
      )
      values (
        $1::timestamptz, $2::timestamptz, $3, $4, $5, $6, $7,
        $8, $9, $10, $11, $12::timestamptz, $13, $14,
        $15, $16::jsonb, $17::jsonb, $18, now()
      )
      on conflict (snapshot_hour, account_id, region, instance_id) do update set
        snapshot_at = excluded.snapshot_at,
        name = excluded.name,
        instance_type = excluded.instance_type,
        platform = excluded.platform,
        state = excluded.state,
        private_ip = excluded.private_ip,
        public_ip = excluded.public_ip,
        launch_time = excluded.launch_time,
        availability_zone = excluded.availability_zone,
        vpc_id = excluded.vpc_id,
        subnet_id = excluded.subnet_id,
        security_groups = excluded.security_groups,
        tags = excluded.tags,
        backup_tag_value = excluded.backup_tag_value,
        updated_at = now()
    `, [
      snapshotIso,
      snapshotHour,
      accountId,
      region,
      instanceId,
      String(inst.name || ""),
      String(inst.instanceType || inst.type || ""),
      String(inst.platform || ""),
      state,
      String(inst.privateIp || ""),
      String(inst.publicIp || ""),
      inst.launchTime ? toIsoTimestamp(inst.launchTime) : null,
      String(inst.az || inst.availabilityZone || ""),
      String(inst.vpcId || ""),
      String(inst.subnetId || ""),
      JSON.stringify(Array.isArray(inst.securityGroups) ? inst.securityGroups : []),
      JSON.stringify(tags),
      backupTag
    ]);
    saved += 1;
    states.set(state || "unknown", (states.get(state || "unknown") || 0) + 1);
  }
  return {
    snapshotAt: snapshotIso,
    snapshotHour,
    scanned: Array.isArray(instances) ? instances.length : 0,
    saved,
    states: Object.fromEntries(states.entries())
  };
}

function addSnapshotFilters(params, { start, end, accounts = [], regions = [], states = [] } = {}, alias = "") {
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
  const stateList = parseList(states).map(s => s.toLowerCase());
  if (stateList.length) {
    params.push(stateList);
    conds.push(`${prefix}state = any($${params.length})`);
  }
  return conds.length ? `where ${conds.join(" and ")}` : "";
}

export async function getEc2SnapshotSummary(params = {}) {
  await ensureEc2SnapshotSchema();
  const p = [];
  const where = addSnapshotFilters(p, params);
  const pLatestItems = [];
  const latestWhere = addSnapshotFilters(pLatestItems, params);
  const latestOuterWhere = addSnapshotFilters(pLatestItems, params, "s").replace(/^where\s+/i, "and ");
  const [boundsResult, bySnapshotResult, byDayResult, latestResult, latestItemsResult] = await Promise.all([
    query(`
      select min(snapshot_hour) as min_snapshot_hour,
             max(snapshot_hour) as max_snapshot_hour,
             count(distinct snapshot_hour)::int as snapshots,
             count(*)::int as rows
        from ec2_instance_snapshots
       ${where}
    `, p),
    query(`
      select snapshot_hour,
             count(*)::int as total,
             count(*) filter (where state = 'running')::int as running,
             count(*) filter (where state = 'stopped')::int as stopped,
             count(*) filter (where state = 'terminated')::int as terminated,
             count(*) filter (where backup_tag_value <> '')::int as backup_tagged,
             count(*) filter (where backup_tag_value <> '' and state = 'running')::int as backup_running
        from ec2_instance_snapshots
       ${where}
       group by snapshot_hour
       order by snapshot_hour asc
    `, p),
    query(`
      select snapshot_hour::date as day,
             max(count_running)::int as max_running,
             avg(count_running)::float as avg_running,
             max(count_stopped)::int as max_stopped,
             max(count_backup_running)::int as max_backup_running,
             count(*)::int as snapshots
        from (
          select snapshot_hour,
                 count(*) filter (where state = 'running')::int as count_running,
                 count(*) filter (where state = 'stopped')::int as count_stopped,
                 count(*) filter (where backup_tag_value <> '' and state = 'running')::int as count_backup_running
            from ec2_instance_snapshots
           ${where}
           group by snapshot_hour
        ) x
       group by snapshot_hour::date
       order by day asc
    `, p),
    query(`
      select max(snapshot_hour) as latest_snapshot_hour
        from ec2_instance_snapshots
       ${where}
    `, p),
    query(`
      with latest as (
        select max(snapshot_hour) as snapshot_hour
          from ec2_instance_snapshots
         ${latestWhere}
      )
      select s.*
        from ec2_instance_snapshots s
        join latest l on l.snapshot_hour = s.snapshot_hour
       ${latestOuterWhere}
       order by
         case when s.state = 'running' then 0 when s.state = 'stopped' then 1 else 2 end,
         s.account_id,
         s.name,
         s.instance_id
       limit 250
    `, pLatestItems)
  ]);

  const bounds = boundsResult.rows?.[0] || {};
  const latestSnapshotHour = latestResult.rows?.[0]?.latest_snapshot_hour;
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
      latestSnapshotHour: latestSnapshotHour ? new Date(latestSnapshotHour).toISOString() : null
    },
    snapshots: (bySnapshotResult.rows || []).map(row => ({
      snapshotHour: row.snapshot_hour ? new Date(row.snapshot_hour).toISOString() : null,
      total: rowNumber(row.total),
      running: rowNumber(row.running),
      stopped: rowNumber(row.stopped),
      terminated: rowNumber(row.terminated),
      backupTagged: rowNumber(row.backup_tagged),
      backupRunning: rowNumber(row.backup_running)
    })),
    daily: (byDayResult.rows || []).map(row => ({
      date: toIsoDate(row.day),
      maxRunning: rowNumber(row.max_running),
      avgRunning: rowNumber(row.avg_running),
      maxStopped: rowNumber(row.max_stopped),
      maxBackupRunning: rowNumber(row.max_backup_running),
      snapshots: rowNumber(row.snapshots)
    })),
    latestItems: (latestItemsResult.rows || []).map(row => ({
      snapshotAt: row.snapshot_at ? new Date(row.snapshot_at).toISOString() : null,
      snapshotHour: row.snapshot_hour ? new Date(row.snapshot_hour).toISOString() : null,
      accountId: row.account_id,
      region: row.region,
      instanceId: row.instance_id,
      name: row.name,
      instanceType: row.instance_type,
      platform: row.platform,
      state: row.state,
      privateIp: row.private_ip,
      publicIp: row.public_ip,
      launchTime: row.launch_time ? new Date(row.launch_time).toISOString() : null,
      availabilityZone: row.availability_zone,
      az: row.availability_zone,
      vpcId: row.vpc_id,
      subnetId: row.subnet_id,
      securityGroups: row.security_groups || [],
      tags: row.tags || {},
      backupTagValue: row.backup_tag_value || ""
    }))
  };
}
