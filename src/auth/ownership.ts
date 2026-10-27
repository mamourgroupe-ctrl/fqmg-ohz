/**
 * Ownership registry for voice audio references (phase 3).
 *
 * A synthesis result's audio reference (`/api/voice/audio/{id}`) belongs to the
 * authenticated user who requested it. The registry is deliberately
 * fail-closed: a reference with no recorded owner is served to nobody, and a
 * restart clears the registry so retained audio stays inaccessible rather than
 * becoming public. Durability belongs to the Phase 5 shared-state work.
 *
 * Job and preview ownership lives on the job record itself (AgentJobRecord.owner).
 */

const MAX_TRACKED_REFERENCES = 20_000;
const owners = new Map<string, { owner: string; recordedAt: number }>();

export function recordAudioOwner(referenceId: string, username: string, now: number = Date.now()): void {
  if (owners.size >= MAX_TRACKED_REFERENCES) {
    // Evict the oldest entries (Map preserves insertion order).
    const excess = owners.size - MAX_TRACKED_REFERENCES + 1;
    let removed = 0;
    for (const key of owners.keys()) {
      owners.delete(key);
      removed += 1;
      if (removed >= excess) break;
    }
  }
  owners.set(referenceId, { owner: username, recordedAt: now });
}

export function getAudioOwner(referenceId: string): string | undefined {
  return owners.get(referenceId)?.owner;
}

/** Test isolation only. */
export function __resetAudioOwnershipForTests(): void {
  owners.clear();
}
