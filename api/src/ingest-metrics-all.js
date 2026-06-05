// Run CE metrics + S3 range with same --from/--to args
import { spawn } from "child_process";

function run(cmd, args){ return new Promise((resolve, reject)=>{
  const p = spawn(cmd, args, { stdio: "inherit", shell: false });
  p.on("exit", code => code===0 ? resolve() : reject(new Error(cmd+" exited "+code)));
});}

const args = process.argv.slice(2);

// First Cost Explorer metrics (existing script)
await run("node", ["src/ingest-metrics.js", ...args]);

// Then S3 sizes over the same range
await run("node", ["src/ingest-s3-range.js", ...args]);
