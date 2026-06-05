import { query } from "./db.js";

/**
 * ensureSchema()
 * - Attend que la DB soit joignable
 * - Prend un verrou consultatif (advisory lock) pour éviter les créations concurrentes
 * - Crée les tables et index requis
 */
export async function ensureSchema(){
  // 1) ping DB jusqu'à disponibilité
  const max = 30;
  for (let i = 0; i < max; i++){
    try { await query("select 1"); break; }
    catch { if (i === max-1) throw new Error("DB not reachable"); await new Promise(r => setTimeout(r, 2000)); }
  }

  // 2) Construction du SQL en un SEUL aller-retour pour garantir le même backend/session
  //    et éviter les races sur CREATE TABLE IF NOT EXISTS.
  const sql = `
    begin;

    -- verrou consultatif global pour la création de schéma
    select pg_advisory_lock(781234, 990011);

    -- Table des coûts journaliers (clé composite)
    create table if not exists cost_daily (
      day date not null,
      account_id text not null,
      service text not null,
      region text not null,
      metric text not null,
      amount_usd numeric not null default 0,
      usage_quantity numeric not null default 0,
      updated_at timestamp default now(),
      primary key (day, account_id, service, region, metric)
    );

    -- Index utiles (idempotents)
    create index if not exists idx_cost_daily_day on cost_daily(day);
    create index if not exists idx_cost_daily_metric on cost_daily(metric);
    create index if not exists idx_cost_daily_service on cost_daily(service);
    create index if not exists idx_cost_daily_account on cost_daily(account_id);
    create index if not exists idx_cost_daily_day_metric on cost_daily(day, metric);

    -- RI coverage (totaux journaliers)
    create table if not exists ri_coverage_daily (
      day date not null,
      coverage_hours numeric not null default 0,
      on_demand_hours numeric not null default 0,
      reserved_hours numeric not null default 0,
      total_running_hours numeric not null default 0,
      updated_at timestamp default now(),
      primary key (day)
    );

    -- RI utilization (totaux journaliers)
    create table if not exists ri_utilization_daily (
      day date not null,
      purchased_hours numeric not null default 0,
      total_actual_hours numeric not null default 0,
      unused_hours numeric not null default 0,
      updated_at timestamp default now(),
      primary key (day)
    );

    -- libération du verrou puis commit
    select pg_advisory_unlock(781234, 990011);
create table if not exists s3_bucket_daily (
  account_id text not null,
  bucket text not null,
  region text not null,
  day date not null,
  bytes_total numeric not null default 0,
  objects_total numeric not null default 0,
  bytes_by_class jsonb not null default '{}'::jsonb,
  updated_at timestamp default now(),
  primary key (account_id, region, bucket, day)
);
create index if not exists s3_bucket_daily_region_day on s3_bucket_daily(region, day);
create index if not exists s3_bucket_daily_bucket on s3_bucket_daily(bucket);

create table if not exists aws_api_cache (
  cache_key text primary key,
  payload jsonb not null,
  fetched_at timestamptz not null default now(),
  expires_at timestamptz not null,
  updated_at timestamptz not null default now()
);
create index if not exists idx_aws_api_cache_expires_at on aws_api_cache(expires_at);

create table if not exists finops_action_state (
  action_id text primary key,
  status text not null default 'todo',
  snoozed_until date,
  note text not null default '',
  updated_at timestamptz not null default now()
);
create index if not exists idx_finops_action_state_status on finops_action_state(status);
create index if not exists idx_finops_action_state_snoozed_until on finops_action_state(snoozed_until);

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

    commit;
  `;

  await query(sql);
}
