import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { attachDatabasePool } from "@vercel/functions";
import { Pool } from "pg";
import * as schema from "./schema";

const globalForDb = globalThis as unknown as {
  pgPool?: Pool;
  db?: NodePgDatabase<typeof schema>;
};

function createDb() {
  // Serverless hosts run many instances, each with its own pool, so keep it
  // small in production and let Neon's pooled endpoint do the multiplexing.
  const pool =
    globalForDb.pgPool ??
    new Pool({
      connectionString: process.env.DATABASE_URL,
      max: process.env.NODE_ENV === "production" ? 3 : 10,
      idleTimeoutMillis: 10_000,
    });
  // Neon closes connections when its compute suspends. Without a listener the
  // pool's "error" event on an idle client would crash the process.
  pool.on("error", (err) => console.error("[db] idle client error:", err.message));
  // On Vercel Fluid compute this closes idle clients before an instance is
  // suspended; elsewhere it's a no-op.
  attachDatabasePool(pool);
  globalForDb.pgPool = pool;
  return drizzle(pool, { schema });
}

// Reuse the pool across hot reloads in dev.
export const db = globalForDb.db ?? createDb();
globalForDb.db = db;

export type DB = typeof db;
export type Tx = Parameters<Parameters<DB["transaction"]>[0]>[0];
export { schema };
