import { ensureSchema } from "./ensure-schema.js";
import { warmSavingsPlansCache } from "./sp-cache.js";

function arg(name, fallback = undefined) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function isoDay(input) {
  if (!input) return null;
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function defaultRange() {
  const end = new Date();
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - 30);
  return {
    start: isoDay(start),
    end: isoDay(end)
  };
}

async function main() {
  const defaults = defaultRange();
  const start = arg("from", defaults.start);
  const end = arg("to", defaults.end);
  const forceRefresh = hasFlag("force-refresh");

  await ensureSchema();
  console.log(`[sp:cache] Warming cache start=${start} end=${end} forceRefresh=${forceRefresh}`);
  await warmSavingsPlansCache({ start, end, forceRefresh });
  console.log("[sp:cache] Warm complete");
}

main().catch((err) => {
  console.error("[sp:cache] Failed", err);
  process.exit(1);
});
