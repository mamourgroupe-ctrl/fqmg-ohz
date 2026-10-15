import {
  prepareGeneratedCode,
  stripMarkdownFences,
  validateGptResponse,
} from "@/helpers/sanitize-response";
import {
  getGenerationHttpErrorMessage,
  getGenerationStreamErrorMessage,
  isTruncatedGenerationEvent,
  parseGenerationStreamEvent,
} from "@/helpers/generation-errors";
import type {
  AssistantMetadata,
  ConversationContextMessage,
  ErrorCorrectionContext,
} from "@/types/conversation";
import type {
  GenerationErrorType,
  ModelId,
  StreamPhase,
} from "@/types/generation";
import { useCallback, useState } from "react";

interface FailedEditInfo {
  description: string;
  old_string: string;
  new_string: string;
}

interface GenerationCallbacks {
  onCodeGenerated?: (code: string) => void;
  onStreamingChange?: (isStreaming: boolean) => void;
  onStreamPhaseChange?: (phase: StreamPhase) => void;
  onError?: (
    error: string,
    type: GenerationErrorType,
    failedEdit?: FailedEditInfo,
  ) => void;
  onMessageSent?: (prompt: string, attachedImages?: string[]) => void;
  onGenerationComplete?: (
    code: string,
    summary?: string,
    metadata?: AssistantMetadata,
  ) => void;
  onErrorMessage?: (
    message: string,
    errorType: "edit_failed" | "api" | "validation",
    failedEdit?: FailedEditInfo,
  ) => void;
  onPendingMessage?: (skills?: string[]) => void;
  onClearPendingMessage?: () => void;
}

interface GenerationContext {
  currentCode?: string;
  conversationHistory: ConversationContextMessage[];
  previouslyUsedSkills: string[];
  isFollowUp: boolean;
  hasManualEdits: boolean;
  errorCorrection?: ErrorCorrectionContext;
  frameImages?: string[];
}

interface UseGenerationApiReturn {
  isLoading: boolean;
  runGeneration: (
    prompt: string,
    model: ModelId,
    context: GenerationContext,
    callbacks: GenerationCallbacks,
    options?: { silent?: boolean },
  ) => Promise<void>;
}

const MAX_TRUNCATION_FALLBACKS = 2;

export function useGenerationApi(): UseGenerationApiReturn {
  const [isLoading, setIsLoading] = useState(false);

  const runGeneration = useCallback(
    async (
      prompt: string,
      model: ModelId,
      context: GenerationContext,
      callbacks: GenerationCallbacks,
      options?: { silent?: boolean },
    ) => {
      if (!prompt.trim() || isLoading) return;

      const {
        currentCode,
        conversationHistory,
        previouslyUsedSkills,
        isFollowUp,
        hasManualEdits,
        errorCorrection,
        frameImages,
      } = context;

      const {
        onCodeGenerated,
        onStreamingChange,
        onStreamPhaseChange,
        onError,
        onMessageSent,
        onGenerationComplete,
        onErrorMessage,
        onPendingMessage,
        onClearPendingMessage,
      } = callbacks;

      setIsLoading(true);
      onStreamingChange?.(true);
      onStreamPhaseChange?.("reasoning");

      // Only add user message if not a silent retry
      if (!options?.silent) {
        onMessageSent?.(prompt, frameImages);
      }

      const excludedModels: string[] = [];
      let truncationFallbacks = 0;

      try {
        while (true) {
          const response = await fetch("/api/generate", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              prompt,
              model,
              currentCode: isFollowUp ? currentCode : undefined,
              conversationHistory: isFollowUp ? conversationHistory : [],
              previouslyUsedSkills: isFollowUp ? previouslyUsedSkills : [],
              isFollowUp,
              hasManualEdits,
              errorCorrection,
              frameImages,
              excludedModels,
            }),
          });

        if (!response.ok) {
          const errorData: unknown = await response.json().catch(() => null);
          const errorFields =
            errorData !== null && typeof errorData === "object"
              ? (errorData as Record<string, unknown>)
              : {};
          const errorMessage = getGenerationHttpErrorMessage(
            errorData,
            response.status,
          );
          if (errorFields.type === "edit_failed") {
            const failedEdit = errorFields.failedEdit as
              | FailedEditInfo
              | undefined;
            onError?.(errorMessage, "validation", failedEdit);
            onErrorMessage?.(errorMessage, "edit_failed", failedEdit);
            return;
          }
          if (errorFields.type === "validation") {
            onError?.(errorMessage, "validation");
            onErrorMessage?.(errorMessage, "validation");
            return;
          }
          if (
            excludedModels.length > 0 &&
            errorFields.type === "provider_unavailable"
          ) {
            onError?.(
              `Generation output was truncated, and fallback model selection failed: ${errorMessage}`,
              "truncated",
            );
            return;
          }
          throw new Error(errorMessage);
        }

        const contentType = response.headers.get("content-type") || "";

        // Handle JSON response (non-streaming, for follow-up edits)
        if (contentType.includes("application/json")) {
          const data = await response.json();
          const { code, summary, metadata } = data;
          onCodeGenerated?.(code);
          onGenerationComplete?.(code, summary, metadata);
          const validation = validateGptResponse(code);
          if (!validation.isValid && validation.error) {
            onError?.(validation.error, "validation");
          }
          return;
        }

        // Handle SSE stream response
        const reader = response.body?.getReader();
        if (!reader) throw new Error("No response body");

        const decoder = new TextDecoder();
        let accumulatedText = "";
        let buffer = "";
        let streamMetadata: AssistantMetadata = {};
        let finishReason: string | undefined;
        let receivedFinishEvent = false;

        const processLine = (line: string): void => {
          if (!line.startsWith("data: ")) return;
          const data = line.slice(6);
          try {
            const event = parseGenerationStreamEvent(data);
            if (!event) return;
            if (event.type === "metadata") {
              const skills = Array.isArray(event.skills)
                ? event.skills.filter(
                    (skill): skill is string => typeof skill === "string",
                  )
                : undefined;
              streamMetadata = {
                ...streamMetadata,
                skills,
              };
              onPendingMessage?.(skills);
            } else if (event.type === "reasoning-start") {
              onStreamPhaseChange?.("reasoning");
            } else if (event.type === "text-start") {
              onStreamPhaseChange?.("generating");
            } else if (event.type === "text-delta") {
              if (typeof event.delta !== "string") {
                throw new TypeError("The generation stream returned invalid text.");
              }
              accumulatedText += event.delta;
              const codeToShow = stripMarkdownFences(accumulatedText);
              onCodeGenerated?.(codeToShow);
            } else if (event.type === "finish") {
              receivedFinishEvent = true;
              finishReason = isTruncatedGenerationEvent(event)
                ? "length"
                : typeof event.finishReason === "string"
                  ? event.finishReason
                  : undefined;
            } else if (event.type === "error") {
              const errorMessage = getGenerationStreamErrorMessage(
                event.errorText ?? event.error,
              );
              console.error("STREAM ERROR:", errorMessage);
              throw new Error(errorMessage);
            }
          } catch (parseError) {
            if (parseError instanceof SyntaxError) {
              throw new Error("The generation stream returned invalid data.");
            }
            throw parseError;
          }
        };

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";
          lines.forEach(processLine);
        }
        buffer += decoder.decode();
        if (buffer) processLine(buffer);

        if (finishReason === "length" || !receivedFinishEvent) {
          const failedModel = response.headers.get("x-generation-model");
          if (
            failedModel &&
            !excludedModels.includes(failedModel) &&
            truncationFallbacks < MAX_TRUNCATION_FALLBACKS
          ) {
            excludedModels.push(failedModel);
            truncationFallbacks++;
            onStreamPhaseChange?.("reasoning");
            continue;
          }

          onError?.(
            "Generation output was truncated because the selected models reached their output limit or ended without a completion signal. Try a shorter prompt or choose a model with a larger output limit.",
            "truncated",
          );
          return;
        }

          const finalCode = prepareGeneratedCode(accumulatedText);
          onCodeGenerated?.(finalCode);
          onClearPendingMessage?.();
          onGenerationComplete?.(
            finalCode,
            undefined,
            streamMetadata.skills?.length ? streamMetadata : undefined,
          );

          const validation = validateGptResponse(finalCode);
          if (!validation.isValid && validation.error) {
            onError?.(validation.error, "validation");
          }
          break;
        }
      } catch (error) {
        console.error("Error generating code:", error);
        const errorMessage =
          error instanceof Error
            ? error.message
            : "An unexpected error occurred";
        onError?.(errorMessage, "api");
      } finally {
        setIsLoading(false);
        onStreamingChange?.(false);
        onStreamPhaseChange?.("idle");
        onClearPendingMessage?.();
      }
    },
    [isLoading],
  );

  return {
    isLoading,
    runGeneration,
  };
}
