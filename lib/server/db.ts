import { Pool, type PoolClient } from "pg";

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error("DATABASE_URL is required");
}

const globalForDb = globalThis as unknown as {
  pool?: Pool;
};

export const pool =
  globalForDb.pool ??
  new Pool({
    connectionString,
    ssl: { rejectUnauthorized: false },
    // Prevent long hangs when DATABASE_URL points to an unreachable host.
    connectionTimeoutMillis: Number(process.env.PG_CONNECTION_TIMEOUT_MS ?? 3000),
  });

if (!globalForDb.pool) {
  globalForDb.pool = pool;
}

export async function runWithUserContext<T>(
  email: string,
  callback: (client: PoolClient) => Promise<T>,
) {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    await client.query("select set_config($1, $2, true)", ["app.current_user_email", email]);
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
