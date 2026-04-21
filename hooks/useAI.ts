"use client";

import { useRef, useState } from "react";
import { AIAction, ChatMessage, Task } from "@/lib/types";

type AttachedTaskContext = Task & {
  note?: string;
};

interface AIResponse {
  reply: string;
  action?: AIAction;
}

type CachedResponse = {
  value: AIResponse;
  expiresAt: number;
};

const CLIENT_DEDUPE_TTL_MS = 30_000;

type AskAIOptions = {
  attachedTaskIds?: string[];
  attachedTasks?: AttachedTaskContext[];
};

export function useAI() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cacheRef = useRef(new Map<string, CachedResponse>());
  const inFlightRef = useRef(new Map<string, Promise<AIResponse>>());

  const buildRequestKey = (messages: ChatMessage[], tasks: Task[], options?: AskAIOptions) => {
    const compactMessages = messages.slice(-6).map((message) => ({
      role: message.role,
      content: message.content.trim().slice(0, 320),
    }));
    const compactTasks = tasks.slice(0, 12).map((task) => ({
      id: task.id,
      title: task.title,
      status: task.status,
      priority: task.priority,
      updatedAt: new Date(task.updatedAt).toISOString(),
    }));

    return JSON.stringify({
      messages: compactMessages,
      tasks: compactTasks,
      attachedTaskIds: options?.attachedTaskIds ?? [],
      attachedTaskCount: options?.attachedTasks?.length ?? 0,
    });
  };

  const askAI = async (messages: ChatMessage[], tasks: Task[], options?: AskAIOptions) => {
    const requestKey = buildRequestKey(messages, tasks, options);
    const cached = cacheRef.current.get(requestKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }

    const existing = inFlightRef.current.get(requestKey);
    if (existing) {
      return existing;
    }

    setLoading(true);
    setError(null);

    const requestPromise = (async () => {
      try {
        const response = await fetch("/api/ai", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            messages,
            context: { tasks },
            attachedTaskIds: options?.attachedTaskIds ?? [],
            attachedTasks: options?.attachedTasks ?? [],
          }),
        });

        const data = (await response.json().catch(() => null)) as
          | { reply?: string; action?: AIAction; error?: string }
          | null;

        if (!response.ok) {
          if (typeof data?.reply === "string" && data.reply.trim()) {
            return { reply: data.reply.trim(), action: data.action } satisfies AIResponse;
          }

          const backendMessage = typeof data?.error === "string" ? data.error : "AI request failed";
          throw new Error(backendMessage);
        }

        const result = {
          reply: typeof data?.reply === "string" ? data.reply : "",
          action: data?.action,
        } satisfies AIResponse;

        cacheRef.current.set(requestKey, {
          value: result,
          expiresAt: Date.now() + CLIENT_DEDUPE_TTL_MS,
        });

        return result;
      } catch (err) {
        const message = err instanceof Error ? err.message : "Something went wrong";
        setError(message);

        const normalized = message.toLowerCase();
        const userFacingMessage = normalized.includes("shared server key") || normalized.includes("provider capacity")
          ? "AI provider is temporarily rate-limited for the server key. Your account budget is separate. Please try again shortly."
          : normalized.includes("daily ai limit reached")
            ? message
            : normalized.includes("quota") || normalized.includes("429")
              ? "AI provider quota is currently limited. Please try again shortly."
          : normalized.includes("api key") || normalized.includes("unauthorized") || normalized.includes("permission")
            ? "AI provider credentials are invalid or missing. Please check server configuration."
            : normalized.includes("model")
              ? "AI model is unavailable right now. Please try again in a moment."
              : "I couldn't reach the AI service right now. You can still keep tracking tasks, and I can try again in a moment.";

        return {
          reply: userFacingMessage,
        } satisfies AIResponse;
      } finally {
        inFlightRef.current.delete(requestKey);
        setLoading(false);
      }
    })();

    inFlightRef.current.set(requestKey, requestPromise);
    return requestPromise;
  };

  return { askAI, loading, error };
}
