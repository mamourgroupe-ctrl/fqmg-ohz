import { createClient, type RedisClientType } from "redis";

/**
 * Phase 5 — shared Redis client for the budget ledger and job registry.
 *
 * One lazy, process-wide client per (url) is reused; operations that hit a
 * dead server surface a `store-unavailable` error so callers can FAIL CLOSED
 * instead of silently falling back to process-local state (that fallback is
 * exactly the multi-instance correctness bug this phase removes).
 */

export type SharedStoreUnavailableError = Error & { code: "store-unavailable" };

export function storeUnavailable(cause: unknown): SharedStoreUnavailableError {
  const detail = cause instanceof Error ? cause.message : String(cause);
  const error = new Error(
    `The shared state store is unavailable, so the request was refused (fail-closed). Detail withheld.`,
  ) as SharedStoreUnavailableError;
  error.code = "store-unavailable";
  // operators still get the sanitized reason in the log, users get the generic line
  console.error("[shared-state] store operation failed:", detail.slice(0, 200));
  return error;
}

export interface RedisHandle {
  client: RedisClientType;
  close(): Promise<void>;
}

export interface RedisConnectOptions {
  redisUrl: string;
  connectTimeoutMs?: number;
}

/**
 * Connects once per handle. The promise rejects with a store-unavailable
 * error when the server cannot be reached within the timeout.
 */
export function connectRedis(options: RedisConnectOptions): Promise<RedisHandle> {
  const timeoutMs = options.connectTimeoutMs ?? 3_000;
  return new Promise<RedisHandle>((resolve, reject) => {
    const client = createClient({
      url: options.redisUrl,
      socket: { connectTimeout: timeoutMs, reconnectStrategy: (retries) => (retries >= 2 ? new Error("giving up") : Math.min(100 * 2 ** retries, 500)) },
    }) as RedisClientType;
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      void client.quit().catch(() => undefined);
      reject(storeUnavailable(new Error(`connect timeout after ${timeoutMs}ms`)));
    }, timeoutMs);

    client.on("error", (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(storeUnavailable(error));
    });
    client
      .connect()
      .then(() => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({
          client,
          close: async () => {
            await client.quit().catch(() => undefined);
          },
        });
      })
      .catch((error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(storeUnavailable(error));
      });
  });
}

/** Runs an operation with a fresh short-lived client (used by probes/tests). */
export async function withRedisClient<T>(
  options: RedisConnectOptions,
  run: (client: RedisClientType) => Promise<T>,
): Promise<T> {
  const handle = await connectRedis(options);
  try {
    return await run(handle.client);
  } finally {
    await handle.close();
  }
}
