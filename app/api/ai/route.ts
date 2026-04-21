import { NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { cookies } from "next/headers";
import { Task } from "@/lib/types";
import { consumeDailyRequest } from "@/lib/server/aiQuota";

type AttachedTaskContext = Task & {
  note?: string;
};

type AiAction = "extract" | "summarize" | "tone" | "advice" | "draft";

interface Body {
  action?: AiAction;
  taskTitle?: string;
  taskDescription?: string;
  note?: string;
  messages?: Array<{ role: "user" | "assistant"; content: string }>;
  context?: { tasks?: Task[] };
  attachedTaskIds?: string[];
  attachedTasks?: AttachedTaskContext[];
}

type ProviderResult = {
  ok: boolean;
  text: string;
  error?: string;
};

type ResponsePayload = {
  reply: string;
  action?: unknown;
};

type CachedResponse = {
  payload: ResponsePayload;
  expiresAt: number;
};

const CHAT_HISTORY_LIMIT = 6;
const MESSAGE_CHAR_LIMIT = 420;
const TASK_CONTEXT_LIMIT = 8;
const ATTACHED_TASK_LIMIT = 6;
const PROMPT_CHAR_LIMIT = 10000;
const RESPONSE_CACHE_TTL_MS = 90_000;

const globalForAiRoute = globalThis as unknown as {
  aiResponseCache?: Map<string, CachedResponse>;
  aiInFlight?: Map<string, Promise<ProviderResult>>;
};

const aiResponseCache = globalForAiRoute.aiResponseCache ?? new Map<string, CachedResponse>();
const aiInFlight = globalForAiRoute.aiInFlight ?? new Map<string, Promise<ProviderResult>>();

if (!globalForAiRoute.aiResponseCache) {
  globalForAiRoute.aiResponseCache = aiResponseCache;
}

if (!globalForAiRoute.aiInFlight) {
  globalForAiRoute.aiInFlight = aiInFlight;
}

const systemPrompt =
  "You are a production AI assistant for task notes. You must follow the requested action exactly, use only the provided note context, and avoid generic filler. For extraction, return a checklist of actionable items. For summarization, return one concise summary. For tone changes, keep the meaning but make it professional. For advice, return concrete, specific guidance tied to the note. For drafting, write a clear message the user can send. Keep the output tightly scoped to the note and task context.";

const chatSystemPrompt =
  "You are ActivityTracker AI Assistant. Help users manage tasks with concise, practical answers. By default, respond in natural conversational text only (no markdown code fences and no JSON wrappers). If and only if the user explicitly asks to create a task, you may include an action object in JSON with keys: reply (string) and action. The action shape is {\"type\":\"CREATE_TASK\",\"task\":{\"title\":string,\"description\"?:string,\"priority\"?:\"low\"|\"medium\"|\"high\",\"category\"?:string}}.";

const truncateText = (value: string, max: number) => {
  const trimmed = value.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max)}...`;
};

const toTokenLimit = (value: string | undefined, fallback: number) => {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
};

const buildCacheKey = (system: string, prompt: string, mode: string) =>
  createHash("sha256").update(mode).update("\n").update(system).update("\n").update(prompt).digest("hex");

const getEmail = async () => (await cookies()).get("activity_user_email")?.value?.trim().toLowerCase() ?? "";

const isProviderQuotaError = (errorMessage: string) => {
  const normalized = errorMessage.toLowerCase();
  return (
    normalized.includes("quota") ||
    normalized.includes("rate limit") ||
    normalized.includes("resource_exhausted") ||
    normalized.includes("429")
  );
};

const buildUserPrompt = (body: Body) => {
  const action = body.action ?? "summarize";
  const taskTitle = body.taskTitle ?? "Untitled task";
  const taskDescription = body.taskDescription?.trim() || "N/A";
  const note = body.note?.trim() || "N/A";

  switch (action) {
    case "extract":
      return [
        `Task title: ${taskTitle}`,
        `Task description: ${taskDescription}`,
        `Note: ${note}`,
        "Task: Extract action items from this note as a clean checklist only.",
        "Rules: Use short checklist items, keep them specific, and do not add a summary paragraph.",
      ].join("\n");
    case "tone":
      return [
        `Task title: ${taskTitle}`,
        `Task description: ${taskDescription}`,
        `Note: ${note}`,
        "Task: Rewrite the note in a more professional tone while preserving meaning.",
        "Rules: Return the rewritten note only.",
      ].join("\n");
    case "advice":
      return [
        `Task title: ${taskTitle}`,
        `Task description: ${taskDescription}`,
        `Note: ${note}`,
        "Task: Give practical technical advice and next steps for the blocker described in the note.",
        "Rules: Be specific, mention tools or checks when helpful, and keep the advice tied to the note.",
      ].join("\n");
    case "draft":
      return [
        `Task title: ${taskTitle}`,
        `Task description: ${taskDescription}`,
        `Note: ${note}`,
        "Task: Draft a concise email or Slack message based on the note.",
        "Rules: Write a ready-to-send message with a clear ask and context.",
      ].join("\n");
    case "summarize":
    default:
      return [
        `Task title: ${taskTitle}`,
        `Task description: ${taskDescription}`,
        `Note: ${note}`,
        "Task: Summarize this note in one concise sentence.",
        "Rules: Return only the summary sentence.",
      ].join("\n");
  }
};

const buildChatPrompt = (body: Body) => {
  const tasks = body.context?.tasks ?? [];
  const attachedTaskIds = new Set(body.attachedTaskIds ?? []);
  const attachedSource = body.attachedTasks?.length ? body.attachedTasks : tasks.filter((task) => attachedTaskIds.has(task.id));
  const attachedTasks: AttachedTaskContext[] = attachedSource
    .map((task) => {
      const maybeNote = (task as { note?: unknown }).note;
      return {
        ...task,
        note: typeof maybeNote === "string" ? maybeNote : "",
      };
    })
    .filter((task, index, array) => array.findIndex((candidate) => candidate.id === task.id) === index);

  const taskSummary = tasks
    .slice(0, TASK_CONTEXT_LIMIT)
    .map((task) => {
      const title = truncateText(task.title, 80);
      return `- ${title} [${task.status}] priority:${task.priority}${task.dueDate ? ` due:${new Date(task.dueDate).toLocaleDateString()}` : ""}`;
    })
    .join("\n");

  const attachedTaskDetails = attachedTasks
    .slice(0, ATTACHED_TASK_LIMIT)
    .map((task) => {
      return [
        `- Title: ${truncateText(task.title, 100)}`,
        `  Status: ${task.status}`,
        `  Priority: ${task.priority}`,
        `  Category: ${truncateText(task.category ?? "n/a", 60)}`,
        `  Due: ${task.dueDate ? new Date(task.dueDate).toLocaleDateString() : "n/a"}`,
        `  Description: ${truncateText(task.description?.trim() || "n/a", 260)}`,
        `  Notes: ${truncateText(task.note?.trim() || "n/a", 260)}`,
      ].join("\n");
    })
    .join("\n\n");

  const allMessages = body.messages ?? [];
  const recentMessages = allMessages.slice(-CHAT_HISTORY_LIMIT);
  const olderCount = Math.max(0, allMessages.length - recentMessages.length);
  const transcript = recentMessages
    .map((message) => `${message.role.toUpperCase()}: ${truncateText(message.content, MESSAGE_CHAR_LIMIT)}`)
    .join("\n\n");

  const olderSummary =
    olderCount > 0
      ? `Earlier conversation summary: ${olderCount} prior messages omitted for token control. Keep continuity with recent messages.`
      : "";

  return truncateText(
    [
    "Workspace task context:",
    taskSummary || "- No tasks provided",
    "",
    "Attached tasks selected by user. Treat these as the primary task context and prioritize them over the general workspace list:",
    attachedTaskDetails || "- none",
    "Ignore subtask lists and focus on the attached task notes/description when answering.",
    "",
    olderSummary,
    olderSummary ? "" : "",
    "Conversation transcript:",
    transcript || "USER: Hello",
    ].join("\n"),
    PROMPT_CHAR_LIMIT,
  );
};

const stripCodeFence = (value: string) => {
  const trimmed = value.trim();
  const fenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenceMatch ? fenceMatch[1].trim() : trimmed;
};

const parseStructuredReply = (value: string): { reply: string; action?: unknown } | null => {
  const cleaned = stripCodeFence(value)
    .replace(/^"+|"+$/g, "")
    .trim();

  const candidates: string[] = [cleaned];
  const firstObjectStart = cleaned.indexOf("{");
  const lastObjectEnd = cleaned.lastIndexOf("}");
  if (firstObjectStart >= 0 && lastObjectEnd > firstObjectStart) {
    candidates.push(cleaned.slice(firstObjectStart, lastObjectEnd + 1));
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as { reply?: string; action?: unknown };
      if (typeof parsed.reply === "string" && parsed.reply.trim()) {
        return { reply: parsed.reply.trim(), action: parsed.action };
      }
    } catch {
      // Try next candidate
    }
  }

  return null;
};

const callGemini = async ({
  apiKey,
  model,
  system,
  prompt,
  maxOutputTokens,
}: {
  apiKey: string;
  model: string;
  system: string;
  prompt: string;
  maxOutputTokens: number;
}): Promise<ProviderResult> => {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${apiKey}`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      systemInstruction: {
        parts: [{ text: system }],
      },
      contents: [
        {
          role: "user",
          parts: [{ text: prompt }],
        },
      ],
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens,
      },
    }),
  });

  const data = await response.json().catch(() => ({}));
  const parts = data?.candidates?.[0]?.content?.parts;
  const text = Array.isArray(parts)
    ? parts.map((part: { text?: string }) => part?.text || "").join("\n").trim()
    : "";

  if (!response.ok) {
    const message = data?.error?.message || `Gemini request failed with status ${response.status}.`;
    return { ok: false, text: "", error: message };
  }

  if (!text) {
    return { ok: false, text: "", error: "Gemini returned an empty response." };
  }

  return { ok: true, text };
};

const callOpenAI = async ({
  apiKey,
  model,
  system,
  prompt,
  maxTokens,
}: {
  apiKey: string;
  model: string;
  system: string;
  prompt: string;
  maxTokens: number;
}): Promise<ProviderResult> => {
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      max_tokens: maxTokens,
      messages: [
        { role: "system", content: system },
        { role: "user", content: prompt },
      ],
    }),
  });

  const data = await response.json().catch(() => ({}));
  const text = typeof data?.choices?.[0]?.message?.content === "string"
    ? data.choices[0].message.content.trim()
    : "";

  if (!response.ok) {
    const message = data?.error?.message || `OpenAI request failed with status ${response.status}.`;
    return { ok: false, text: "", error: message };
  }

  if (!text) {
    return { ok: false, text: "", error: "OpenAI returned an empty response." };
  }

  return { ok: true, text };
};

export async function POST(request: Request) {
  try {
    const email = await getEmail();
    if (!email) {
      return NextResponse.json(
        { reply: "Please sign in again before using AI so usage can be tracked to your account." },
        { status: 401 },
      );
    }

    const body = (await request.json()) as Body;
    const messages = body.messages ?? [];
    const last = body.note?.trim() || messages[messages.length - 1]?.content || "";

    if (!last.trim()) {
      return NextResponse.json({ reply: "Please share a task or question for me to help with." }, { status: 200 });
    }

    const geminiKey = process.env.GEMINI_API_KEY;
    const geminiFallbackKey = process.env.GEMINI_API_KEY_FALLBACK;
    const geminiChatModel = process.env.GEMINI_CHAT_MODEL || "gemini-2.5-flash-lite";
    const geminiActionModel = process.env.GEMINI_ACTION_MODEL || process.env.GEMINI_MODEL || "gemini-2.5-flash";
    const geminiFallbackChatModel = process.env.GEMINI_FALLBACK_CHAT_MODEL || "gemini-2.5-flash";
    const geminiFallbackActionModel = process.env.GEMINI_FALLBACK_ACTION_MODEL || geminiFallbackChatModel;
    const openAiKey = process.env.OPENAI_API_KEY;
    const openAiChatModel = process.env.OPENAI_CHAT_MODEL || "gpt-4o-mini";
    const openAiActionModel = process.env.OPENAI_ACTION_MODEL || process.env.OPENAI_MODEL || "gpt-4o-mini";
    const isChatMode = messages.length > 0 && !body.action;
    const maxOutputTokens = isChatMode
      ? toTokenLimit(process.env.AI_CHAT_MAX_OUTPUT_TOKENS, 320)
      : toTokenLimit(process.env.AI_NOTE_MAX_OUTPUT_TOKENS, 420);

    if (!geminiKey && !geminiFallbackKey && !openAiKey) {
      return NextResponse.json({ error: "No AI provider API key is configured." }, { status: 503 });
    }

    const prompt = isChatMode ? buildChatPrompt(body) : buildUserPrompt(body);
    const activeSystemPrompt = isChatMode ? chatSystemPrompt : systemPrompt;
    const mode = isChatMode ? "chat" : `action:${body.action ?? "summarize"}`;
    const cacheKey = buildCacheKey(activeSystemPrompt, prompt, mode);

    const cached = aiResponseCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return NextResponse.json(cached.payload);
    }

    const usageCheck = await consumeDailyRequest(email);
    if (!usageCheck.allowed) {
      return NextResponse.json(
        {
          reply: `Daily AI limit reached for this account (${usageCheck.snapshot.dailyBudget} requests). Try again after reset or increase your limit in Settings.`,
          usage: usageCheck.snapshot,
        },
        { status: 429 },
      );
    }

    let providerResult: ProviderResult | null = null;

    const inFlightResult = aiInFlight.get(cacheKey);
    if (inFlightResult) {
      providerResult = await inFlightResult;
    } else {
      const runProvider = (async () => {
        let result: ProviderResult | null = null;

        if (geminiKey) {
          result = await callGemini({
            apiKey: geminiKey,
            model: isChatMode ? geminiChatModel : geminiActionModel,
            system: activeSystemPrompt,
            prompt,
            maxOutputTokens,
          });
        }

        if (
          (!result || !result.ok) &&
          geminiFallbackKey &&
          (!geminiKey || isProviderQuotaError(result?.error ?? ""))
        ) {
          result = await callGemini({
            apiKey: geminiFallbackKey,
            model: isChatMode ? geminiFallbackChatModel : geminiFallbackActionModel,
            system: activeSystemPrompt,
            prompt,
            maxOutputTokens,
          });
        }

        if ((!result || !result.ok) && openAiKey) {
          result = await callOpenAI({
            apiKey: openAiKey,
            model: isChatMode ? openAiChatModel : openAiActionModel,
            system: activeSystemPrompt,
            prompt,
            maxTokens: maxOutputTokens,
          });
        }

        return result ?? { ok: false, text: "", error: "No AI provider API key is configured." };
      })();

      aiInFlight.set(cacheKey, runProvider);
      providerResult = await runProvider;
      aiInFlight.delete(cacheKey);
    }

    if (!providerResult || !providerResult.ok || !providerResult.text.trim()) {
      if (isProviderQuotaError(providerResult?.error ?? "")) {
        return NextResponse.json(
          {
            reply:
              "AI provider capacity for the shared server key is currently exhausted. This is separate from your per-account daily budget. Try again shortly or switch to another provider key.",
            error: providerResult?.error,
          },
          { status: 503 },
        );
      }

      return NextResponse.json(
        { error: providerResult?.error || "AI provider returned an empty response." },
        { status: 502 },
      );
    }

    const text = providerResult.text.trim();

    if (isChatMode) {
      const structured = parseStructuredReply(text);
      if (structured) {
        const payload: ResponsePayload = { reply: structured.reply, action: structured.action };
        aiResponseCache.set(cacheKey, {
          payload,
          expiresAt: Date.now() + RESPONSE_CACHE_TTL_MS,
        });
        return NextResponse.json(payload);
      }

      const payload: ResponsePayload = { reply: stripCodeFence(text) };
      aiResponseCache.set(cacheKey, {
        payload,
        expiresAt: Date.now() + RESPONSE_CACHE_TTL_MS,
      });
      return NextResponse.json(payload);
    }

    try {
      const parsed = JSON.parse(text) as { reply?: string };
      if (typeof parsed.reply === "string" && parsed.reply.trim()) {
        const payload: ResponsePayload = { reply: parsed.reply.trim() };
        aiResponseCache.set(cacheKey, {
          payload,
          expiresAt: Date.now() + RESPONSE_CACHE_TTL_MS,
        });
        return NextResponse.json(payload);
      }
    } catch {
      // Non-JSON output is treated as plain reply for notes.
    }

    const payload: ResponsePayload = { reply: text };
    aiResponseCache.set(cacheKey, {
      payload,
      expiresAt: Date.now() + RESPONSE_CACHE_TTL_MS,
    });
    return NextResponse.json(payload);
  } catch {
    return NextResponse.json(
      { reply: "I hit an unexpected error. Try again in a moment." },
      { status: 500 },
    );
  }
}
