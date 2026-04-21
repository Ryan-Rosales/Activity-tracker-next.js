import { hydrateAttachmentsWithPreviewUrls } from "@/lib/server/supabaseStorage";
import type { TaskNoteAttachment, TaskNotesPayload } from "@/lib/types/taskNotes";

type TaskNotesRow = {
  task_id: string;
  note: string;
  attachments: TaskNoteAttachment[] | string | null;
};

const getConfig = () => {
  const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceRoleKey) {
    throw new Error("Supabase task notes fallback is not configured.");
  }

  return { url, serviceRoleKey };
};

const headers = (serviceRoleKey: string) => ({
  "Content-Type": "application/json",
  apikey: serviceRoleKey,
  Authorization: `Bearer ${serviceRoleKey}`,
});

const normalizeAttachment = (entry: unknown): TaskNoteAttachment | null => {
  if (!entry || typeof entry !== "object") return null;
  const item = entry as Record<string, unknown>;

  const id = typeof item.id === "string" ? item.id.trim() : "";
  const name = typeof item.name === "string" ? item.name.trim() : "";
  const type = typeof item.type === "string" ? item.type.trim() : "application/octet-stream";
  const size = typeof item.size === "number" ? item.size : 0;
  const uploadedAt = typeof item.uploadedAt === "string" ? item.uploadedAt : new Date().toISOString();
  const storagePath = typeof item.storagePath === "string" ? item.storagePath.trim() : "";

  if (!id || !name || !storagePath || size < 0) return null;

  return { id, name, type, size, uploadedAt, storagePath };
};

const normalizeAttachments = (value: TaskNoteAttachment[] | string | null): TaskNoteAttachment[] => {
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeAttachment(entry)).filter((entry): entry is TaskNoteAttachment => !!entry);
  }

  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return Array.isArray(parsed)
        ? parsed.map((entry) => normalizeAttachment(entry)).filter((entry): entry is TaskNoteAttachment => !!entry)
        : [];
    } catch {
      return [];
    }
  }

  return [];
};

export async function fetchTaskNotesViaRest(email: string): Promise<TaskNotesPayload> {
  const { url, serviceRoleKey } = getConfig();
  const endpoint = `${url}/rest/v1/task_notes?owner_email=eq.${encodeURIComponent(email)}&select=task_id,note,attachments`;

  const response = await fetch(endpoint, {
    method: "GET",
    headers: headers(serviceRoleKey),
    cache: "no-store",
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Supabase task notes read failed (${response.status}): ${text || "Unknown error"}`);
  }

  const rows = (await response.json()) as TaskNotesRow[];
  const notesByTaskId: Record<string, string> = {};
  const hydratedPairs = await Promise.all(
    (Array.isArray(rows) ? rows : []).map(async (row) => {
      const cleanNote = typeof row.note === "string" ? row.note.trim() : "";
      notesByTaskId[row.task_id] = cleanNote;
      const attachments = normalizeAttachments(row.attachments);
      return [row.task_id, await hydrateAttachmentsWithPreviewUrls(attachments)] as const;
    }),
  );

  const attachmentsByTaskId = hydratedPairs.reduce<Record<string, TaskNoteAttachment[]>>((acc, [taskId, attachments]) => {
    acc[taskId] = attachments;
    return acc;
  }, {});

  return {
    notesByTaskId,
    attachmentsByTaskId,
  };
}

export async function upsertTaskNotesViaRest(input: {
  email: string;
  taskId: string;
  note: string;
  attachments: TaskNoteAttachment[];
}) {
  const { url, serviceRoleKey } = getConfig();
  const endpoint = `${url}/rest/v1/task_notes?on_conflict=owner_email,task_id&select=*`;

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      ...headers(serviceRoleKey),
      Prefer: "resolution=merge-duplicates,return=representation",
    },
    body: JSON.stringify([
      {
        owner_email: input.email,
        task_id: input.taskId,
        note: input.note,
        attachments: input.attachments,
      },
    ]),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Supabase task notes upsert failed (${response.status}): ${text || "Unknown error"}`);
  }

  return true;
}

export async function deleteTaskNotesViaRest(email: string, taskId: string) {
  const { url, serviceRoleKey } = getConfig();
  const endpoint = `${url}/rest/v1/task_notes?owner_email=eq.${encodeURIComponent(email)}&task_id=eq.${encodeURIComponent(taskId)}`;

  const response = await fetch(endpoint, {
    method: "DELETE",
    headers: headers(serviceRoleKey),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Supabase task notes delete failed (${response.status}): ${text || "Unknown error"}`);
  }

  return true;
}

export async function appendTaskNoteAttachmentViaRest(input: {
  email: string;
  taskId: string;
  attachment: TaskNoteAttachment;
}) {
  const { url, serviceRoleKey } = getConfig();
  const endpoint = `${url}/rest/v1/task_notes?on_conflict=owner_email,task_id&select=note,attachments`;

  const current = await fetchTaskNotesViaRest(input.email).catch(() => ({ notesByTaskId: {}, attachmentsByTaskId: {} } as TaskNotesPayload));
  const existingAttachments = current.attachmentsByTaskId[input.taskId] ?? [];
  const note = current.notesByTaskId[input.taskId] ?? "";

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      ...headers(serviceRoleKey),
      Prefer: "resolution=merge-duplicates,return=representation",
    },
    body: JSON.stringify([
      {
        owner_email: input.email,
        task_id: input.taskId,
        note,
        attachments: [...existingAttachments, { ...input.attachment, previewUrl: undefined }],
      },
    ]),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Supabase task attachment sync failed (${response.status}): ${text || "Unknown error"}`);
  }

  return true;
}

export async function removeTaskNoteAttachmentViaRest(input: {
  email: string;
  taskId: string;
  attachmentId: string;
}) {
  const existing = await fetchTaskNotesViaRest(input.email).catch(() => ({ notesByTaskId: {}, attachmentsByTaskId: {} } as TaskNotesPayload));
  const attachments = existing.attachmentsByTaskId[input.taskId] ?? [];
  const nextAttachments = attachments.filter((entry) => entry.id !== input.attachmentId);
  const note = existing.notesByTaskId[input.taskId] ?? "";

  await upsertTaskNotesViaRest({
    email: input.email,
    taskId: input.taskId,
    note,
    attachments: nextAttachments,
  });
}