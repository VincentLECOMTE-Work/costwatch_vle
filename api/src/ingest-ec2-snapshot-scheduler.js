import { spawn } from "node:child_process";

function asBool(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  const v = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(v)) return true;
  if (["0", "false", "no", "n", "off"].includes(v)) return false;
  return fallback;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function nextHourlyRunAt(minute, now = new Date()) {
  const current = new Date(now);
  const candidate = new Date(current);
  candidate.setUTCMinutes(minute, 0, 0);
  if (candidate <= current) candidate.setUTCHours(candidate.getUTCHours() + 1);
  return candidate;
}

function parseMinute(value, fallback = 5) {
  const n = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(n) || n < 0 || n > 59) return fallback;
  return n;
}

async function runSnapshot() {
  await new Promise((resolve, reject) => {
    const child = spawn("node", ["src/ingest-ec2-snapshot.js"], { stdio: "inherit" });
    child.on("close", (code) => {
      if (code === 0) return resolve();
      return reject(new Error(`ingest-ec2-snapshot exited with code ${code}`));
    });
  });
}

async function main() {
  const runOnStart = asBool(process.env.EC2_SNAPSHOT_RUN_ON_START, false);
  const minute = parseMinute(process.env.EC2_SNAPSHOT_MINUTE, 5);
  const retryMinutes = Math.max(1, Number.parseInt(String(process.env.EC2_SNAPSHOT_RETRY_MINUTES || "10"), 10) || 10);

  console.log("[ec2:snapshot:scheduler] Started");
  console.log(`[ec2:snapshot:scheduler] Hourly minute UTC: ${String(minute).padStart(2, "0")}`);
  console.log(`[ec2:snapshot:scheduler] Run on start: ${runOnStart}`);

  if (runOnStart) {
    try {
      console.log("[ec2:snapshot:scheduler] Running startup snapshot");
      await runSnapshot();
      console.log("[ec2:snapshot:scheduler] Startup snapshot completed");
    } catch (err) {
      console.error("[ec2:snapshot:scheduler] Startup snapshot failed", err?.message || err);
    }
  }

  while (true) {
    const now = new Date();
    const next = nextHourlyRunAt(minute, now);
    const waitMs = Math.max(1000, next.getTime() - now.getTime());
    console.log(`[ec2:snapshot:scheduler] Next run at ${next.toISOString()}`);
    await sleep(waitMs);

    try {
      console.log("[ec2:snapshot:scheduler] Running scheduled snapshot");
      await runSnapshot();
      console.log("[ec2:snapshot:scheduler] Scheduled snapshot completed");
    } catch (err) {
      console.error("[ec2:snapshot:scheduler] Scheduled snapshot failed", err?.message || err);
      const retryMs = retryMinutes * 60 * 1000;
      console.log(`[ec2:snapshot:scheduler] Retry in ${retryMinutes} minute(s)`);
      await sleep(retryMs);
      try {
        console.log("[ec2:snapshot:scheduler] Running retry snapshot");
        await runSnapshot();
        console.log("[ec2:snapshot:scheduler] Retry snapshot completed");
      } catch (retryErr) {
        console.error("[ec2:snapshot:scheduler] Retry snapshot failed", retryErr?.message || retryErr);
      }
    }
  }
}

main().catch((err) => {
  console.error("[ec2:snapshot:scheduler] Fatal error", err);
  process.exit(1);
});

