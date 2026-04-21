import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { runWithUserContext } from "@/lib/server/db";
import { ensureTaskNotesTable } from "@/lib/server/taskNotesDb";
import {
  TASK_NOTES_BUCKET,
  buildAttachmentStoragePath,
  createSignedPreviewUrl,
  ensureTaskNotesBucket,
  getSupabaseStorageClient,
} from "@/lib/server/supabaseStorage";
import {
  appendTaskNoteAttachmentViaRest,
  removeTaskNoteAttachmentViaRest,
} from "@/lib/server/supabaseTaskNotes";
import type { TaskNoteAttachment } from "@/lib/types/taskNotes";

export const runtime = "nodejs";

const getEmail = async () => (await cookies()).get("activity_user_email")?.value?.trim().toLowerCase() ?? "";

const normalizeAttachment = (raw: unknown): TaskNoteAttachment | null => {
  if (!raw || typeof raw !== "object") return null;
  const item = raw as Record<string, unknown>;

  const id = typeof item.id === "string" ? item.id : "";
  const name = typeof item.name === "string" ? item.name : "";
  const type = typeof item.type === "string" ? item.type : "application/octet-stream";
  const size = typeof item.size === "number" ? item.size : 0;
  const uploadedAt = typeof item.uploadedAt === "string" ? item.uploadedAt : new Date().toISOString();
  const storagePath = typeof item.storagePath === "string" ? item.storagePath : "";

  if (!id || !name || !storagePath || size < 0) {
    return null;
  }

  return { id, name, type, size, uploadedAt, storagePath };
};

const extractIdAndNameFromStorageObject = (storageFileName: string) => {
  const dashIndex = storageFileName.indexOf("-");
  if (dashIndex <= 0 || dashIndex >= storageFileName.length - 1) {
    return { id: storageFileName, name: storageFileName };
  }

  return {
    id: storageFileName.slice(0, dashIndex),
    name: storageFileName.slice(dashIndex + 1),
  };
};

const syncAttachmentMetadataBestEffort = async (email: string, taskId: string, attachment: TaskNoteAttachment) => {
  try {
    await runWithUserContext(email, async (client) => {
      await ensureTaskNotesTable(client);

      const current = await client.query(
        `select note, attachments from public.task_notes where owner_email = $1 and task_id = $2 limit 1`,
        [email, taskId],
      );

      const existing: TaskNoteAttachment[] = Array.isArray(current.rows[0]?.attachments)
        ? current.rows[0].attachments
            .map((entry: unknown) => normalizeAttachment(entry))
            .filter((item: TaskNoteAttachment | null): item is TaskNoteAttachment => !!item)
        : [];

      const note = typeof current.rows[0]?.note === "string" ? current.rows[0].note : "";
      const next = [...existing, { ...attachment, previewUrl: undefined }];

      await client.query(
        `insert into public.task_notes (owner_email, task_id, note, attachments)
         values ($1, $2, $3, $4::jsonb)
         on conflict (owner_email, task_id)
         do update set note = excluded.note, attachments = excluded.attachments, updated_at = now()`,
        [email, taskId, note, JSON.stringify(next)],
      );
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : "unknown";
    console.warn("Skipping direct task_notes metadata sync after storage upload:", reason);

    try {
      await appendTaskNoteAttachmentViaRest({ email, taskId, attachment });
    } catch (restError) {
      const restReason = restError instanceof Error ? restError.message : "unknown";
      console.warn("Skipping Supabase task_notes metadata sync after storage upload:", restReason);
    }
  }
};

const removeAttachmentMetadataBestEffort = async (email: string, taskId: string, attachmentId: string) => {
  try {
    await runWithUserContext(email, async (client) => {
      await ensureTaskNotesTable(client);

      const current = await client.query(
        `select note, attachments from public.task_notes where owner_email = $1 and task_id = $2 limit 1`,
        [email, taskId],
      );

      const existing: TaskNoteAttachment[] = Array.isArray(current.rows[0]?.attachments)
        ? current.rows[0].attachments
            .map((entry: unknown) => normalizeAttachment(entry))
            .filter((item: TaskNoteAttachment | null): item is TaskNoteAttachment => !!item)
        : [];

      const note = typeof current.rows[0]?.note === "string" ? current.rows[0].note : "";
      const next = existing.filter((item) => item.id !== attachmentId);

      await client.query(
        `insert into public.task_notes (owner_email, task_id, note, attachments)
         values ($1, $2, $3, $4::jsonb)
         on conflict (owner_email, task_id)
         do update set note = excluded.note, attachments = excluded.attachments, updated_at = now()`,
        [email, taskId, note, JSON.stringify(next)],
      );
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : "unknown";
    console.warn("Skipping direct task_notes metadata removal after storage delete:", reason);

    try {
      await removeTaskNoteAttachmentViaRest({ email, taskId, attachmentId });
    } catch (restError) {
      const restReason = restError instanceof Error ? restError.message : "unknown";
      console.warn("Skipping Supabase task_notes metadata removal after storage delete:", restReason);
    }
  }
};

export async function GET(request: Request) {
  try {
    const email = await getEmail();
    if (!email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { searchParams } = new URL(request.url);
    const taskId = searchParams.get("taskId")?.trim() ?? "";
    if (!taskId) return NextResponse.json({ error: "taskId is required." }, { status: 400 });

    await ensureTaskNotesBucket();
    const storageClient = getSupabaseStorageClient();
    const prefix = `${email.replace(/[^a-zA-Z0-9@._-]/g, "_")}/${taskId.replace(/[^a-zA-Z0-9._-]/g, "_")}`;

    const { data: files, error } = await storageClient.storage.from(TASK_NOTES_BUCKET).list(prefix, {
      limit: 100,
      sortBy: { column: "created_at", order: "desc" },
    });

    if (error) {
      return NextResponse.json({ error: error.message || "Failed to list uploaded files." }, { status: 500 });
    }

    const attachments = await Promise.all(
      (files ?? [])
        .filter((file) => file && !!file.name)
        .map(async (file) => {
          const { id, name } = extractIdAndNameFromStorageObject(file.name);
          const storagePath = `${prefix}/${file.name}`;
          return {
            id,
            name,
            type: (file.metadata?.mimetype as string) || "application/octet-stream",
            size: typeof file.metadata?.size === "number" ? file.metadata.size : 0,
            uploadedAt: file.created_at || new Date().toISOString(),
            storagePath,
            previewUrl: await createSignedPreviewUrl(storagePath),
          } satisfies TaskNoteAttachment;
        }),
    );

    return NextResponse.json({ attachments });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Attachment listing failed.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const email = await getEmail();
    if (!email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const formData = await request.formData();
    const taskId = String(formData.get("taskId") ?? "").trim();
    const file = formData.get("file");

    if (!taskId) return NextResponse.json({ error: "taskId is required." }, { status: 400 });
    if (!(file instanceof File)) return NextResponse.json({ error: "file is required." }, { status: 400 });
    if (file.size > 8 * 1024 * 1024) {
      return NextResponse.json({ error: "File is too large. Maximum size is 8 MB." }, { status: 400 });
    }

    await ensureTaskNotesBucket();
    const storageClient = getSupabaseStorageClient();

    const attachmentId = crypto.randomUUID();
    const storagePath = buildAttachmentStoragePath(email, taskId, attachmentId, file.name);
    const uploadData = await file.arrayBuffer();

    const { error: uploadError } = await storageClient.storage.from(TASK_NOTES_BUCKET).upload(storagePath, uploadData, {
      contentType: file.type || "application/octet-stream",
      upsert: false,
    });

    if (uploadError) {
      return NextResponse.json({ error: uploadError.message || "Failed to upload file." }, { status: 500 });
    }

    const attachment: TaskNoteAttachment = {
      id: attachmentId,
      name: file.name,
      type: file.type || "application/octet-stream",
      size: file.size,
      uploadedAt: new Date().toISOString(),
      storagePath,
      previewUrl: await createSignedPreviewUrl(storagePath),
    };

    await syncAttachmentMetadataBestEffort(email, taskId, attachment);

    return NextResponse.json({ attachment });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Attachment upload failed.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  try {
    const email = await getEmail();
    if (!email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const body = await request.json();
    const taskId = typeof body.taskId === "string" ? body.taskId.trim() : "";
    const attachmentId = typeof body.attachmentId === "string" ? body.attachmentId.trim() : "";

    if (!taskId || !attachmentId) {
      return NextResponse.json({ error: "taskId and attachmentId are required." }, { status: 400 });
    }

    await ensureTaskNotesBucket();
    const storageClient = getSupabaseStorageClient();
    const safeEmail = email.replace(/[^a-zA-Z0-9@._-]/g, "_");
    const safeTaskId = taskId.replace(/[^a-zA-Z0-9._-]/g, "_");
    const prefix = `${safeEmail}/${safeTaskId}`;

    const { data: files, error: listError } = await storageClient.storage.from(TASK_NOTES_BUCKET).list(prefix, {
      limit: 100,
    });

    if (listError) {
      return NextResponse.json({ error: listError.message || "Failed to load files for deletion." }, { status: 500 });
    }

    const target = (files ?? []).find((file) => {
      const parsed = extractIdAndNameFromStorageObject(file.name || "");
      return parsed.id === attachmentId;
    });

    const storagePath = target?.name ? `${prefix}/${target.name}` : "";

    if (storagePath) {
      const { error } = await storageClient.storage.from(TASK_NOTES_BUCKET).remove([storagePath]);
      if (error) {
        console.warn("Failed to delete attachment from storage:", error.message);
      }
    }

    await removeAttachmentMetadataBestEffort(email, taskId, attachmentId);

    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Attachment deletion failed.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
