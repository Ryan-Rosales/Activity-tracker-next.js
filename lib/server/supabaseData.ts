import { createClient } from "@supabase/supabase-js";
import { mapNotificationRow, mapTaskRow } from "@/lib/server/mappers";
import type { ChatMessage, Notification, Task } from "@/lib/types";

type ConversationRow = {
  id: string;
  owner_email: string;
  title: string;
  pinned: boolean;
  messages: ChatMessage[] | string | null;
  created_at: string;
  updated_at: string;
};

const getSupabaseConfig = () => {
  const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceRoleKey) {
    throw new Error("Supabase data access is not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.");
  }

  return { url, serviceRoleKey };
};

const globalForSupabaseData = globalThis as unknown as {
  supabaseDataClient?: ReturnType<typeof createClient<any>>;
};

export const getSupabaseDataClient = () => {
  if (globalForSupabaseData.supabaseDataClient) {
    return globalForSupabaseData.supabaseDataClient;
  }

  const { url, serviceRoleKey } = getSupabaseConfig();
  const client = createClient(url, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });

  globalForSupabaseData.supabaseDataClient = client;
  return client;
};

const normalizeMessageList = (value: ConversationRow["messages"]): ChatMessage[] => {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? (parsed as ChatMessage[]) : [];
    } catch {
      return [];
    }
  }
  return [];
};

const toConversation = (row: ConversationRow) => ({
  id: row.id,
  title: row.title,
  pinned: row.pinned,
  messages: normalizeMessageList(row.messages).map((message) => ({
    ...message,
    timestamp: new Date(message.timestamp),
  })),
  createdAt: new Date(row.created_at),
  updatedAt: new Date(row.updated_at),
});

export const fetchTasksViaSupabase = async (email: string): Promise<Task[]> => {
  const client = getSupabaseDataClient();
  const { data, error } = await client
    .from("tasks")
    .select("*")
    .eq("owner_email", email)
    .order("created_at", { ascending: false });

  if (error) throw new Error(error.message || "Failed to load tasks.");

  return (data ?? []).map(mapTaskRow);
};

export const upsertTaskViaSupabase = async (email: string, task: {
  id?: string;
  title: string;
  description?: string | null;
  status?: Task["status"];
  priority?: Task["priority"];
  category?: string | null;
  dueDate?: string | null;
  completedAt?: string | null;
  archivedAt?: string | null;
  subtasks?: Task["subtasks"];
  createdAt?: string | null;
  updatedAt?: string | null;
}) => {
  const client = getSupabaseDataClient();
  const payload = {
    id: task.id ?? crypto.randomUUID(),
    owner_email: email,
    title: task.title,
    description: task.description ?? null,
    status: task.status ?? "pending",
    priority: task.priority ?? "medium",
    category: task.category ?? null,
    due_date: task.dueDate ?? null,
    completed_at: task.completedAt ?? null,
    archived_at: task.archivedAt ?? null,
    subtasks: task.subtasks ?? [],
    created_at: task.createdAt ?? new Date().toISOString(),
    updated_at: task.updatedAt ?? new Date().toISOString(),
  };

  const { data, error } = await client.from("tasks").upsert(payload, { onConflict: "id" }).select("*").single();
  if (error || !data) throw new Error(error?.message || "Failed to save task.");

  return mapTaskRow(data);
};

export const deleteTaskViaSupabase = async (email: string, id: string) => {
  const client = getSupabaseDataClient();
  const { error } = await client.from("tasks").delete().eq("id", id).eq("owner_email", email);
  if (error) throw new Error(error.message || "Failed to delete task.");
};

export const fetchNotificationsViaSupabase = async (email: string): Promise<Notification[]> => {
  const client = getSupabaseDataClient();
  const { data, error } = await client
    .from("notifications")
    .select("*")
    .eq("owner_email", email)
    .order("timestamp", { ascending: false });

  if (error) throw new Error(error.message || "Failed to load notifications.");

  return (data ?? []).map(mapNotificationRow);
};

export const fetchConversationsViaSupabase = async (email: string) => {
  const client = getSupabaseDataClient();
  const { data, error } = await client
    .from("ai_conversations")
    .select("*")
    .eq("owner_email", email)
    .order("pinned", { ascending: false })
    .order("updated_at", { ascending: false });

  if (error) throw new Error(error.message || "Failed to load conversations.");

  return (data ?? []).map((row) => toConversation(row as ConversationRow));
};

export const upsertConversationViaSupabase = async (email: string, conversation: {
  id?: string;
  title?: string;
  pinned?: boolean;
  messages?: Array<{ id: string; role: "user" | "assistant"; content: string; timestamp: string | Date }>;
  createdAt?: string | Date;
  updatedAt?: string | Date;
}) => {
  const client = getSupabaseDataClient();
  const payload = {
    id: conversation.id ?? crypto.randomUUID(),
    owner_email: email,
    title: conversation.title ?? "New conversation",
    pinned: conversation.pinned ?? false,
    messages: conversation.messages ?? [],
    created_at: conversation.createdAt ? new Date(conversation.createdAt).toISOString() : new Date().toISOString(),
    updated_at: conversation.updatedAt ? new Date(conversation.updatedAt).toISOString() : new Date().toISOString(),
  };

  const { data, error } = await client.from("ai_conversations").upsert(payload, { onConflict: "id" }).select("*").single();
  if (error || !data) throw new Error(error?.message || "Failed to save conversation.");

  return toConversation(data as ConversationRow);
};

export const deleteConversationViaSupabase = async (email: string, id: string) => {
  const client = getSupabaseDataClient();
  const { error } = await client.from("ai_conversations").delete().eq("id", id).eq("owner_email", email);
  if (error) throw new Error(error.message || "Failed to delete conversation.");
};
