import { STSClient, AssumeRoleCommand, GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import { ensureSchema } from "./ensure-schema.js";
import { loadAccountsConfig } from "./config.js";
import { listInstances, listVolumes } from "./ri.js";
import { saveEc2InstanceSnapshot } from "./ec2-snapshots.js";
import { saveEbsVolumeSnapshot } from "./ebs-snapshots.js";

function parseList(value) {
  return String(value || "").split(",").map(s => s.trim()).filter(Boolean);
}

function arg(name, fallback = undefined) {
  const idx = process.argv.indexOf(`--${name}`);
  return idx > -1 ? process.argv[idx + 1] : fallback;
}

function parseRegions() {
  const raw = arg("regions", process.env.EC2_SNAPSHOT_REGIONS || process.env.EC2_REGIONS || process.env.AWS_REGION || "eu-west-3");
  return Array.from(new Set(parseList(raw)));
}

function normalizeStaticAccount(account = {}) {
  const accountId = String(account.accountId || account.id || "").trim();
  if (!accountId) return null;
  return {
    accountId,
    accountName: account.accountName || account.name || accountId,
    accessKeyId: account.accessKeyId,
    secretAccessKey: account.secretAccessKey,
    sessionToken: account.sessionToken
  };
}

async function assumeRoleAccount(account = {}, region) {
  const roleArn = String(account.roleArn || account.RoleArn || "").trim();
  if (!roleArn) return null;
  const sts = new STSClient({ region });
  const out = await sts.send(new AssumeRoleCommand({
    RoleArn: roleArn,
    RoleSessionName: "costwatch-ec2-snapshot",
    ExternalId: account.externalId || account.ExternalId || undefined,
    DurationSeconds: 3600
  }));
  const accountId = String(account.accountId || account.id || roleArn.match(/arn:aws:iam::(\d+):/)?.[1] || "").trim();
  return {
    accountId,
    accountName: account.accountName || account.name || accountId,
    credentials: {
      accessKeyId: out.Credentials.AccessKeyId,
      secretAccessKey: out.Credentials.SecretAccessKey,
      sessionToken: out.Credentials.SessionToken
    }
  };
}

async function defaultCredentialAccount(region) {
  try {
    const sts = new STSClient({ region });
    const out = await sts.send(new GetCallerIdentityCommand({}));
    if (out?.Account) return [{ accountId: String(out.Account) }];
  } catch (err) {
    console.warn("[ec2:snapshot] Default credential account detection failed", err?.message || err);
  }
  return [];
}

async function resolveAccounts(regions) {
  const config = loadAccountsConfig();
  const staticAccounts = Array.isArray(config?.static)
    ? config.static.map(normalizeStaticAccount).filter(Boolean)
    : [];
  const roleAccounts = [];
  const assumeRoles = Array.isArray(config?.assumeRoles) ? config.assumeRoles : [];
  for (const account of assumeRoles) {
    try {
      const resolved = await assumeRoleAccount(account, regions[0] || process.env.AWS_REGION || "us-east-1");
      if (resolved?.accountId) roleAccounts.push(resolved);
    } catch (err) {
      console.error("[ec2:snapshot] AssumeRole failed", account?.accountId || account?.roleArn || "", err?.message || err);
    }
  }

  const accounts = [...staticAccounts, ...roleAccounts];
  if (accounts.length) return accounts;
  return defaultCredentialAccount(regions[0] || process.env.AWS_REGION || "us-east-1");
}

async function main() {
  const regions = parseRegions();
  if (!regions.length) throw new Error("No regions configured for EC2 snapshot.");
  await ensureSchema();
  const accounts = await resolveAccounts(regions);
  if (!accounts.length) throw new Error("No AWS accounts/credentials available for EC2 snapshot.");

  const snapshotAt = new Date();
  console.log(`[ec2:snapshot] Starting at ${snapshotAt.toISOString()}`);
  console.log(`[ec2:snapshot] Regions: ${regions.join(", ")}`);
  console.log(`[ec2:snapshot] Accounts: ${accounts.map(a => a.accountId).join(", ")}`);
  const [instances, volumes] = await Promise.all([
    listInstances({ accounts, regions }),
    listVolumes({ accounts, regions })
  ]);
  const [result, ebsResult] = await Promise.all([
    saveEc2InstanceSnapshot(instances, { snapshotAt }),
    saveEbsVolumeSnapshot(volumes, { snapshotAt })
  ]);
  console.log(`[ec2:snapshot] Saved ${result.saved}/${result.scanned} instance rows for hour ${result.snapshotHour}`);
  console.log(`[ec2:snapshot] States: ${JSON.stringify(result.states)}`);
  console.log(`[ec2:snapshot] Saved ${ebsResult.saved}/${ebsResult.scanned} EBS volume rows for hour ${ebsResult.snapshotHour}`);
  console.log(`[ec2:snapshot] EBS total GiB: ${ebsResult.totalGiB}; estimated monthly cost: ${ebsResult.estimatedMonthlyCost ?? "n/a"}`);
  console.log(`[ec2:snapshot] EBS types: ${JSON.stringify(ebsResult.byType)}`);
}

main().catch((err) => {
  console.error("[ec2:snapshot] Failed", err);
  process.exit(1);
});
