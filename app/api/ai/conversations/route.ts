import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { runWithUserContext } from "@/lib/server/db";
import type { ChatMessage } from "@/lib/types";
import type { PoolClient } from "pg";
import {
  deleteConversationViaSupabase,
  fetchConversationsViaSupabase,
  upsertConversationViaSupabase,
} from "@/lib/server/supabaseData";

type ConversationRow = {
  id: string;
  title: string;
  pinned: boolean;
  messages: ChatMessage[] | string | null;
  created_at: string;
  updated_at: string;
};

const getEmail = async () => (await cookies()).get("activity_user_email")?.value?.trim().toLowerCase() ?? "";

const isDatabaseUnavailableError = (error: unknown) => {
  const message = error instanceof Error ? error.message : "";
  return (
    message.includes("ENOTFOUND") ||
    message.includes("ECONNREFUSED") ||
    message.includes("ECONNRESET") ||
    message.includes("ETIMEDOUT") ||
    message.includes("timeout") ||
    message.includes("connect") ||
    message.includes("terminated unexpectedly") ||
    message.includes("could not connect") ||
    message.includes("DATABASE_URL")
  );
};

const ensureAiConversationsTable = async (client: PoolClient) => {
  await client.query(
    `create table if not exists public.ai_conversations (
      id text primary key,
      owner_email text not null,
      title text not null default 'New conversation',
      pinned boolean not null default false,
      messages jsonb not null default '[]'::jsonb,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )`,
  );

  await client.query(
    `create index if not exists ai_conversations_owner_updated_idx
      on public.ai_conversations (owner_email, updated_at desc)`,
  );
};

const normalizeMessages = (value: ConversationRow["messages"]): ChatMessage[] => {
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

const toConversation = (row: ConversationRow) => {
  const messages = normalizeMessages(row.messages).map((message) => ({
    ...message,
    timestamp: new Date(message.timestamp),
  }));

  return {
    id: row.id,
    title: row.title,
    pinned: row.pinned,
    messages,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
};

const errorResponse = (error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown server error";
  return NextResponse.json(
    {
      error: "Failed to process ai conversations request.",
      details: process.env.NODE_ENV === "production" ? undefined : message,
    },
    { status: 500 },
  );
};

export async function GET() {
  try {
    const email = await getEmail();
    if (!email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const conversations = await runWithUserContext(email, async (client) => {
      await ensureAiConversationsTable(client);

      const result = await client.query(
        `select id, title, pinned, messages, created_at, updated_at
         from public.ai_conversations
         where owner_email = $1
         order by pinned desc, updated_at desc`,
        [email],
      );

      return result.rows.map((row) => toConversation(row));
    });

    return NextResponse.json({ conversations });
  } catch (error) {
    if (isDatabaseUnavailableError(error)) {
      const email = await getEmail();
      if (!email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

      const conversations = await fetchConversationsViaSupabase(email);
      return NextResponse.json({ conversations });
    }

    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    id?: string;
    title?: string;
    pinned?: boolean;
    messages?: Array<{ id: string; role: "user" | "assistant"; content: string; timestamp: string | Date }>;
    createdAt?: string | Date;
    updatedAt?: string | Date;
  };

  try {
    const email = await getEmail();
    if (!email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const conversation = await runWithUserContext(email, async (client) => {
      await ensureAiConversationsTable(client);

      const result = await client.query(
        `insert into public.ai_conversations (id, owner_email, title, pinned, messages, created_at, updated_at)
         values ($1, $2, $3, $4, $5, $6, $7)
         on conflict (id) do update set
           title = excluded.title,
           pinned = excluded.pinned,
           messages = excluded.messages,
           updated_at = now()
         returning id, title, pinned, messages, created_at, updated_at`,
        [
          body.id ?? crypto.randomUUID(),
          email,
          body.title ?? "New conversation",
          body.pinned ?? false,
          JSON.stringify(body.messages ?? []),
          body.createdAt ? new Date(body.createdAt).toISOString() : new Date().toISOString(),
          body.updatedAt ? new Date(body.updatedAt).toISOString() : new Date().toISOString(),
        ],
      );

      return toConversation(result.rows[0]);
    });

    return NextResponse.json({ conversation });
  } catch (error) {
    if (isDatabaseUnavailableError(error)) {
      const email = await getEmail();
      if (!email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

      const conversation = await upsertConversationViaSupabase(email, body);
      return NextResponse.json({ conversation });
    }

    return errorResponse(error);
  }
}

export async function PATCH(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    id?: string;
    title?: string;
    pinned?: boolean;
    messages?: Array<{ id: string; role: "user" | "assistant"; content: string; timestamp: string | Date }>;
    createdAt?: string | Date;
    updatedAt?: string | Date;
  };

  try {
    const email = await getEmail();
    if (!email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    if (!body.id) return NextResponse.json({ error: "Conversation id is required." }, { status: 400 });

    const conversation = await runWithUserContext(email, async (client) => {
      await ensureAiConversationsTable(client);

      const result = await client.query(
        `update public.ai_conversations
         set title = coalesce($3, title),
             pinned = coalesce($4, pinned),
             messages = coalesce($5, messages),
             updated_at = now()
         where id = $1 and owner_email = $2
         returning id, title, pinned, messages, created_at, updated_at`,
        [body.id, email, body.title ?? null, body.pinned ?? null, body.messages ? JSON.stringify(body.messages) : null],
      );

      return result.rows[0] ? toConversation(result.rows[0]) : null;
    });

    if (!conversation) return NextResponse.json({ error: "Conversation not found." }, { status: 404 });

    return NextResponse.json({ conversation });
  } catch (error) {
    if (isDatabaseUnavailableError(error)) {
      if (!body.id) {
        return NextResponse.json({ error: "Conversation id is required." }, { status: 400 });
      }

      const email = await getEmail();
      if (!email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

      const conversation = await upsertConversationViaSupabase(email, body);
      return NextResponse.json({ conversation });
    }

    return errorResponse(error);
  }
}

export async function DELETE(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { id?: string };

  try {
    const email = await getEmail();
    if (!email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    if (!body.id) return NextResponse.json({ error: "Conversation id is required." }, { status: 400 });

    await runWithUserContext(email, async (client) => {
      await ensureAiConversationsTable(client);
      await client.query("delete from public.ai_conversations where id = $1 and owner_email = $2", [body.id, email]);
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    if (isDatabaseUnavailableError(error)) {
      if (!body.id) {
        return NextResponse.json({ error: "Conversation id is required." }, { status: 400 });
      }

      const email = await getEmail();
      if (!email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

      await deleteConversationViaSupabase(email, body.id);
      return NextResponse.json({ ok: true });
    }

    return errorResponse(error);
  }
}
