"use client";

import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Bot, ChevronLeft, ChevronRight, Menu, MoreVertical, Pin, Plus, Trash2 } from "lucide-react";
import { ChatInput } from "@/components/ai/ChatInput";
import { ChatMessage } from "@/components/ai/ChatMessage";
import { AISuggestions } from "@/components/ai/AISuggestions";
import { TaskAttachmentToolbar } from "@/components/ai/TaskAttachmentToolbar";
import { useAI } from "@/hooks/useAI";
import { ChatMessage as ChatMessageType, Task } from "@/lib/types";
import { useTaskStore } from "@/lib/store/useTaskStore";
import { useTaskNotesStore } from "@/lib/store/useTaskNotesStore";
import { useNotificationStore } from "@/lib/store/useNotificationStore";
import { useThemeStore } from "@/lib/store/useThemeStore";
import { ConfirmationModal } from "@/components/ui/ConfirmationModal";

type Conversation = {
  id: string;
  title: string;
  updatedAt: Date;
  pinned: boolean;
  messages: ChatMessageType[];
};

const AI_CONVERSATIONS_UPDATED_EVENT = "ai:conversations-updated";
const AI_CONVERSATIONS_CACHE_KEY = "activity-ai-conversations-cache-v1";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const logConversationApiResponse = async (label: string, response: Response) => {
  if (process.env.NODE_ENV === "production") return;

  if (response.ok) {
    console.info(`[ai/conversations] ${label} -> ${response.status}`);
    return;
  }

  const details = await response.clone().text().catch(() => "<no-body>");
  console.warn(`[ai/conversations] ${label} failed`, {
    status: response.status,
    details,
  });
};

const emitConversationsUpdated = () => {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(AI_CONVERSATIONS_UPDATED_EVENT));
};

const initial: ChatMessageType[] = [
  {
    id: "welcome",
    role: "assistant",
    content: "Hi! I can help create tasks, break work into subtasks, and suggest productivity improvements.",
    timestamp: new Date(),
  },
];

export function ChatWindow() {
  const loadingConversationsRef = useRef(false);
  const [mounted, setMounted] = useState(false);
  const expanded = true;
  const [showConversations, setShowConversations] = useState(true);
  const [pendingNewConversation, setPendingNewConversation] = useState(false);
  const [attachedTaskIds, setAttachedTaskIds] = useState<string[]>([]);
  const [openConversationMenuId, setOpenConversationMenuId] = useState<string | null>(null);
  const [pendingDeleteConversation, setPendingDeleteConversation] = useState<Conversation | null>(null);
  const [cacheHydrated, setCacheHydrated] = useState(false);
  const [conversations, setConversations] = useState<Conversation[]>([
    {
      id: "conversation-initial",
      title: "Welcome chat",
      updatedAt: new Date(),
      pinned: false,
      messages: initial,
    },
  ]);
  const [activeConversationId, setActiveConversationId] = useState("conversation-initial");
  const [lastSubmittedAttachedCount, setLastSubmittedAttachedCount] = useState(0);
  const tasks = useTaskStore((state) => state.tasks);
  const notesByTaskId = useTaskNotesStore((state) => state.notesByTaskId);
  const addTask = useTaskStore((state) => state.addTask);
  const pushNotification = useNotificationStore((state) => state.pushNotification);
  const { askAI, loading } = useAI();
  const mode = useThemeStore((state) => state.mode);
  const isLight = mode === "light";

  const serializeMessages = (items: ChatMessageType[]) =>
    items.map((message) => ({
      ...message,
      timestamp: new Date(message.timestamp).toISOString(),
    }));

  const hydrateConversation = (conversation: {
    id: string;
    title: string;
    pinned: boolean;
    updatedAt: string | Date;
    messages: ChatMessageType[];
  }): Conversation => ({
    ...conversation,
    updatedAt: new Date(conversation.updatedAt),
    messages: (conversation.messages ?? []).map((message) => ({
      ...message,
      timestamp: new Date(message.timestamp),
    })),
  });

  const loadConversations = async () => {
    if (loadingConversationsRef.current) return;
    loadingConversationsRef.current = true;

    try {
      const response = await fetch("/api/ai/conversations", { cache: "no-store" });
      await logConversationApiResponse("GET", response);
      if (!response.ok) return;

      const data = await response.json();
      const nextConversations: Conversation[] = (data.conversations ?? []).map(hydrateConversation);
      if (!nextConversations.length) return;

      setConversations(nextConversations);
      setActiveConversationId((prev) =>
        nextConversations.some((conversation) => conversation.id === prev)
          ? prev
          : nextConversations[0].id,
      );
    } catch {
      // Preserve existing in-memory/cache state if network fetch fails.
    } finally {
      loadingConversationsRef.current = false;
    }
  };

  const readConversationsCache = () => {
    if (typeof window === "undefined") return;

    const raw = window.localStorage.getItem(AI_CONVERSATIONS_CACHE_KEY);
    if (!raw) return;

    try {
      const parsed = JSON.parse(raw) as {
        conversations?: Array<{
          id: string;
          title: string;
          pinned: boolean;
          updatedAt: string;
          messages: ChatMessageType[];
        }>;
        activeConversationId?: string;
      };

      if (!parsed.conversations?.length) return;

      const cachedConversations = parsed.conversations.map(hydrateConversation);
      setConversations(cachedConversations);
      setActiveConversationId(
        cachedConversations.some((conversation) => conversation.id === parsed.activeConversationId)
          ? (parsed.activeConversationId as string)
          : cachedConversations[0].id,
      );
    } catch {
      // Ignore invalid cache data.
    } finally {
      setCacheHydrated(true);
    }
  };

  const writeConversationsCache = (nextConversations: Conversation[], nextActiveId: string) => {
    if (typeof window === "undefined") return;

    const serializable = nextConversations.map((conversation) => ({
      ...conversation,
      updatedAt: conversation.updatedAt.toISOString(),
      messages: conversation.messages.map((message) => ({
        ...message,
        timestamp: new Date(message.timestamp).toISOString(),
      })),
    }));

    window.localStorage.setItem(
      AI_CONVERSATIONS_CACHE_KEY,
      JSON.stringify({ conversations: serializable, activeConversationId: nextActiveId }),
    );
  };

  useEffect(() => {
    readConversationsCache();
    setMounted(true);
  }, []);

  useEffect(() => {
    void loadConversations();
  }, []);

  useEffect(() => {
    if (!cacheHydrated) return;
    writeConversationsCache(conversations, activeConversationId);
  }, [cacheHydrated, conversations, activeConversationId]);

  useEffect(() => {
    const onConversationsUpdated = () => {
      void loadConversations();
    };

    const onFocus = () => {
      void loadConversations();
    };

    window.addEventListener(AI_CONVERSATIONS_UPDATED_EVENT, onConversationsUpdated);
    window.addEventListener("focus", onFocus);
    const refreshId = window.setInterval(() => {
      void loadConversations();
    }, 7000);

    return () => {
      window.removeEventListener(AI_CONVERSATIONS_UPDATED_EVENT, onConversationsUpdated);
      window.removeEventListener("focus", onFocus);
      window.clearInterval(refreshId);
    };
  }, []);

  const orderedConversations = [...conversations].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return b.updatedAt.getTime() - a.updatedAt.getTime();
  });

  const activeConversation =
    orderedConversations.find((conversation) => conversation.id === activeConversationId) ?? orderedConversations[0];
  const messages = activeConversation?.messages ?? initial;

  const setActiveMessages = (nextMessages: ChatMessageType[]) => {
    const userSeed = nextMessages.find((item) => item.role === "user")?.content.slice(0, 26);
    const current = conversations.find((conversation) => conversation.id === activeConversationId);
    const nextTitle =
      current?.title === "Welcome chat" && userSeed
        ? userSeed
        : current?.title;

    setConversations((state) =>
      state.map((conversation) =>
        conversation.id === activeConversationId
          ? {
              ...conversation,
              messages: nextMessages,
              updatedAt: new Date(),
              title: nextTitle ?? conversation.title,
            }
          : conversation,
      ),
    );

    const payload = {
      title: nextTitle,
      pinned: current?.pinned ?? false,
      messages: serializeMessages(nextMessages),
    };

    const isPersistedConversation = UUID_PATTERN.test(activeConversationId);
    const isTempConversation = !isPersistedConversation;

    void fetch("/api/ai/conversations", {
      method: isTempConversation ? "POST" : "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        isTempConversation
          ? payload
          : {
              ...payload,
              id: activeConversationId,
            },
      ),
    })
      .then(async (response) => {
        await logConversationApiResponse(isTempConversation ? "POST(message-upsert)" : "PATCH(messages)", response);
        if (!response.ok) return;
        const data = await response.json().catch(() => null);
        const persisted = data?.conversation;
        if (!persisted) return;

        const hydrated = hydrateConversation(persisted);
        setConversations((state) =>
          state.map((conversation) =>
            conversation.id === activeConversationId ? hydrated : conversation,
          ),
        );

        if (activeConversationId !== hydrated.id) {
          setActiveConversationId(hydrated.id);
        }
      })
      .catch(() => {
        // Keep optimistic local state even if persistence fails.
      });

    emitConversationsUpdated();
  };

  const startNewConversation = async () => {
    const tempId = `temp-${crypto.randomUUID()}`;
    const fallbackConversation: Conversation = {
      id: tempId,
      title: `Conversation ${conversations.length + 1}`,
      pinned: false,
      updatedAt: new Date(),
      messages: initial,
    };

    setConversations((state) => [fallbackConversation, ...state]);
    setActiveConversationId(tempId);
    setOpenConversationMenuId(null);

    try {
      const response = await fetch("/api/ai/conversations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: fallbackConversation.title,
          pinned: false,
          messages: serializeMessages(initial),
        }),
      });

      await logConversationApiResponse("POST(new-conversation)", response);

      if (!response.ok) return;
      const data = await response.json();
      const freshConversation = hydrateConversation(data.conversation);

      setConversations((state) =>
        state.map((conversation) =>
          conversation.id === tempId ? freshConversation : conversation,
        ),
      );
      setActiveConversationId(freshConversation.id);
      emitConversationsUpdated();
    } catch {
      // Keep optimistic conversation so user can continue chatting even if persistence fails.
    }
  };

  const deleteConversation = async (conversationId: string) => {
    if (conversations.length <= 1) {
      const id = crypto.randomUUID();
      const fallback: Conversation = {
        id,
        title: "Conversation 1",
        updatedAt: new Date(),
        pinned: false,
        messages: initial,
      };
      setConversations([fallback]);
      setActiveConversationId(id);
      setOpenConversationMenuId(null);
      void fetch("/api/ai/conversations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: fallback.title, pinned: false, messages: serializeMessages(initial) }),
      }).then(async (response) => {
        await logConversationApiResponse("POST(fallback-conversation)", response);
      });
      return;
    }

    void fetch("/api/ai/conversations", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: conversationId }),
    }).then(async (response) => {
      await logConversationApiResponse("DELETE", response);
    });

    const remaining = conversations.filter((conversation) => conversation.id !== conversationId);
    setConversations(remaining);
    if (activeConversationId === conversationId) {
      setActiveConversationId(remaining[0].id);
    }
    setOpenConversationMenuId(null);
    emitConversationsUpdated();
  };

  const togglePinConversation = (conversationId: string) => {
    const target = conversations.find((conversation) => conversation.id === conversationId);
    const nextPinned = !target?.pinned;

    setConversations((state) =>
      state.map((conversation) =>
        conversation.id === conversationId
          ? {
              ...conversation,
              pinned: !conversation.pinned,
              updatedAt: new Date(),
            }
          : conversation,
      ),
    );

    void fetch("/api/ai/conversations", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: conversationId, pinned: nextPinned }),
    }).then(async (response) => {
      await logConversationApiResponse("PATCH(pin)", response);
    });

    setOpenConversationMenuId(null);
    emitConversationsUpdated();
  };

  const editConversationName = (conversationId: string) => {
    const target = conversations.find((conversation) => conversation.id === conversationId);
    if (!target) return;

    const nextTitle = window.prompt("Rename conversation", target.title)?.trim();
    if (!nextTitle) {
      setOpenConversationMenuId(null);
      return;
    }

    setConversations((state) =>
      state.map((conversation) =>
        conversation.id === conversationId
          ? {
              ...conversation,
              title: nextTitle,
              updatedAt: new Date(),
            }
          : conversation,
      ),
    );

    void fetch("/api/ai/conversations", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: conversationId, title: nextTitle }),
    }).then(async (response) => {
      await logConversationApiResponse("PATCH(title)", response);
    });

    setOpenConversationMenuId(null);
    emitConversationsUpdated();
  };

  const handleSend = async (content: string) => {
    const userMessage: ChatMessageType = {
      id: crypto.randomUUID(),
      role: "user",
      content,
      timestamp: new Date(),
    };

    const nextMessages = [...messages, userMessage];
    setActiveMessages(nextMessages);

    const attachedTasks = tasks
      .filter((task) => attachedTaskIds.includes(task.id))
      .map((task) => ({
        ...task,
        note: notesByTaskId[task.id] ?? "",
      }));
    setLastSubmittedAttachedCount(attachedTasks.length);
    const result = await askAI(nextMessages, tasks, { attachedTaskIds, attachedTasks });

    if (result.action?.type === "CREATE_TASK") {
      const task = result.action.task as Partial<Task>;
      if (task.title) {
        await addTask({
          title: task.title,
          description: task.description,
          status: "pending",
          priority: task.priority ?? "medium",
          category: task.category,
          dueDate: task.dueDate,
          subtasks: task.subtasks,
        });
        pushNotification({
          type: "update",
          message: `AI created task: ${task.title}`,
          taskTitle: task.title,
        });
      }
    }

    const assistantMessage: ChatMessageType = {
      id: crypto.randomUUID(),
      role: "assistant",
      content: result.reply,
      timestamp: new Date(),
    };
    setActiveMessages([...nextMessages, assistantMessage]);
  };

  return (
    <div
      className={`flex flex-col rounded-2xl border border-white/20 bg-white/10 backdrop-blur-xl transition-[height] duration-300 ${
        expanded ? "h-[calc(100vh-5.5rem)]" : "h-[calc(100vh-8rem)]"
      }`}
    >
      <div className="border-b border-white/10 p-4">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <div className="grid size-9 place-items-center rounded-full bg-gradient-to-r from-violet-500 to-blue-500 animate-pulse-glow">
              <Bot className="size-4 text-white" />
            </div>
            <div>
              <h2 className={isLight ? "text-slate-900" : "text-white"}>AI Assistant</h2>
              <p className={`text-xs ${isLight ? "text-slate-600" : "text-slate-400"}`}>Live task copilot</p>
            </div>
          </div>

        </div>

        <div className="flex flex-wrap gap-2 text-xs">
          {[
            "Create tasks",
            "Break into steps",
            "Set reminders",
            "Productivity tips",
            "Summarize progress",
          ].map((chip) => (
            <span
              key={chip}
              className={`rounded-full border px-2 py-1 ${isLight ? "border-violet-200 bg-violet-50 text-violet-700" : "border-violet-300/35 bg-violet-500/20 text-violet-200"}`}
            >
              {chip}
            </span>
          ))}
        </div>
      </div>

      <div className="relative flex min-h-0 flex-1">
        <aside
          className={`overflow-y-hidden border-r border-white/10 bg-black/20 transition-[width] duration-300 ${
            showConversations ? (expanded ? "w-72" : "w-64") : "w-0 border-r-0"
          }`}
        >
          <div className={`h-full overflow-y-auto p-2 transition-opacity duration-200 ${showConversations ? "opacity-100" : "opacity-0"}`}>
            <button
              type="button"
              onClick={() => setPendingNewConversation(true)}
              className="mb-2 flex w-full items-center gap-2 rounded-lg border border-white/15 bg-white/10 px-2 py-1.5 text-left text-xs text-slate-100 transition hover:bg-white/15"
              disabled={!showConversations}
            >
              <Plus className="size-3.5" /> New chat conversation
            </button>

            <div className="space-y-1">
              {orderedConversations.map((conversation) => (
                <div
                  key={conversation.id}
                  className={`relative rounded-lg border px-2 py-1.5 text-xs transition ${
                    conversation.id === activeConversationId
                      ? isLight
                        ? "border-violet-300 bg-violet-100/80 text-slate-900"
                        : "accent-soft-bg accent-soft-border text-white"
                      : isLight
                        ? "border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
                        : "border-white/10 bg-white/5 text-slate-300 hover:bg-white/10"
                  }`}
                >
                  <div className="flex items-start gap-1.5">
                    <button
                      type="button"
                      onClick={() => {
                        setActiveConversationId(conversation.id);
                        setOpenConversationMenuId(null);
                      }}
                      className="min-w-0 flex-1 text-left"
                    >
                      <p className="flex items-center gap-1.5 truncate font-medium">
                        <span className="truncate">{conversation.title}</span>
                        {conversation.pinned ? <Pin className="size-3 shrink-0 text-amber-300" /> : null}
                      </p>
                      <p className={`mt-0.5 text-[10px] ${isLight ? "text-slate-500" : "text-slate-400"}`}>
                        {mounted ? conversation.updatedAt.toLocaleString() : "..."}
                      </p>
                    </button>

                    <button
                      type="button"
                      onClick={() =>
                        setOpenConversationMenuId((state) =>
                          state === conversation.id ? null : conversation.id,
                        )
                      }
                      className={`rounded-md border p-1 transition ${isLight ? "border-slate-300 bg-white text-slate-700 hover:bg-slate-50" : "border-white/15 bg-white/5 text-slate-200 hover:bg-white/10"}`}
                      aria-label="Conversation options"
                      title="Conversation options"
                    >
                      <MoreVertical className="size-3.5" />
                    </button>
                  </div>

                  {openConversationMenuId === conversation.id ? (
                    <div className={`absolute right-2 top-8 z-20 w-40 rounded-lg border p-1.5 shadow-xl ${isLight ? "border-slate-200 bg-white" : "border-white/15 bg-slate-900/95"}`}>
                      <button
                        type="button"
                        onClick={() => editConversationName(conversation.id)}
                        className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition ${isLight ? "text-slate-700 hover:bg-slate-100" : "text-slate-100 hover:bg-white/10"}`}
                      >
                        <Menu className="size-3.5" /> Edit name
                      </button>
                      <button
                        type="button"
                        onClick={() => togglePinConversation(conversation.id)}
                        className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition ${isLight ? "text-slate-700 hover:bg-slate-100" : "text-slate-100 hover:bg-white/10"}`}
                      >
                        <Pin className="size-3.5" /> {conversation.pinned ? "Unpin conversation" : "Pin conversation"}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setPendingDeleteConversation(conversation);
                          setOpenConversationMenuId(null);
                        }}
                        className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition ${isLight ? "text-red-700 hover:bg-red-50" : "text-red-300 hover:bg-red-500/20"}`}
                      >
                        <Trash2 className="size-3.5" /> Delete conversation
                      </button>
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          </div>
        </aside>

        <motion.button
          type="button"
          onClick={() => setShowConversations((state) => !state)}
          className="absolute top-1/2 z-10 -translate-y-1/2 rounded-r-full border border-white/15 bg-white/10 p-1.5 text-slate-200 transition hover:bg-white/20"          initial={false}
          animate={{ left: showConversations ? (expanded ? 288 : 256) : 0 }}
          transition={{ type: "spring", stiffness: 320, damping: 28, mass: 0.8 }}
          title={showConversations ? "Collapse conversations" : "Expand conversations"}
          aria-label={showConversations ? "Collapse conversations" : "Expand conversations"}
        >
          {showConversations ? <ChevronLeft className="size-4" /> : <ChevronRight className="size-4" />}
        </motion.button>

        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="flex-1 overflow-y-auto p-4">
            <AISuggestions onPick={handleSend} />
            <div className="space-y-2">
              {messages.map((message) => (
                <ChatMessage key={message.id} message={message} />
              ))}
              {loading ? (
                <div className="flex gap-1 px-2 py-1">
                  <span className="size-2 animate-bounce-dot rounded-full bg-violet-300" />
                  <span className="size-2 animate-bounce-dot rounded-full bg-violet-300 [animation-delay:0.2s]" />
                  <span className="size-2 animate-bounce-dot rounded-full bg-violet-300 [animation-delay:0.4s]" />
                </div>
              ) : null}
            </div>
          </div>

          <TaskAttachmentToolbar
            tasks={tasks}
            selectedTaskIds={attachedTaskIds}
            onToggleTask={(taskId) => {
              setAttachedTaskIds((state) =>
                state.includes(taskId) ? state.filter((id) => id !== taskId) : [...state, taskId],
              );
            }}
            onClear={() => setAttachedTaskIds([])}
          />
        </div>
      </div>

      <ConfirmationModal
        open={pendingNewConversation}
        title="Start a new conversation?"
        message="This will create a fresh AI chat thread and preserve the current one in your history."
        confirmLabel="Start conversation"
        confirmVariant="primary"
        onCancel={() => setPendingNewConversation(false)}
        onConfirm={() => {
          setPendingNewConversation(false);
          void startNewConversation();
        }}
      />

      <ConfirmationModal
        open={!!pendingDeleteConversation}
        title="Delete conversation?"
        message={`This will permanently remove ${pendingDeleteConversation?.title ?? "this conversation"}.`}
        confirmLabel="Delete"
        confirmVariant="danger"
        onCancel={() => setPendingDeleteConversation(null)}
        onConfirm={() => {
          if (!pendingDeleteConversation) return;
          void deleteConversation(pendingDeleteConversation.id);
          setPendingDeleteConversation(null);
        }}
      />

      <ChatInput onSend={handleSend} disabled={loading} />
      {loading ? (
        <p className="px-3 pb-2 text-[11px] text-cyan-200">
          Sending {lastSubmittedAttachedCount} attached task{lastSubmittedAttachedCount === 1 ? "" : "s"}
        </p>
      ) : null}
    </div>
  );
}