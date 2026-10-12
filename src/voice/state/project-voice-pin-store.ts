import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { VoiceSelectionSchema, type VoiceSelection } from "@/voice/contracts/voice-contract";

const MAX_PIN_STORE_BYTES = 2 * 1024 * 1024;
const ProjectPinKeySchema = z.string().min(1).max(64).regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);
const ProjectPinMapSchema = z.record(ProjectPinKeySchema, VoiceSelectionSchema);
const ProjectPinStoreSchema = z.object({
  version: z.literal(1),
  projects: ProjectPinMapSchema,
}).strict();

type ProjectPinStore = z.infer<typeof ProjectPinStoreSchema>;

export class VoicePinStoreError extends Error {
  constructor() {
    super("Project voice preferences could not be read or saved safely.");
    this.name = "VoicePinStoreError";
  }
}

function getErrorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

export class ProjectVoicePinStore {
  private readonly filePath: string;
  private fileWriteQueue: Promise<void> = Promise.resolve();
  private readonly projectTails = new Map<string, Promise<void>>();

  constructor(directory = process.env.VOICE_CACHE_DIR?.trim() || path.join(process.cwd(), ".voice-cache")) {
    this.filePath = path.join(path.resolve(/*turbopackIgnore: true*/ directory), "project-voices.json");
  }

  async runExclusive<T>(projectId: string, operation: () => Promise<T>): Promise<T> {
    if (!ProjectPinKeySchema.safeParse(projectId).success) throw new VoicePinStoreError();

    const previous = this.projectTails.get(projectId) ?? Promise.resolve();
    let releaseTail!: () => void;
    const tail = new Promise<void>((resolve) => { releaseTail = resolve; });
    const queued = previous.then(() => tail);
    this.projectTails.set(projectId, queued);
    await previous;

    try {
      return await operation();
    } finally {
      releaseTail();
      if (this.projectTails.get(projectId) === queued) this.projectTails.delete(projectId);
    }
  }

  async get(projectId: string): Promise<VoiceSelection | undefined> {
    if (!ProjectPinKeySchema.safeParse(projectId).success) throw new VoicePinStoreError();
    const store = await this.readStore();
    const selection = store.projects[projectId];
    return selection ? VoiceSelectionSchema.parse(selection) : undefined;
  }

  async set(projectId: string, selection: VoiceSelection): Promise<void> {
    if (!ProjectPinKeySchema.safeParse(projectId).success) throw new VoicePinStoreError();
    const parsedSelection = VoiceSelectionSchema.safeParse(selection);
    if (!parsedSelection.success) throw new VoicePinStoreError();

    await this.withFileWriteLock(async () => {
      const store = await this.readStore();
      store.projects[projectId] = parsedSelection.data;
      await this.writeStore(store);
    });
  }

  private async readStore(): Promise<ProjectPinStore> {
    try {
      const fileStat = await stat(this.filePath);
      if (!fileStat.isFile() || fileStat.size > MAX_PIN_STORE_BYTES) throw new VoicePinStoreError();
      const content = await readFile(this.filePath, "utf8");
      const parsed = ProjectPinStoreSchema.safeParse(JSON.parse(content) as unknown);
      if (!parsed.success) throw new VoicePinStoreError();
      return parsed.data;
    } catch (error) {
      if (getErrorCode(error) === "ENOENT") return { version: 1, projects: {} };
      if (error instanceof VoicePinStoreError) throw error;
      throw new VoicePinStoreError();
    }
  }

  private async writeStore(store: ProjectPinStore): Promise<void> {
    let temporaryPath: string | undefined;
    try {
      const content = JSON.stringify(ProjectPinStoreSchema.parse(store));
      if (Buffer.byteLength(content, "utf8") > MAX_PIN_STORE_BYTES) throw new VoicePinStoreError();
      await mkdir(path.dirname(this.filePath), { recursive: true });
      temporaryPath = path.join(path.dirname(this.filePath), `.project-voices-${randomUUID()}.tmp`);
      await writeFile(temporaryPath, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
      await rename(temporaryPath, this.filePath);
    } catch (error) {
      if (temporaryPath) await unlink(temporaryPath).catch(() => undefined);
      if (error instanceof VoicePinStoreError) throw error;
      throw new VoicePinStoreError();
    }
  }

  private async withFileWriteLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.fileWriteQueue;
    let release!: () => void;
    this.fileWriteQueue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}
