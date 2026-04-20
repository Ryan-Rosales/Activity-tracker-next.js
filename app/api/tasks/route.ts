import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { runWithUserContext } from "@/lib/server/db";
import { mapTaskRow } from "@/lib/server/mappers";
import { deleteTaskViaSupabase, fetchTasksViaSupabase, upsertTaskViaSupabase } from "@/lib/server/supabaseData";

const getEmail = async () => (await cookies()).get("activity_user_email")?.value?.trim().toLowerCase() ?? "";

const toDateValue = (value: unknown) => {
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
};

export async function GET() {
  const email = await getEmail();
  if (!email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const tasks = await runWithUserContext(email, async (client) => {
      const result = await client.query("select * from public.tasks where owner_email = $1 order by created_at desc", [email]);
      return result.rows.map(mapTaskRow);
    });

    return NextResponse.json({ tasks });
  } catch {
    const tasks = await fetchTasksViaSupabase(email);
    return NextResponse.json({ tasks });
  }
}

export async function POST(request: Request) {
  const email = await getEmail();
  if (!email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json();

  try {
    const task = await runWithUserContext(email, async (client) => {
      const result = await client.query(
        `insert into public.tasks (
          id,
          owner_email,
          title,
          description,
          status,
          priority,
          category,
          due_date,
          completed_at,
          archived_at,
          subtasks,
          created_at,
          updated_at
        ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) on conflict (id) do update set
          title = excluded.title,
          description = excluded.description,
          status = excluded.status,
          priority = excluded.priority,
          category = excluded.category,
          due_date = excluded.due_date,
          completed_at = excluded.completed_at,
          archived_at = excluded.archived_at,
          subtasks = excluded.subtasks,
          updated_at = excluded.updated_at
        returning *`,
        [
          body.id ?? crypto.randomUUID(),
          email,
          body.title,
          body.description ?? null,
          body.status ?? "pending",
          body.priority ?? "medium",
          body.category ?? null,
          toDateValue(body.dueDate),
          toDateValue(body.completedAt),
          toDateValue(body.archivedAt),
          JSON.stringify(body.subtasks ?? []),
          toDateValue(body.createdAt) ?? new Date().toISOString(),
          toDateValue(body.updatedAt) ?? new Date().toISOString(),
        ],
      );

      return mapTaskRow(result.rows[0]);
    });

    return NextResponse.json({ task });
  } catch {
    const task = await upsertTaskViaSupabase(email, {
      id: typeof body.id === "string" ? body.id : undefined,
      title: body.title,
      description: body.description ?? null,
      status: body.status,
      priority: body.priority,
      category: body.category ?? null,
      dueDate: toDateValue(body.dueDate),
      completedAt: toDateValue(body.completedAt),
      archivedAt: toDateValue(body.archivedAt),
      subtasks: body.subtasks ?? [],
      createdAt: toDateValue(body.createdAt),
      updatedAt: toDateValue(body.updatedAt),
    });

    return NextResponse.json({ task });
  }
}

export async function PATCH(request: Request) {
  const email = await getEmail();
  if (!email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json();

  try {
    const task = await runWithUserContext(email, async (client) => {
      const result = await client.query(
        `update public.tasks
         set title = coalesce($3, title),
             description = coalesce($4, description),
             status = coalesce($5, status),
             priority = coalesce($6, priority),
             category = coalesce($7, category),
             due_date = coalesce($8, due_date),
             completed_at = coalesce($9, completed_at),
             archived_at = coalesce($10, archived_at),
             subtasks = coalesce($11, subtasks),
             updated_at = now()
         where id = $1 and owner_email = $2
         returning *`,
        [
          body.id,
          email,
          body.updates?.title ?? null,
          body.updates?.description ?? null,
          body.updates?.status ?? null,
          body.updates?.priority ?? null,
          body.updates?.category ?? null,
          body.updates?.dueDate ?? null,
          body.updates?.completedAt ?? null,
          body.updates?.archivedAt ?? null,
          body.updates?.subtasks ? JSON.stringify(body.updates.subtasks) : null,
        ],
      );

      return result.rows[0] ? mapTaskRow(result.rows[0]) : null;
    });

    return NextResponse.json({ task });
  } catch {
    if (!body.id) return NextResponse.json({ error: "Task id is required." }, { status: 400 });

    const task = await upsertTaskViaSupabase(email, {
      id: body.id,
      title: body.updates?.title ?? "",
      description: body.updates?.description ?? null,
      status: body.updates?.status,
      priority: body.updates?.priority,
      category: body.updates?.category ?? null,
      dueDate: toDateValue(body.updates?.dueDate),
      completedAt: toDateValue(body.updates?.completedAt),
      archivedAt: toDateValue(body.updates?.archivedAt),
      subtasks: body.updates?.subtasks ?? [],
      updatedAt: new Date().toISOString(),
    });

    return NextResponse.json({ task });
  }
}

export async function DELETE(request: Request) {
  const email = await getEmail();
  if (!email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json();

  try {
    await runWithUserContext(email, async (client) => {
      await client.query("delete from public.tasks where id = $1 and owner_email = $2", [body.id, email]);
    });

    return NextResponse.json({ ok: true });
  } catch {
    await deleteTaskViaSupabase(email, body.id);
    return NextResponse.json({ ok: true });
  }
}
