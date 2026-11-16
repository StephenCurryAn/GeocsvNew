import type { Pool, PoolClient } from 'pg';

export const connectSafely = async (db: Pool) => {
  const client = await db.connect();
  let connectionError: Error | undefined;
  const onError = (error: Error) => { connectionError = error; };
  // pg-pool only handles errors while a client is idle, not while checked out.
  client.on('error', onError);
  return {
    client,
    release(discard = false) {
      client.removeListener('error', onError);
      client.release(connectionError || discard);
    },
  };
};

export const transaction = async <T>(
  db: Pool, begin: string, work: (client: PoolClient) => Promise<T>,
): Promise<T> => {
  const { client, release } = await connectSafely(db);
  let discard = false;
  try {
    await client.query(begin);
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); }
    catch { discard = true; }
    throw error;
  } finally { release(discard); }
};
