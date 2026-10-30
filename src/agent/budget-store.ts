import { randomUUID } from "node:crypto";
import { connectRedis, storeUnavailable, type RedisHandle } from "@/shared/redis-client";

/**
 * Phase 5 — budget state backends.
 *
 * The DECISIONS that need shared state (duplicate active reservation per
 * task, the daily ceiling, the per-user daily ceiling, the settled-spend
 * accounting) are enforced ATOMICALLY inside the backend:
 *  - LocalBudgetBackend: the previous process-local Map behavior, unchanged;
 *  - RedisBudgetBackend: the same decisions as a Lua script, so two server
 *    instances racing on the last slice of budget cannot both win.
 *
 * Policy that needs no shared state (pricing validation, approval parsing)
 * stays in BudgetLedger; backends receive already-validated integers
 * (micro-USD) plus the approval cap. The ledger composes every user-facing
 * message, so wording is identical between backends.
 */

export type BudgetBackendKind = "process-local" | "shared-redis";

export type MicroUsd = number;

export interface BudgetReserveCommand {
  dayUtc: string;
  reservationId: string;
  taskId: string;
  estimateMicros: MicroUsd;
  user?: string;
  approvalUsed: boolean;
  /** Approval ceiling in micro-USD, or -1 when no approval was supplied. */
  approvalMaxMicros: MicroUsd;
  dailyLimitMicros: MicroUsd;
  taskLimitMicros: MicroUsd;
  /** Per-user daily ceiling in micro-USD, or -1 when unset (daily limit applies). */
  userDailyLimitMicros: MicroUsd;
  nowMs: number;
}

export type BackendRefusalCode =
  | "duplicate-reservation"
  | "daily-limit-exceeded"
  | "task-limit-exceeded"
  | "store-unavailable";

export type BudgetReserveResult =
  | {
      ok: true;
      reservationId: string;
      estimateMicros: MicroUsd;
      approvalUsed: boolean;
      remainingDailyMicros: MicroUsd;
    }
  | {
      ok: false;
      code: BackendRefusalCode;
      remainingDailyMicros?: MicroUsd;
      effectiveRemainingMicros?: MicroUsd;
      userCeilingBinding?: boolean;
    };

export type BudgetMutateResult =
  | {
      ok: true;
      reservationId: string;
      estimateMicros: MicroUsd;
      approvalUsed: boolean;
      remainingDailyMicros: MicroUsd;
    }
  | { ok: false; code: "unknown-reservation" | "invalid-estimate" | "store-unavailable" };

export interface BudgetSnapshotData {
  dayUtc: string;
  reservedMicros: MicroUsd;
  settledMicros: MicroUsd;
  activeCount: number;
  taskIds: string[];
}

export interface BudgetBackend {
  readonly kind: BudgetBackendKind;
  reserve(command: BudgetReserveCommand): Promise<BudgetReserveResult>;
  settle(reservationId: string, actualMicros: MicroUsd, dailyLimitMicros: MicroUsd): Promise<BudgetMutateResult>;
  release(reservationId: string, dailyLimitMicros: MicroUsd): Promise<BudgetMutateResult>;
  getReservation(
    reservationId: string,
  ): Promise<{ estimateMicros: MicroUsd; approvalUsed: boolean } | undefined | "store-unavailable">;
  snapshot(dayUtc: string): Promise<BudgetSnapshotData | "store-unavailable">;
  close(): Promise<void>;
}

export function toMicroUsd(value: number): MicroUsd {
  return Math.round(value * 1_000_000);
}

export function fromMicroUsd(value: MicroUsd): number {
  return Math.round(value) / 1_000_000;
}

/** Backwards-compatible unique reservation ids. */
export function newReservationId(): string {
  return `reservation-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
}

// ─── Local backend (the original process-local semantics, extracted) ─────────

interface LocalReservation {
  reservationId: string;
  taskId: string;
  estimateMicros: MicroUsd;
  createdAt: number;
  approvalUsed: boolean;
  user?: string;
}

interface LocalDayState {
  settledMicros: MicroUsd;
  settledByUser: Map<string, MicroUsd>;
  reservations: Map<string, LocalReservation>;
}

function committedOf(state: LocalDayState): MicroUsd {
  let reserved = 0;
  for (const reservation of state.reservations.values()) reserved += reservation.estimateMicros;
  return reserved + state.settledMicros;
}

export class LocalBudgetBackend implements BudgetBackend {
  readonly kind: BudgetBackendKind = "process-local";
  private readonly days = new Map<string, LocalDayState>();

  constructor(options: { now?: () => number } = {}) {
    // timestamps arrive per-command (command.nowMs) so day keys and ordering
    // stay consistent with the ledger's injected clock
    void options;
  }

  private dayState(dayUtc: string): LocalDayState {
    let state = this.days.get(dayUtc);
    if (!state) {
      state = { settledMicros: 0, settledByUser: new Map(), reservations: new Map() };
      this.days.set(dayUtc, state);
      // bounded: only the two most recent days can be alive at once
      if (this.days.size > 2) {
        const oldest = this.days.keys().next().value;
        if (oldest !== undefined && oldest !== dayUtc) this.days.delete(oldest);
      }
    }
    return state;
  }

  async reserve(command: BudgetReserveCommand): Promise<BudgetReserveResult> {
    const state = this.dayState(command.dayUtc);

    for (const reservation of state.reservations.values()) {
      if (reservation.taskId === command.taskId) {
        return { ok: false, code: "duplicate-reservation" };
      }
    }

    const committed = committedOf(state);
    const remainingDaily = command.dailyLimitMicros - committed;
    let effectiveRemaining = remainingDaily;
    let userCeilingBinding = false;
    if (command.user) {
      const userLimit =
        command.userDailyLimitMicros >= 0 ? command.userDailyLimitMicros : command.dailyLimitMicros;
      let userCommitted = state.settledByUser.get(command.user) ?? 0;
      for (const reservation of state.reservations.values()) {
        if (reservation.user === command.user) userCommitted += reservation.estimateMicros;
      }
      const remainingForUser = userLimit - userCommitted;
      if (remainingForUser < effectiveRemaining) {
        effectiveRemaining = remainingForUser;
        userCeilingBinding = true;
      }
    }

    if (command.estimateMicros > effectiveRemaining) {
      return {
        ok: false,
        code: "daily-limit-exceeded",
        remainingDailyMicros: remainingDaily,
        effectiveRemainingMicros: effectiveRemaining,
        userCeilingBinding,
      };
    }

    const cap = command.approvalMaxMicros >= 0 ? command.approvalMaxMicros : command.taskLimitMicros;
    if (command.estimateMicros > command.taskLimitMicros && command.estimateMicros > cap) {
      return { ok: false, code: "task-limit-exceeded" };
    }

    state.reservations.set(command.reservationId, {
      reservationId: command.reservationId,
      taskId: command.taskId,
      estimateMicros: command.estimateMicros,
      createdAt: command.nowMs,
      approvalUsed: command.approvalUsed,
      ...(command.user ? { user: command.user } : {}),
    });

    return {
      ok: true,
      reservationId: command.reservationId,
      estimateMicros: command.estimateMicros,
      approvalUsed: command.approvalUsed,
      remainingDailyMicros: command.dailyLimitMicros - committedOf(state),
    };
  }

  async settle(
    reservationId: string,
    actualMicros: MicroUsd,
    dailyLimitMicros: MicroUsd,
  ): Promise<BudgetMutateResult> {
    for (const state of this.days.values()) {
      const reservation = state.reservations.get(reservationId);
      if (!reservation) continue;
      state.reservations.delete(reservationId);
      state.settledMicros += actualMicros;
      if (reservation.user) {
        state.settledByUser.set(
          reservation.user,
          (state.settledByUser.get(reservation.user) ?? 0) + actualMicros,
        );
      }
      return {
        ok: true,
        reservationId,
        estimateMicros: actualMicros,
        approvalUsed: reservation.approvalUsed,
        remainingDailyMicros: dailyLimitMicros - committedOf(state),
      };
    }
    return { ok: false, code: "unknown-reservation" };
  }

  async release(reservationId: string, dailyLimitMicros: MicroUsd): Promise<BudgetMutateResult> {
    for (const state of this.days.values()) {
      const reservation = state.reservations.get(reservationId);
      if (!reservation) continue;
      state.reservations.delete(reservationId);
      return {
        ok: true,
        reservationId,
        estimateMicros: reservation.estimateMicros,
        approvalUsed: reservation.approvalUsed,
        remainingDailyMicros: dailyLimitMicros - committedOf(state),
      };
    }
    return { ok: false, code: "unknown-reservation" };
  }

  async getReservation(
    reservationId: string,
  ): Promise<{ estimateMicros: MicroUsd; approvalUsed: boolean } | undefined | "store-unavailable"> {
    for (const state of this.days.values()) {
      const reservation = state.reservations.get(reservationId);
      if (reservation) {
        return { estimateMicros: reservation.estimateMicros, approvalUsed: reservation.approvalUsed };
      }
    }
    return undefined;
  }

  async snapshot(dayUtc: string): Promise<BudgetSnapshotData | "store-unavailable"> {
    const state = this.dayState(dayUtc);
    let reserved = 0;
    const taskIds: string[] = [];
    for (const reservation of state.reservations.values()) {
      reserved += reservation.estimateMicros;
      taskIds.push(reservation.taskId);
    }
    return {
      dayUtc,
      reservedMicros: reserved,
      settledMicros: state.settledMicros,
      activeCount: state.reservations.size,
      taskIds,
    };
  }

  async close(): Promise<void> {
    this.days.clear();
  }
}

// ─── Redis backend (same decisions, atomically via Lua) ──────────────────────

const DAY_TTL_MS = 48 * 60 * 60 * 1_000; // aggregates outlive the UTC day
const RESERVATION_TTL_MS = 24 * 60 * 60 * 1_000; // leaked reservations self-expire

const RESERVE_SCRIPT = `
local dayKey = KEYS[1]
local tasksKey = KEYS[2]
local resPrefix = ARGV[1]
local resId = ARGV[2]
local taskId = ARGV[3]
local est = tonumber(ARGV[4])
local user = ARGV[5]
local dailyLimit = tonumber(ARGV[6])
local taskLimit = tonumber(ARGV[7])
local userLimit = tonumber(ARGV[8])
local approvalMax = tonumber(ARGV[9])
local dayTtlMs = tonumber(ARGV[10])
local resTtlMs = tonumber(ARGV[11])
local dayUtc = ARGV[12]

local settled = tonumber(redis.call('HGET', dayKey, 's') or '0')
local reserved = 0
local userReserved = 0
local taskIds = redis.call('HKEYS', tasksKey)
for _, tid in ipairs(taskIds) do
  local rid = redis.call('HGET', tasksKey, tid)
  if rid then
    local rk = resPrefix .. rid
    if redis.call('EXISTS', rk) == 1 then
      local resEst = tonumber(redis.call('HGET', rk, 'est') or '0')
      reserved = reserved + resEst
      if user ~= '' and redis.call('HGET', rk, 'user') == user then
        userReserved = userReserved + resEst
      end
    else
      redis.call('HDEL', tasksKey, tid)
    end
  end
end

local duplicate = redis.call('HGET', tasksKey, taskId)
if duplicate and redis.call('EXISTS', resPrefix .. duplicate) == 1 then
  return {'duplicate-reservation'}
end

local committed = settled + reserved
local remainingDaily = dailyLimit - committed
local effectiveRemaining = remainingDaily
local userCeilingBinding = 0
if user ~= '' then
  local limit = userLimit
  if limit < 0 then limit = dailyLimit end
  local userCommitted = tonumber(redis.call('HGET', dayKey, 'u:' .. user) or '0') + userReserved
  local userRemaining = limit - userCommitted
  if userRemaining < effectiveRemaining then
    effectiveRemaining = userRemaining
    userCeilingBinding = 1
  end
end

if est > effectiveRemaining then
  return {'daily-limit-exceeded', tostring(remainingDaily), tostring(effectiveRemaining), tostring(userCeilingBinding)}
end

-- an approval can raise the per-task cap, never the daily/user ceilings
if est > taskLimit and not (approvalMax >= est) then
  return {'task-limit-exceeded'}
end

redis.call('HSET', resPrefix .. resId, 'taskId', taskId, 'user', user, 'est', ARGV[4], 'day', dayUtc)
redis.call('HSET', tasksKey, taskId, resId)
redis.call('PEXPIRE', dayKey, dayTtlMs)
redis.call('PEXPIRE', tasksKey, dayTtlMs)
redis.call('PEXPIRE', resPrefix .. resId, resTtlMs)
return {'ok', tostring(dailyLimit - (committed + est))}
`;

const SETTLE_SCRIPT = `
local resKey = KEYS[1]
local dayPrefix = ARGV[1]
local tasksPrefix = ARGV[2]
local dailyLimit = tonumber(ARGV[3])
local actual = tonumber(ARGV[4])
local dayTtlMs = tonumber(ARGV[5])

local taskId = redis.call('HGET', resKey, 'taskId')
if not taskId then return {'unknown'} end
local user = redis.call('HGET', resKey, 'user')
local day = redis.call('HGET', resKey, 'day')
local appr = redis.call('HGET', resKey, 'appr') or '0'
local est = tonumber(redis.call('HGET', resKey, 'est') or '0')
redis.call('DEL', resKey)

local dayKey = dayPrefix .. day
local tasksKey = tasksPrefix .. day
redis.call('HDEL', tasksKey, taskId)
redis.call('HINCRBY', dayKey, 's', actual)
if user and user ~= '' then redis.call('HINCRBY', dayKey, 'u:' .. user, actual) end
redis.call('PEXPIRE', dayKey, dayTtlMs)

local reserved = 0
local taskIds = redis.call('HKEYS', tasksKey)
for _, tid in ipairs(taskIds) do
  local rid = redis.call('HGET', tasksKey, tid)
  if rid then
    local rk = string.gsub(tasksPrefix, ':t:', ':r:') .. rid
    if redis.call('EXISTS', rk) == 1 then
      reserved = reserved + tonumber(redis.call('HGET', rk, 'est') or '0')
    else
      redis.call('HDEL', tasksKey, tid)
    end
  end
end
local remaining = dailyLimit - (tonumber(redis.call('HGET', dayKey, 's') or '0') + reserved)
return {'ok', appr, tostring(remaining)}
`;

const RELEASE_SCRIPT = `
local resKey = KEYS[1]
local dayPrefix = ARGV[1]
local tasksPrefix = ARGV[2]
local dailyLimit = tonumber(ARGV[3])
local dayTtlMs = tonumber(ARGV[5])

local taskId = redis.call('HGET', resKey, 'taskId')
if not taskId then return {'unknown'} end
local day = redis.call('HGET', resKey, 'day')
local appr = redis.call('HGET', resKey, 'appr') or '0'
local est = tonumber(redis.call('HGET', resKey, 'est') or '0')
redis.call('DEL', resKey)

local dayKey = dayPrefix .. day
local tasksKey = tasksPrefix .. day
redis.call('HDEL', tasksKey, taskId)
redis.call('PEXPIRE', dayKey, dayTtlMs)

local reserved = 0
local taskIds = redis.call('HKEYS', tasksKey)
for _, tid in ipairs(taskIds) do
  local rid = redis.call('HGET', tasksKey, tid)
  if rid then
    local rk = string.gsub(tasksPrefix, ':t:', ':r:') .. rid
    if redis.call('EXISTS', rk) == 1 then
      reserved = reserved + tonumber(redis.call('HGET', rk, 'est') or '0')
    else
      redis.call('HDEL', tasksKey, tid)
    end
  end
end
local settled = tonumber(redis.call('HGET', dayKey, 's') or '0')
local remaining = dailyLimit - (settled + reserved)
return {'ok', appr, tostring(est), tostring(remaining)}
`;

const SNAPSHOT_SCRIPT = `
local dayKey = KEYS[1]
local tasksKey = KEYS[2]
local resPrefix = ARGV[1]
local settled = tonumber(redis.call('HGET', dayKey, 's') or '0')
local reserved = 0
local active = 0
local taskIds = {}
local taskIndex = redis.call('HKEYS', tasksKey)
for _, tid in ipairs(taskIndex) do
  local rid = redis.call('HGET', tasksKey, tid)
  if rid then
    local rk = resPrefix .. rid
    if redis.call('EXISTS', rk) == 1 then
      reserved = reserved + tonumber(redis.call('HGET', rk, 'est') or '0')
      active = active + 1
      table.insert(taskIds, tid)
    else
      redis.call('HDEL', tasksKey, tid)
    end
  end
end
return {tostring(settled), tostring(reserved), tostring(active), unpack(taskIds)}
`;

interface EvalClient {
  eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>;
  hGet(key: string, field: string): Promise<string | undefined>;
  hGetAll(key: string): Promise<Record<string, string>>;
}

export class RedisBudgetBackend implements BudgetBackend {
  readonly kind: BudgetBackendKind = "shared-redis";
  private readonly namespace: string;
  private readonly redisUrl: string;
  private readonly connectTimeoutMs: number;
  private handle: Promise<RedisHandle> | null = null;
  private dead = false;

  constructor(options: { redisUrl: string; namespace: string; connectTimeoutMs?: number }) {
    this.redisUrl = options.redisUrl;
    this.namespace = options.namespace;
    this.connectTimeoutMs = options.connectTimeoutMs ?? 3_000;
  }

  private prefixes(): { dayPrefix: string; tasksPrefix: string; resPrefix: string } {
    const base = `fqmg:b:${this.namespace}:`;
    return { dayPrefix: `${base}d:`, tasksPrefix: `${base}t:`, resPrefix: `${base}r:` };
  }

  private async client(): Promise<EvalClient> {
    if (this.dead) throw storeUnavailable(new Error("backend closed"));
    this.handle ??= connectRedis({
      redisUrl: this.redisUrl,
      connectTimeoutMs: this.connectTimeoutMs,
    }).catch((error: unknown) => {
      this.handle = null;
      throw error;
    });
    const handle = await this.handle;
    return handle.client as unknown as EvalClient;
  }

  async reserve(command: BudgetReserveCommand): Promise<BudgetReserveResult> {
    const { dayPrefix, tasksPrefix, resPrefix } = this.prefixes();
    try {
      const reply = (await (
        await this.client()
      ).eval(RESERVE_SCRIPT, {
        keys: [`${dayPrefix}${command.dayUtc}`, `${tasksPrefix}${command.dayUtc}`],
        arguments: [
          resPrefix,
          command.reservationId,
          command.taskId,
          String(command.estimateMicros),
          command.user ?? "",
          String(command.dailyLimitMicros),
          String(command.taskLimitMicros),
          String(command.userDailyLimitMicros),
          String(command.approvalMaxMicros),
          String(DAY_TTL_MS),
          String(RESERVATION_TTL_MS),
          command.dayUtc,
        ],
      })) as string[];
      const [code, ...rest] = reply;
      if (code === "ok") {
        return {
          ok: true,
          reservationId: command.reservationId,
          estimateMicros: command.estimateMicros,
          approvalUsed: command.approvalUsed,
          remainingDailyMicros: Number(rest[0] ?? 0),
        };
      }
      if (code === "daily-limit-exceeded") {
        return {
          ok: false,
          code,
          remainingDailyMicros: Number(rest[0] ?? 0),
          effectiveRemainingMicros: Number(rest[1] ?? 0),
          userCeilingBinding: rest[2] === "1",
        };
      }
      return { ok: false, code: code as BackendRefusalCode };
    } catch {
      return { ok: false, code: "store-unavailable" };
    }
  }

  async settle(
    reservationId: string,
    actualMicros: MicroUsd,
    dailyLimitMicros: MicroUsd,
  ): Promise<BudgetMutateResult> {
    return this.mutate(SETTLE_SCRIPT, reservationId, actualMicros, dailyLimitMicros);
  }

  async release(reservationId: string, dailyLimitMicros: MicroUsd): Promise<BudgetMutateResult> {
    return this.mutate(RELEASE_SCRIPT, reservationId, undefined, dailyLimitMicros);
  }

  private async mutate(
    script: string,
    reservationId: string,
    actualMicros: MicroUsd | undefined,
    dailyLimitMicros: MicroUsd,
  ): Promise<BudgetMutateResult> {
    const { dayPrefix, tasksPrefix, resPrefix } = this.prefixes();
    try {
      const reply = (await (
        await this.client()
      ).eval(script, {
        keys: [`${resPrefix}${reservationId}`],
        arguments: [
          dayPrefix,
          tasksPrefix,
          String(dailyLimitMicros),
          String(actualMicros ?? 0),
          String(DAY_TTL_MS),
        ],
      })) as string[];
      if (reply[0] === "unknown") return { ok: false, code: "unknown-reservation" };
      const estimate = actualMicros ?? Number(reply[2] ?? 0);
      const remaining = actualMicros === undefined ? Number(reply[3] ?? 0) : Number(reply[2] ?? 0);
      return {
        ok: true,
        reservationId,
        estimateMicros: estimate,
        approvalUsed: reply[1] === "1",
        remainingDailyMicros: remaining,
      };
    } catch {
      return { ok: false, code: "store-unavailable" };
    }
  }

  async getReservation(
    reservationId: string,
  ): Promise<{ estimateMicros: MicroUsd; approvalUsed: boolean } | undefined | "store-unavailable"> {
    const { resPrefix } = this.prefixes();
    try {
      const client = await this.client();
      const record = await client.hGetAll(`${resPrefix}${reservationId}`);
      if (!record || !record.est) return undefined;
      return { estimateMicros: Number(record.est), approvalUsed: record.appr === "1" };
    } catch {
      return "store-unavailable";
    }
  }

  async snapshot(dayUtc: string): Promise<BudgetSnapshotData | "store-unavailable"> {
    const { dayPrefix, tasksPrefix, resPrefix } = this.prefixes();
    try {
      const reply = (await (
        await this.client()
      ).eval(SNAPSHOT_SCRIPT, {
        keys: [`${dayPrefix}${dayUtc}`, `${tasksPrefix}${dayUtc}`],
        arguments: [resPrefix],
      })) as string[];
      return {
        dayUtc,
        settledMicros: Number(reply[0] ?? 0),
        reservedMicros: Number(reply[1] ?? 0),
        activeCount: Number(reply[2] ?? 0),
        taskIds: reply.slice(3),
      };
    } catch {
      return "store-unavailable";
    }
  }

  async close(): Promise<void> {
    this.dead = true;
    const handle = this.handle;
    this.handle = null;
    if (handle) {
      const resolved = await handle.catch(() => undefined);
      await resolved?.close();
    }
  }
}
