import { ensureSchema } from "./ensure-schema.js";
ensureSchema().then(()=>{ console.log("Migrations done."); process.exit(0); }).catch(e=>{ console.error(e); process.exit(1); });
