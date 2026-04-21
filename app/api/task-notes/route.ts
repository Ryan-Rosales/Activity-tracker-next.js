import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { runWithUserContext } from "@/lib/server/db";
import { ensureTaskNotesTable, selectTaskNotesPayload, stripLegacyAttachmentsFromNote } from "@/lib/server/taskNotesDb";
import { TASK_NOTES_BUCKET, getSupabaseStorageClient } from "@/lib/server/supabaseStorage";
import { deleteTaskNotesViaRest, fetchTaskNotesViaRest, upsertTaskNotesViaRest } from "@/lib/server/supabaseTaskNotes";
import type { TaskNoteAttachment } from "@/lib/types/taskNotes";

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

export async function GET() {
  const email = await getEmail();
  if (!email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const payload = await runWithUserContext(email, async (client) => {
      await ensureTaskNotesTable(client);
      return selectTaskNotesPayload(client, email);
    });

    return NextResponse.json(payload);
  } catch (error) {
    if (isDatabaseUnavailableError(error)) {
      const payload = await fetchTaskNotesViaRest(email);
      return NextResponse.json(payload);
    }

    const message = error instanceof Error ? error.message : "Task notes load failed.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const email = await getEmail();
  if (!email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json();
  if (!body.taskId) return NextResponse.json({ error: "taskId is required." }, { status: 400 });

  const attachments = Array.isArray(body.attachments)
    ? body.attachments
        .filter((item: unknown) => item && typeof item === "object")
        .map((item: Record<string, unknown>) => ({
          id: typeof item.id === "string" ? item.id : "",
          name: typeof item.name === "string" ? item.name : "",
          type: typeof item.type === "string" ? item.type : "application/octet-stream",
          size: typeof item.size === "number" ? item.size : 0,
          uploadedAt: typeof item.uploadedAt === "string" ? item.uploadedAt : new Date().toISOString(),
          storagePath: typeof item.storagePath === "string" ? item.storagePath : "",
        }))
        .filter((item: TaskNoteAttachment) => !!item.id && !!item.name && !!item.storagePath && item.size >= 0)
    : [];

  const cleanNote = stripLegacyAttachmentsFromNote(typeof body.note === "string" ? body.note : "");

  try {
    await runWithUserContext(email, async (client) => {
      await ensureTaskNotesTable(client);
      await client.query(
        `insert into public.task_notes (owner_email, task_id, note, attachments)
         values ($1, $2, $3, $4::jsonb)
         on conflict (owner_email, task_id)
         do update set note = excluded.note, attachments = excluded.attachments, updated_at = now()`,
        [email, body.taskId, cleanNote, JSON.stringify(attachments)],
      );
    });

    return NextResponse.json({ ok: true, storage: "postgres" });
  } catch (error) {
    try {
      await upsertTaskNotesViaRest({
        email,
        taskId: body.taskId,
        note: cleanNote,
        attachments,
      });

      return NextResponse.json({ ok: true, storage: "supabase" });
    } catch (restError) {
      const message = restError instanceof Error ? restError.message : error instanceof Error ? error.message : "Task notes save failed.";
      return NextResponse.json({ error: message }, { status: 500 });
    }
  }
}

export async function DELETE(request: Request) {
  const email = await getEmail();
  if (!email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json();
  if (!body.taskId) return NextResponse.json({ error: "taskId is required." }, { status: 400 });

  const storagePaths = await runWithUserContext(email, async (client) => {
    await ensureTaskNotesTable(client);
    const row = await client.query(
      `select attachments from public.task_notes where owner_email = $1 and task_id = $2 limit 1`,
      [email, body.taskId],
    );

    const attachments = Array.isArray(row.rows[0]?.attachments) ? row.rows[0].attachments : [];
    return attachments
      .map((item: { storagePath?: unknown }) => (typeof item.storagePath === "string" ? item.storagePath : ""))
      .filter((path: string) => !!path);
  }).catch(async () => {
    const payload = await fetchTaskNotesViaRest(email);
    return (payload.attachmentsByTaskId[body.taskId] ?? [])
      .map((item) => item.storagePath)
      .filter((path) => !!path);
  });

  if (storagePaths.length) {
    const storageClient = getSupabaseStorageClient();
    const { error } = await storageClient.storage.from(TASK_NOTES_BUCKET).remove(storagePaths);
    if (error) {
      console.warn("Task note attachment cleanup failed:", error.message);
    }
  }

  try {
    await runWithUserContext(email, async (client) => {
      await ensureTaskNotesTable(client);
      await client.query(
        `delete from public.task_notes where owner_email = $1 and task_id = $2`,
        [email, body.taskId],
      );
    });

    return NextResponse.json({ ok: true });
  } catch {
    await deleteTaskNotesViaRest(email, body.taskId);
    return NextResponse.json({ ok: true });
  }
}
