import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(MODULE_DIR, "..");
const REPO_ROOT = path.resolve(PROJECT_ROOT, "..");

const ABSOLUTE_FALLBACKS = [
  "/app/accounts-config.json",
  "/app/src/accounts-config.json",
  "/accounts-config.json"
];

function normalizePathCandidate(p){
  if (!p) return null;
  try {
    let candidate = String(p).trim();
    if (!candidate) return null;
    if (candidate.startsWith("~")) {
      const home = process.env.HOME || process.env.USERPROFILE;
      if (home) {
        candidate = path.join(home, candidate.slice(1));
      }
    }
    return path.resolve(candidate);
  } catch {
    return null;
  }
}

function splitCandidateList(raw){
  if (!raw) return [];
  const values = Array.isArray(raw) ? raw : [raw];
  const parts = [];
  for (const value of values){
    if (!value) continue;
    const str = String(value);
    const delimiter = path.delimiter;
    const primaryTokens = delimiter && delimiter !== ","
      ? str.split(delimiter)
      : [str];
    for (const token of primaryTokens){
      const secondaryTokens = token.split(",");
      for (const secondary of secondaryTokens){
        const trimmed = secondary.trim();
        if (trimmed) parts.push(trimmed);
      }
    }
  }
  return parts;
}

function tryReadJSON(p){
  if (!p) return null;
  try {
    if (fs.existsSync(p)){
      const txt = fs.readFileSync(p, "utf8");
      return JSON.parse(txt);
    }
  } catch (e){
    console.warn(`accounts-config.json not found/invalid at ${p}: ${e.message}`);
  }
  return null;
}

export function loadAccountsConfig(){
  const envCandidates = splitCandidateList(process.env.ACCOUNTS_CONFIG_PATH);
  const cwdCandidates = [
    path.resolve(process.cwd(), "accounts-config.json"),
    path.resolve(process.cwd(), "src/accounts-config.json"),
    path.resolve(process.cwd(), "api/accounts-config.json"),
    path.resolve(process.cwd(), "api/src/accounts-config.json")
  ];
  const moduleCandidates = [
    path.resolve(MODULE_DIR, "accounts-config.json")
  ];
  const projectRootCandidates = [
    path.resolve(PROJECT_ROOT, "accounts-config.json"),
    path.resolve(PROJECT_ROOT, "src/accounts-config.json")
  ];
  const repoRootCandidates = [
    path.resolve(REPO_ROOT, "accounts-config.json"),
    path.resolve(REPO_ROOT, "src/accounts-config.json"),
    path.resolve(REPO_ROOT, "api/accounts-config.json"),
    path.resolve(REPO_ROOT, "api/src/accounts-config.json")
  ];

  const orderedCandidates = [
    ...envCandidates,
    ...cwdCandidates,
    ...moduleCandidates,
    ...projectRootCandidates,
    ...repoRootCandidates,
    ...ABSOLUTE_FALLBACKS
  ];

  const seen = new Set();
  for (const candidate of orderedCandidates){
    const normalized = normalizePathCandidate(candidate);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    const data = tryReadJSON(normalized);
    if (data) return data;
  }
  return { static: [], assumeRoles: [] };
}