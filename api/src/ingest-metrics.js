import { spawn } from "node:child_process";

function arg(name, def){ const i = process.argv.indexOf("--"+name); return i>-1 ? process.argv[i+1] : def; }

const start = arg("from");
const end   = arg("to");
if (!start || !end){
  console.error("Missing --from/--to");
  process.exit(2);
}

const metrics = (process.env.CE_METRICS || "UnblendedCost")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

async function runCmd(cmd, args){
  await new Promise((resolve, reject) => {
    const cp = spawn(cmd, args, { stdio: "inherit" });
    cp.on("close", (code) => code === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(" ")} failed: ${code}`)));
  });
}

async function main(){
  // 1) Ingestion des coûts (séquentiel)
  for (const m of metrics){
    console.log(`>> ingest metric ${m}`);
    await runCmd("node", ["src/ingest-ce.js", "--metric", m, "--from", start, "--to", end]);
  }

  // 2) Ingestion RI *après* les coûts (évite toute concurrence de création de tables)
  const ingestRI = String(process.env.INGEST_RI || "true").toLowerCase() !== "false";
  if (ingestRI){
    console.log(">> ingest RI coverage/utilization");
    await runCmd("node", ["src/ingest-ri.js", "--from", start, "--to", end]);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
