import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * Phase 5 (requested verification) — the shared-state guarantees proven by
 * TWO REAL Node processes, not two in-process clients. Each side is a spawned
 * `tsx scripts/shared-state-worker.mts` child that coordinates with the other
 * ONLY through Redis, exactly like two deployed server instances.
 *
 * Proven here across OS processes: (1) racing budget reserves admit exactly
 * one winner, (2) a duplicate active request is refused cross-process, and
 * (3) a cancel issued by process B aborts the run inside process A.
 *
 * Gated like tests/shared-state.test.ts: skipped without Redis unless
 * FQMG_REQUIRE_REDIS_TESTS=1 (set by CI), where an unreachable server FAILS.
 */

const REDIS_URL = process.env.FQMG_TEST_REDIS_URL?.trim() || "redis://127.0.0.1:6399";
const REQUIRE_REDIS = process.env.FQMG_REQUIRE_REDIS_TESTS === "1";

let redisAvailable = false;
let redisProbeError = "";

beforeAll(async () => {
  try {
    const { createClient } = await import("redis");
    const probe = createClient({ socket: { connectTimeout: 2_000 }, url: REDIS_URL });
    probe.on("error", () => undefined);
    await probe.connect();
    await probe.ping();
    await probe.quit();
    redisAvailable = true;
  } catch (error) {
    redisProbeError = error instanceof Error ? error.message : String(error);
  }
});

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const TSX = path.join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
const WORKER = path.join(repoRoot, "scripts", "shared-state-worker.mts");

type WorkerRecord = Record<string, unknown>;

interface WorkerRun {
  lines: WorkerRecord[];
  stderr: string;
  exitCode: number | null;
  done: Promise<void>;
}

function spawnWorker(args: string[]): WorkerRun {
  const child: ChildProcessByStdio<null, Readable, Readable> = spawn(
    process.execPath,
    [TSX, WORKER, ...args],
    { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] },
  );
  const run: WorkerRun = { lines: [], stderr: "", exitCode: null, done: Promise.resolve() };
  run.done = new Promise<void>((resolve) => {
    let buffer = "";
    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) {
          try {
            run.lines.push(JSON.parse(line) as WorkerRecord);
          } catch {
            run.stderr += `[unparseable stdout] ${line}\n`;
          }
        }
        newline = buffer.indexOf("\n");
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      run.stderr += chunk.toString("utf8");
    });
    child.on("close", (code) => {
      run.exitCode = code;
      resolve();
    });
  });
  return run;
}

function lineOf(run: WorkerRun, match: (record: WorkerRecord) => boolean): WorkerRecord {
  const found = run.lines.find(match);
  if (!found) {
    throw new Error(
      `worker produced no matching line.\nlines: ${JSON.stringify(run.lines)}\nstderr: ${run.stderr.slice(0, 400)}`,
    );
  }
  return found;
}

async function withRedis(run: () => Promise<void>): Promise<void> {
  if (redisAvailable) {
    await run();
    return;
  }
  if (REQUIRE_REDIS) {
    throw new Error(
      `FQMG_REQUIRE_REDIS_TESTS=1 but Redis is unreachable at ${REDIS_URL}: ${redisProbeError}`,
    );
  }
  console.warn(`[two-process] skipping — no Redis at ${REDIS_URL}`);
}

describe("phase 5: two real Node processes share one Redis", () => {
  it(
    "racing budget reserves across processes admit exactly one winner (2 rounds)",
    { skip: !redisAvailable && !REQUIRE_REDIS, timeout: 60_000 },
    async () => {
      await withRedis(async () => {
        for (let round = 0; round < 2; round += 1) {
          const namespace = `tp:${randomUUID()}`;
          const a = spawnWorker(["a", "race", REDIS_URL, namespace]);
          const b = spawnWorker(["b", "race", REDIS_URL, namespace]);
          await Promise.all([a.done, b.done]);

          const ra = lineOf(a, (line) => line.role === "a" && "ok" in line);
          const rb = lineOf(b, (line) => line.role === "b" && "ok" in line);
          const winners = [ra.ok, rb.ok].filter(Boolean).length;
          expect(winners, `round ${round}: a=${JSON.stringify(ra)} b=${JSON.stringify(rb)}`).toBe(1);
          expect(a.exitCode, String(a.stderr).slice(0, 300)).toBe(0);
          expect(b.exitCode, String(b.stderr).slice(0, 300)).toBe(0);
        }
      });
    },
  );

  it(
    "a duplicate active request is refused in the second process (shared dedupe)",
    { skip: !redisAvailable && !REQUIRE_REDIS, timeout: 60_000 },
    async () => {
      await withRedis(async () => {
        const namespace = `tp:${randomUUID()}`;
        const dedupeKey = `dk-${randomUUID()}`;
        const a = spawnWorker(["a", "dedupe", REDIS_URL, namespace, dedupeKey]);
        // wait for A to report its job started before B attacks
        await new Promise<void>((resolve, reject) => {
          const deadline = Date.now() + 20_000;
          const poll = setInterval(() => {
            const started = a.lines.find((line) => line.event === "started");
            if (started) {
              clearInterval(poll);
              resolve();
            } else if (Date.now() > deadline) {
              clearInterval(poll);
              reject(new Error(`A never started: ${JSON.stringify(a.lines)} ${a.stderr.slice(0, 300)}`));
            }
          }, 100);
        });

        const b = spawnWorker(["b", "dedupe", REDIS_URL, namespace, dedupeKey]);
        await Promise.all([a.done, b.done]);

        const rb = lineOf(b, (line) => line.role === "b" && "conflicted" in line);
        expect(rb.conflicted).toBe(true);
        const ra = lineOf(a, (line) => line.event === "final");
        expect(ra.status).toBe("passed"); // A's own run was untouched and finished normally
        expect(b.exitCode, String(b.stderr).slice(0, 300)).toBe(0);
      });
    },
  );

  it(
    "a cancel issued by process B aborts the run inside process A",
    { skip: !redisAvailable && !REQUIRE_REDIS, timeout: 60_000 },
    async () => {
      await withRedis(async () => {
        const namespace = `tp:${randomUUID()}`;
        const dedupeKey = `dk-${randomUUID()}`;
        const a = spawnWorker(["a", "cancel", REDIS_URL, namespace, dedupeKey]);
        await new Promise<void>((resolve, reject) => {
          const deadline = Date.now() + 20_000;
          const poll = setInterval(() => {
            const started = a.lines.find((line) => line.event === "started");
            if (started) {
              clearInterval(poll);
              resolve();
            } else if (Date.now() > deadline) {
              clearInterval(poll);
              reject(new Error(`A never started: ${JSON.stringify(a.lines)} ${a.stderr.slice(0, 300)}`));
            }
          }, 100);
        });
        const jobId = String(lineOf(a, (line) => line.event === "started").jobId);

        const b = spawnWorker(["b", "cancel", REDIS_URL, namespace, dedupeKey, jobId]);
        await Promise.all([a.done, b.done]);

        const rb = lineOf(b, (line) => line.role === "b" && "cancelled" in line);
        expect(rb.cancelled).toBe(true);
        const ra = lineOf(a, (line) => line.event === "final");
        expect(ra.status).toBe("cancelled");
        expect(b.exitCode, String(b.stderr).slice(0, 300)).toBe(0);
      });
    },
  );
});
