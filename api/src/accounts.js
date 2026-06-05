import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { OrganizationsClient, ListAccountsCommand } from "@aws-sdk/client-organizations";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const aliasesPath = path.join(__dirname, "account-aliases.json");
const aliasesSamplePath = path.join(__dirname, "account-aliases.sample.json");
const DATA_FROM = String(process.env.DATA_FROM || process.env.data_from || "LOCAL_DB").toUpperCase();
const AWS_LIVE_ENABLED = ["1", "true", "yes", "on"].includes(String(process.env.AWS_LIVE_ENABLED || process.env.ALLOW_AWS_LIVE || "").toLowerCase());

function canCallAws() {
  return AWS_LIVE_ENABLED && DATA_FROM !== "LOCAL_DB" && DATA_FROM !== "DB";
}

async function loadAliasesFile() {
  for (const p of [aliasesPath, aliasesSamplePath]){
    try { const txt = await fs.readFile(p, "utf8"); const obj = JSON.parse(txt); return obj && typeof obj === "object" ? obj : {}; } catch {}
  }
  return {};
}

async function listAccountsFromOrg() {
  const org = new OrganizationsClient({ region: process.env.AWS_REGION || "us-east-1" });
  const out = [];
  let NextToken;
  do {
    const r = await org.send(new ListAccountsCommand({ NextToken }));
    for (const a of (r.Accounts || [])) if (a.Status === "ACTIVE") out.push({ id: a.Id, name: a.Name, email: a.Email });
    NextToken = r.NextToken;
  } while (NextToken);
  return out;
}

export async function getAccounts() {
  let base = [];
  const src = String(process.env.ACCOUNT_NAME_SOURCE||"org,alias").toLowerCase();
  const useOrg = src.includes("org") && canCallAws();
  const useAlias = src.includes("alias");
  try { if (useOrg) base = await listAccountsFromOrg(); } catch (e) { console.warn("Organizations failed", e?.name||e); }
  let out = base || [];
  if (useAlias){
    const alias = await loadAliasesFile();
    const byId = new Map(out.map(a => [a.id, a]));
    for (const [id, name] of Object.entries(alias)) {
      const curr = byId.get(id) || { id };
      curr.name = name || curr.name || id;
      byId.set(id, curr);
    }
    out = Array.from(byId.values());
  }
  return Array.from(out).sort((a,b)=> (a.name||a.id).localeCompare(b.name||b.id));
}

export async function accountNameMap(){
  const list = await getAccounts();
  return new Map(list.map(a=>[a.id, a.name || a.id]));
}
