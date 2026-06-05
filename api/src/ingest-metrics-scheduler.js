import { spawn } from "node:child_process";

function asBool(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  const v = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(v)) return true;
  if (["0", "false", "no", "n", "off"].includes(v)) return false;
  return fallback;
}

function parseUtcClock(raw, fallback = "03:15") {
  const text = String(raw || fallback).trim();
  const match = text.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return parseUtcClock(fallback, fallback);
  const hours = Number.parseInt(match[1], 10);
  const minutes = Number.parseInt(match[2], 10);
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
    return parseUtcClock(fallback, fallback);
  }
  return { hours, minutes, text: `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}` };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nextRunAt({ hours, minutes }, now = new Date()) {
  const current = new Date(now);
  const candidate = new Date(Date.UTC(
    current.getUTCFullYear(),
    current.getUTCMonth(),
    current.getUTCDate(),
    hours,
    minutes,
    0,
    0
  ));
  if (candidate <= current) {
    candidate.setUTCDate(candidate.getUTCDate() + 1);
  }
  return candidate;
}

async function runAutoIngest() {
  await new Promise((resolve, reject) => {
    const child = spawn("node", ["src/ingest-metrics-auto.js"], { stdio: "inherit" });
    child.on("close", (code) => {
      if (code === 0) return resolve();
      return reject(new Error(`ingest-metrics-auto exited with code ${code}`));
    });
  });
}

async function main() {
  const runOnStart = asBool(process.env.INGEST_AUTO_RUN_ON_START, true);
  const schedule = parseUtcClock(process.env.INGEST_AUTO_AT_UTC, "03:15");
  const retryMinutes = Math.max(1, Number.parseInt(String(process.env.INGEST_AUTO_RETRY_MINUTES || "30"), 10) || 30);

  console.log("[ingest:scheduler] Started");
  console.log(`[ingest:scheduler] Daily schedule (UTC): ${schedule.text}`);
  console.log(`[ingest:scheduler] Run on start: ${runOnStart}`);
  console.log(`[ingest:scheduler] Retry delay after failure (minutes): ${retryMinutes}`);

  if (runOnStart) {
    try {
      console.log("[ingest:scheduler] Running startup ingest");
      await runAutoIngest();
      console.log("[ingest:scheduler] Startup ingest completed");
    } catch (err) {
      console.error("[ingest:scheduler] Startup ingest failed", err?.message || err);
    }
  }

  // Forever loop: run once per day at configured UTC time.
  // If a run fails, wait retryMinutes and retry once before next schedule.
  while (true) {
    const now = new Date();
    const next = nextRunAt(schedule, now);
    const waitMs = Math.max(1000, next.getTime() - now.getTime());
    console.log(`[ingest:scheduler] Next run at ${next.toISOString()}`);
    await sleep(waitMs);

    let success = false;
    try {
      console.log("[ingest:scheduler] Running scheduled ingest");
      await runAutoIngest();
      success = true;
      console.log("[ingest:scheduler] Scheduled ingest completed");
    } catch (err) {
      console.error("[ingest:scheduler] Scheduled ingest failed", err?.message || err);
    }

    if (!success) {
      const retryMs = retryMinutes * 60 * 1000;
      console.log(`[ingest:scheduler] Retry in ${retryMinutes} minute(s)`);
      await sleep(retryMs);
      try {
        console.log("[ingest:scheduler] Running retry ingest");
        await runAutoIngest();
        console.log("[ingest:scheduler] Retry ingest completed");
      } catch (err) {
        console.error("[ingest:scheduler] Retry ingest failed", err?.message || err);
      }
    }
  }
}

main().catch((err) => {
  console.error("[ingest:scheduler] Fatal error", err);
  process.exit(1);
});
