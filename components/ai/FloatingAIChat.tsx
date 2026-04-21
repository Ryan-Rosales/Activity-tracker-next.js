"use client";

import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useDragControls } from "framer-motion";
import { Bot, Maximize2, Menu, Minimize2, MoreVertical, Pin, Plus, Sparkles, Trash2, X } from "lucide-react";
import { AISuggestions } from "@/components/ai/AISuggestions";
import { ChatInput } from "@/components/ai/ChatInput";
import { ChatMessage } from "@/components/ai/ChatMessage";
import { TaskAttachmentToolbar } from "@/components/ai/TaskAttachmentToolbar";
import { useAI } from "@/hooks/useAI";
import { ChatMessage as ChatMessageType, Task } from "@/lib/types";
import { useTaskStore } from "@/lib/store/useTaskStore";
import { useTaskNotesStore } from "@/lib/store/useTaskNotesStore";
import { useNotificationStore } from "@/lib/store/useNotificationStore";
import { useAuthStore } from "@/lib/store/useAuthStore";
import { useThemeStore } from "@/lib/store/useThemeStore";
import { ConfirmationModal } from "@/components/ui/ConfirmationModal";

type Conversation = {
  id: string;
  title: string;
  updatedAt: Date;
  pinned: boolean;
  messages: ChatMessageType[];
};

const upsertHydratedConversation = (
  state: Conversation[],
  hydrated: Conversation,
  targetId?: string,
) => {
  let replaced = false;
  const next = state.map((conversation) => {
    if (conversation.id === (targetId ?? hydrated.id) || conversation.id === hydrated.id) {
      replaced = true;
      return hydrated;
    }
    return conversation;
  });

  return replaced ? next : [hydrated, ...next];
};

const AI_CONVERSATIONS_UPDATED_EVENT = "ai:conversations-updated";
const AI_CONVERSATIONS_CACHE_KEY_PREFIX = "activity-ai-conversations-cache-v1";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const getConversationsCacheKey = (email?: string | null) => {
  const normalized = (email ?? "").trim().toLowerCase();
  return normalized
    ? `${AI_CONVERSATIONS_CACHE_KEY_PREFIX}:${normalized}`
    : AI_CONVERSATIONS_CACHE_KEY_PREFIX;
};

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
    id: "floating-welcome",
    role: "assistant",
    content: "Ask me anything about your tasks. I can create tasks and break work into steps.",
    timestamp: new Date(),
  },
];

export function FloatingAIChat() {
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [showConversations, setShowConversations] = useState(false);
  const [attachedTaskIds, setAttachedTaskIds] = useState<string[]>([]);
  const [cacheHydrated, setCacheHydrated] = useState(false);
  const [pendingNewConversation, setPendingNewConversation] = useState(false);
  const [lastSubmittedAttachedCount, setLastSubmittedAttachedCount] = useState(0);
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
  const [openConversationMenuId, setOpenConversationMenuId] = useState<string | null>(null);
  const [pendingDeleteConversation, setPendingDeleteConversation] = useState<Conversation | null>(null);
  const launcherDragControls = useDragControls();
  const { askAI, loading } = useAI();
  const tasks = useTaskStore((state) => state.tasks);
  const notesByTaskId = useTaskNotesStore((state) => state.notesByTaskId);
  const addTask = useTaskStore((state) => state.addTask);
  const pushNotification = useNotificationStore((state) => state.pushNotification);
  const userEmail = useAuthStore((state) => state.user?.email ?? null);
  const mode = useThemeStore((state) => state.mode);
  const isLight = mode === "light";
  const migratedLocalConversationsRef = useRef(false);

  const serializeMessages = (items: ChatMessageType[]) =>
    items.map((message) => ({
      ...message,
      timestamp: new Date(message.timestamp).toISOString(),
    }));

  const serializeConversationForApi = (conversation: Conversation) => ({
    id: conversation.id,
    title: conversation.title,
    pinned: conversation.pinned,
    updatedAt: conversation.updatedAt.toISOString(),
    messages: serializeMessages(conversation.messages),
  });

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
    const response = await fetch("/api/ai/conversations", { cache: "no-store" });
    await logConversationApiResponse("GET", response);
    if (!response.ok) return;

    const data = await response.json();
    const nextConversations: Conversation[] = (data.conversations ?? []).map(hydrateConversation);
    const localConversations = conversations.filter(
      (conversation) => conversation.id !== "conversation-initial" || conversation.messages.length > initial.length,
    );

    if (!nextConversations.length && localConversations.length && !migratedLocalConversationsRef.current) {
      for (const conversation of localConversations) {
        await fetch("/api/ai/conversations", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(serializeConversationForApi(conversation)),
        }).then(async (syncResponse) => {
          await logConversationApiResponse("POST(local-migration)", syncResponse);
        });
      }

      migratedLocalConversationsRef.current = true;

      const refreshed = await fetch("/api/ai/conversations", { cache: "no-store" });
      await logConversationApiResponse("GET(refreshed)", refreshed);
      if (refreshed.ok) {
        const refreshedData = await refreshed.json();
        const refreshedConversations: Conversation[] = (refreshedData.conversations ?? []).map(hydrateConversation);
        if (refreshedConversations.length) {
          setConversations(refreshedConversations);
          setActiveConversationId((prev) =>
            refreshedConversations.some((conversation) => conversation.id === prev)
              ? prev
              : refreshedConversations[0].id,
          );
          return;
        }
      }
    }

    if (!nextConversations.length) return;

    setConversations(nextConversations);
    setActiveConversationId((prev) =>
      nextConversations.some((conversation) => conversation.id === prev)
        ? prev
        : nextConversations[0].id,
    );
  };

  const readConversationsCache = (cacheKey: string) => {
    if (typeof window === "undefined") return;

    const raw = window.localStorage.getItem(cacheKey);
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

  const writeConversationsCache = (cacheKey: string, nextConversations: Conversation[], nextActiveId: string) => {
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
      cacheKey,
      JSON.stringify({ conversations: serializable, activeConversationId: nextActiveId }),
    );
  };

  useEffect(() => {
    const cacheKey = getConversationsCacheKey(userEmail);
    setConversations([
      {
        id: "conversation-initial",
        title: "Welcome chat",
        updatedAt: new Date(),
        pinned: false,
        messages: initial,
      },
    ]);
    setActiveConversationId("conversation-initial");
    setCacheHydrated(false);
    migratedLocalConversationsRef.current = false;
    readConversationsCache(cacheKey);
  }, [userEmail]);

  useEffect(() => {
    if (!cacheHydrated) return;
    const cacheKey = getConversationsCacheKey(userEmail);
    writeConversationsCache(cacheKey, conversations, activeConversationId);
  }, [cacheHydrated, conversations, activeConversationId, userEmail]);

  useEffect(() => {
    if (!open) return;

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
  }, [open]);

  const orderedConversations = [...conversations].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return b.updatedAt.getTime() - a.updatedAt.getTime();
  });
  const activeConversation = orderedConversations.find((conversation) => conversation.id === activeConversationId) ?? orderedConversations[0];
  const messages = activeConversation?.messages ?? initial;

  const setActiveMessages = (nextMessages: ChatMessageType[]) => {
    const conversationIdAtUpdate = activeConversationId;
    const userSeed = nextMessages.find((item) => item.role === "user")?.content.slice(0, 26);
    const current = conversations.find((conversation) => conversation.id === conversationIdAtUpdate);
    const nextTitle =
      current?.title === "Welcome chat" && userSeed
        ? userSeed
        : current?.title;

    setConversations((state) =>
      state.map((conversation) =>
        conversation.id === conversationIdAtUpdate
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

    const isPersistedConversation = UUID_PATTERN.test(conversationIdAtUpdate);
    const isTempConversation = !isPersistedConversation;

    void fetch("/api/ai/conversations", {
      method: isTempConversation ? "POST" : "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        isTempConversation
          ? payload
          : {
              ...payload,
              id: conversationIdAtUpdate,
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
          upsertHydratedConversation(state, hydrated, conversationIdAtUpdate),
        );

        if (conversationIdAtUpdate !== hydrated.id) {
          setActiveConversationId(hydrated.id);
        }

        emitConversationsUpdated();
      })
      .catch(() => {
        // Keep optimistic local state even if persistence fails.
      });
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
    <>
      <motion.div
        drag
        dragListener={false}
        dragControls={launcherDragControls}
        dragElastic={0.08}
        dragMomentum={false}
        layoutId="ai-floating-shell"
        className="fixed bottom-8 right-6 z-[320] md:bottom-10 md:right-8"
        style={{ touchAction: "none" }}
      >
        <motion.button
          type="button"
          onClick={() => {
            setOpen(true);
            void loadConversations();
          }}
          whileHover={{ y: -3, scale: 1.03 }}
          whileTap={{ scale: 0.96 }}
          className="relative inline-flex h-14 w-14 items-center justify-center rounded-full border text-white ring-1"
          style={{
            borderColor: "rgb(var(--accent-rgb) / 0.35)",
            background: "linear-gradient(145deg, color-mix(in srgb, var(--accent) 88%, #38bdf8), #1d4ed8)",
            boxShadow: "0 16px 36px rgb(var(--accent-rgb) / 0.42)",
          }}
          aria-label="Open AI assistant"
        >
          <Bot className="size-6" />
        </motion.button>
        <button
          type="button"
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            event.preventDefault();
            launcherDragControls.start(event);
          }}
          onClick={(event) => {
            event.stopPropagation();
          }}
          className="absolute right-1 top-1 inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-bold leading-none text-slate-900 cursor-grab active:cursor-grabbing"
          style={{ backgroundColor: "rgb(var(--accent-rgb) / 0.78)" }}
          aria-label="Move AI assistant"
          title="Left-click and drag to move"
        >
          AI
        </button>
      </motion.div>

      <AnimatePresence>
        {open ? (
          <>
            <motion.button
              type="button"
              aria-label="Close AI assistant"
              onClick={() => setOpen(false)}
              className="fixed inset-0 z-[330] bg-black/35 backdrop-blur-[1px]"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
            />

            <motion.section
              layoutId="ai-floating-shell"
              initial={{ opacity: 0, scale: 0.65, y: 28 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.8, y: 20 }}
              transition={{ type: "spring", stiffness: 340, damping: 28 }}
              className={`fixed z-[340] flex flex-col overflow-hidden rounded-2xl border transition-[width,height,right,bottom] duration-300 ${
                isLight
                  ? "border-slate-200 bg-slate-50/98 shadow-[0_24px_70px_rgba(15,23,42,0.16)]"
                  : "border-white/20 bg-slate-950/92 shadow-[0_24px_80px_rgba(0,0,0,0.45)]"
              } ${
                expanded
                  ? "bottom-4 right-4 h-[min(86vh,44rem)] w-[min(56rem,calc(100vw-2rem))]"
                  : "bottom-8 right-4 h-[min(72vh,34rem)] w-[min(26rem,calc(100vw-2rem))] md:bottom-10 md:right-8"
              }`}
            >
              <header className={`flex items-center justify-between border-b px-4 py-3 ${isLight ? "border-slate-200" : "border-white/10"}`}>
                <div className="flex items-center gap-2">
                  <div
                    className="grid size-8 place-items-center rounded-full text-white"
                    style={{ background: "linear-gradient(90deg, var(--accent), #3b82f6)" }}
                  >
                    <Sparkles className="size-4" />
                  </div>
                  <div>
                    <p className={`text-sm font-semibold ${isLight ? "text-slate-900" : "text-white"}`}>AI Assistant</p>
                    <p className={`text-[11px] ${isLight ? "text-slate-600" : "text-slate-400"}`}>Live task copilot</p>
                  </div>
                </div>
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => setShowConversations((state) => !state)}
                    className={`rounded-lg border p-1.5 transition ${isLight ? "border-slate-300 bg-white text-slate-700 hover:bg-slate-50" : "border-white/15 bg-white/5 text-slate-200 hover:bg-white/10"}`}
                    title="Recent conversations"
                    aria-label="Recent conversations"
                  >
                    <Menu className="size-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => setExpanded((state) => !state)}
                    className={`rounded-lg border p-1.5 transition ${isLight ? "border-slate-300 bg-white text-slate-700 hover:bg-slate-50" : "border-white/15 bg-white/5 text-slate-200 hover:bg-white/10"}`}
                    title={expanded ? "Restore size" : "Expand"}
                    aria-label={expanded ? "Restore size" : "Expand"}
                  >
                    {expanded ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
                  </button>
                  <button
                    type="button"
                    onClick={() => setOpen(false)}
                    className={`rounded-lg border p-1.5 transition ${isLight ? "border-slate-300 bg-white text-slate-700 hover:bg-slate-50" : "border-white/15 bg-white/5 text-slate-200 hover:bg-white/10"}`}
                  >
                    <X className="size-4" />
                  </button>
                </div>
              </header>

              <div className="flex min-h-0 flex-1">
                <AnimatePresence initial={false}>
                  {showConversations ? (
                    <motion.aside
                      initial={{ width: 0, opacity: 0 }}
                      animate={{ width: 240, opacity: 1 }}
                      exit={{ width: 0, opacity: 0 }}
                      className={`overflow-hidden border-r ${isLight ? "border-slate-200 bg-slate-100/75" : "border-white/10 bg-black/20"}`}
                    >
                      <div className="flex items-center justify-between px-3 py-2">
                        <p className={`text-xs font-semibold uppercase tracking-[0.2em] ${isLight ? "text-slate-600" : "text-slate-400"}`}>Recent</p>
                      </div>
                      <div className="px-2 pb-2">
                        <button
                          type="button"
                          onClick={() => setPendingNewConversation(true)}
                          className={`mb-2 flex w-full items-center gap-2 rounded-lg border px-2 py-1.5 text-left text-xs transition ${isLight ? "border-slate-300 bg-white text-slate-700 hover:bg-slate-50" : "border-white/15 bg-white/10 text-slate-100 hover:bg-white/15"}`}
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
                                    {conversation.updatedAt.toLocaleString()}
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
                    </motion.aside>
                  ) : null}
                </AnimatePresence>

                <div className="flex min-h-0 min-w-0 flex-1 flex-col">
                  <div className="flex-1 overflow-y-auto p-3">
                    <AISuggestions onPick={handleSend} />
                    <div className="space-y-2">
                      {messages.map((message) => (
                        <ChatMessage key={message.id} message={message} />
                      ))}
                      {loading ? (
                        <div className="flex gap-1 px-2 py-1">
                          <span className="size-2 animate-bounce-dot rounded-full accent-solid-bg" />
                          <span className="size-2 animate-bounce-dot rounded-full accent-solid-bg [animation-delay:0.2s]" />
                          <span className="size-2 animate-bounce-dot rounded-full accent-solid-bg [animation-delay:0.4s]" />
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

                  {loading ? (
                    <p className="px-3 pb-2 text-[11px] text-cyan-200">
                      Sending {lastSubmittedAttachedCount} attached task{lastSubmittedAttachedCount === 1 ? "" : "s"}
                    </p>
                  ) : null}

                  <ChatInput onSend={handleSend} disabled={loading} />
                </div>
              </div>
            </motion.section>
          </>
        ) : null}
      </AnimatePresence>

      <AnimatePresence>
        {pendingNewConversation ? (
          <div className="fixed inset-0 z-[360] grid place-items-center bg-black/65 p-2 sm:p-4">
            <motion.div
              initial={{ opacity: 0, scale: 0.96, y: 8 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.96, y: 8 }}
              className="w-full max-w-md rounded-2xl border border-white/20 bg-slate-950/95 p-5 text-white shadow-2xl backdrop-blur-2xl"
            >
              <h3 className="text-lg font-semibold">Start a new conversation?</h3>
              <p className="mt-2 text-sm text-slate-300">
                This will create a fresh AI chat thread and keep the current conversation in your history.
              </p>
              <div className="mt-5 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setPendingNewConversation(false)}
                  className="rounded-xl border border-white/20 px-4 py-2 text-sm text-white transition hover:bg-white/10"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setPendingNewConversation(false);
                    void startNewConversation();
                  }}
                  className="rounded-xl border border-violet-300/30 bg-violet-500/15 px-4 py-2 text-sm text-violet-100 transition hover:bg-violet-500/25"
                >
                  Start conversation
                </button>
              </div>
            </motion.div>
          </div>
        ) : null}

        {pendingDeleteConversation ? (
          <div className="fixed inset-0 z-[360] grid place-items-center bg-black/65 p-2 sm:p-4">
            <motion.div
              initial={{ opacity: 0, scale: 0.96, y: 8 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.96, y: 8 }}
              className="w-full max-w-md rounded-2xl border border-white/20 bg-slate-950/95 p-5 text-white shadow-2xl backdrop-blur-2xl"
            >
              <h3 className="text-lg font-semibold">Delete conversation?</h3>
              <p className="mt-2 text-sm text-slate-300">
                This will permanently remove <span className="font-medium text-white">{pendingDeleteConversation.title}</span>.
              </p>
              <div className="mt-5 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setPendingDeleteConversation(null)}
                  className="rounded-xl border border-white/20 px-4 py-2 text-sm text-white transition hover:bg-white/10"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => {
                    void deleteConversation(pendingDeleteConversation.id);
                    setPendingDeleteConversation(null);
                  }}
                  className="rounded-xl border border-red-300/30 bg-red-500/15 px-4 py-2 text-sm text-red-100 transition hover:bg-red-500/25"
                >
                  Delete
                </button>
              </div>
            </motion.div>
          </div>
        ) : null}
      </AnimatePresence>
    </>
  );
}
