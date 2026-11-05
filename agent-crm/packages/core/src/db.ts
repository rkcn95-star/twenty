import pg from 'pg';

export type Databases = {
  admin: pg.Pool;
  runtime: pg.Pool;
  close: () => Promise<void>;
};

export type DatabaseUrls = { adminUrl: string; runtimeUrl: string };

export const connect = ({ adminUrl, runtimeUrl }: DatabaseUrls): Databases => {
  const admin = new pg.Pool({ connectionString: adminUrl });
  const runtime = new pg.Pool({ connectionString: runtimeUrl });
  return { admin, runtime, close: async () => void (await Promise.all([admin.end(), runtime.end()])) };
};

export const inTransaction = async <TResult>(
  pool: pg.Pool,
  work: (client: pg.PoolClient) => Promise<TResult>,
  prepare?: (client: pg.PoolClient) => Promise<void>,
): Promise<TResult> => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (prepare) await prepare(client);
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
};
