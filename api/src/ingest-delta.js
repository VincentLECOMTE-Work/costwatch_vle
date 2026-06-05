import { spawn } from "node:child_process";

function iso(d){ return d.toISOString().slice(0,10); }
const days = Number(process.env.DELTA_DAYS||3);
const end = new Date(); // CE End is exclusive; end=today is fine
const start = new Date(); start.setUTCDate(start.getUTCDate()-days);

const metrics = (process.env.CE_METRICS||"UnblendedCost").split(",").map(s=>s.trim()).filter(Boolean);

(async ()=>{
  for (const m of metrics){
    console.log(`>> delta ingest ${m} from ${iso(start)} to ${iso(end)}`);
    await new Promise((resolve,reject)=>{
      const cp = spawn("node", ["src/ingest-ce.js","--metric",m,"--from",iso(start),"--to",iso(end)], { stdio:"inherit" });
      cp.on("close",(code)=> code===0? resolve(): reject(new Error("ingest-ce failed: "+code)) );
    });
  }
})().catch(e=>{ console.error(e); process.exit(1); });
