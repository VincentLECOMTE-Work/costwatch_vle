import pg from 'pg';
const { Pool } = pg;
const { DATABASE_URL } = process.env;
export const pool = new Pool({ connectionString: DATABASE_URL });
export async function query(sql, params = []){
  const c = await pool.connect();
  try { return await c.query(sql, params); } finally { c.release(); }
}
