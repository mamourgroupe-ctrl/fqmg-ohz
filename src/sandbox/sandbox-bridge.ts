import {
  parseSandboxMessage,
  type SandboxMessage,
} from "@/sandbox/iframe-sandbox";

/**
 * Phase 4 — parent-side controller for the sandboxed preview frame.
 *
 * Dependency-injected (`postToSandbox` + caller-driven `handleSandboxMessage`)
 * so the watchdog, correlation, and dead-session logic are testable without a
 * browser. One "session" = one iframe load/code handoff: if the frame does not
 * report ready within `timeoutMs`, the bridge reports a timeout error and
 * kills itself — late messages from a wedged frame are ignored.
 */

export interface SandboxBridgeOptions {
  timeoutMs: number;
  onError: (message: string) => void;
  onReady?: () => void;
  onMeta?: (meta: { durationInFrames: number; fps: number }) => void;
  onFrame?: (frame: number) => void;
  onRuntimeError?: (message: string) => void;
  postToSandbox?: (payload: SandboxMessage) => void;
}

interface PendingCapture {
  resolve: (dataUrl: string) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class SandboxBridge {
  private readonly options: SandboxBridgeOptions;
  private watchdog: ReturnType<typeof setTimeout> | null = null;
  private dead = false;
  private pendingCaptures = new Map<string, PendingCapture>();
  private captureCounter = 0;

  constructor(options: SandboxBridgeOptions) {
    this.options = options;
  }

  /** Start (or restart) a session: arms the ready watchdog. */
  beginSession(): void {
    this.killWatchdog();
    this.rejectAllPending(new Error("capture cancelled: new sandbox session started"));
    this.dead = false;
    this.watchdog = setTimeout(() => {
      this.dead = true;
      this.rejectAllPending(new Error("capture timed out"));
      this.options.onError(`sandbox timeout: no ready signal within ${this.options.timeoutMs}ms`);
    }, this.options.timeoutMs);
  }

  /** Cancel the session entirely (iframe unmounted). */
  dispose(): void {
    this.dead = true;
    this.killWatchdog();
    this.rejectAllPending(new Error("capture cancelled: sandbox disposed"));
  }

  /**
   * Feed a message event payload (already trusted by isTrustedSandboxEvent).
   * Returns false when the bridge is dead or the payload is invalid — the
   * caller must ignore it either way.
   */
  handleSandboxMessage(data: unknown): boolean {
    if (this.dead) return false;
    const message = parseSandboxMessage(data);
    if (!message) return false;

    switch (message.type) {
      case "fqmg-sandbox/ready":
        this.killWatchdog();
        this.options.onReady?.();
        return true;
      case "fqmg-sandbox/error":
        this.options.onRuntimeError?.(message.message);
        return true;
      case "fqmg-sandbox/meta":
        this.options.onMeta?.({ durationInFrames: message.durationInFrames, fps: message.fps });
        return true;
      case "fqmg-sandbox/frame":
        this.options.onFrame?.(message.frame);
        return true;
      case "fqmg-sandbox/capture-result": {
        const pending = this.pendingCaptures.get(message.requestId);
        if (!pending) return false;
        this.pendingCaptures.delete(message.requestId);
        clearTimeout(pending.timer);
        pending.resolve(message.dataUrl);
        return true;
      }
      default:
        return false;
    }
  }

  /** Ask the sandbox for a still frame; resolves with an image data URL. */
  requestCapture(frame: number): Promise<string> {
    if (this.dead) {
      return Promise.reject(new Error("capture refused: sandbox session is dead"));
    }
    this.captureCounter += 1;
    const requestId = `cap-${Date.now().toString(36)}-${this.captureCounter}`;
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingCaptures.delete(requestId);
        reject(new Error(`capture timeout: no capture-result within ${this.options.timeoutMs}ms`));
      }, this.options.timeoutMs);
      this.pendingCaptures.set(requestId, { resolve, reject, timer });
      this.options.postToSandbox?.({
        type: "fqmg-sandbox/capture-request",
        frame,
        requestId,
      });
    });
  }

  private killWatchdog(): void {
    if (this.watchdog !== null) {
      clearTimeout(this.watchdog);
      this.watchdog = null;
    }
  }

  private rejectAllPending(reason: Error): void {
    for (const pending of this.pendingCaptures.values()) {
      clearTimeout(pending.timer);
      pending.reject(reason);
    }
    this.pendingCaptures.clear();
  }
}
