import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { runWithUserContext } from "@/lib/server/db";
import { mapNotificationRow, mapSettingsRow, mapTaskRow } from "@/lib/server/mappers";
import { ensureTaskNotesTable, selectTaskNotesPayload } from "@/lib/server/taskNotesDb";
import { fetchConversationsViaSupabase, fetchNotificationsViaSupabase, fetchTasksViaSupabase } from "@/lib/server/supabaseData";
import { fetchSettingsViaRest } from "@/lib/server/supabaseSettings";
import { fetchTaskNotesViaRest } from "@/lib/server/supabaseTaskNotes";

const getEmail = async () => (await cookies()).get("activity_user_email")?.value?.trim().toLowerCase() ?? "";

export async function GET() {
  const email = await getEmail();
  if (!email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const payload = await runWithUserContext(email, async (client) => {
      const displayName = email.split("@")[0]?.replace(/\./g, " ") || "User";

      await client.query(
        `insert into public.app_settings (
          owner_email,
          display_name,
          email,
          avatar,
          theme_mode,
          sidebar_collapsed,
          accent,
          overdue_alerts,
          ai_reminders,
          weekly_summary,
          two_factor_enabled
        ) values ($1, $2, $3, null, 'dark', false, 'violet', true, true, false, false)
        on conflict (owner_email) do nothing`,
        [email, displayName, email],
      );

      await ensureTaskNotesTable(client);

      const [tasks, notifications, settings, taskNotesPayload] = await Promise.all([
        client.query("select * from public.tasks where owner_email = $1 order by created_at desc", [email]),
        client.query("select * from public.notifications where owner_email = $1 order by timestamp desc", [email]),
        client.query("select * from public.app_settings where owner_email = $1 limit 1", [email]),
        selectTaskNotesPayload(client, email),
      ]);

      return {
        tasks: tasks.rows.map(mapTaskRow),
        notifications: notifications.rows.map(mapNotificationRow),
        settings: settings.rows[0] ? mapSettingsRow(settings.rows[0]) : null,
        notesByTaskId: taskNotesPayload.notesByTaskId,
        attachmentsByTaskId: taskNotesPayload.attachmentsByTaskId,
      };
    });

    return NextResponse.json(payload);
  } catch {
    const [tasks, notifications, settings, conversations, taskNotes] = await Promise.all([
      fetchTasksViaSupabase(email),
      fetchNotificationsViaSupabase(email),
      fetchSettingsViaRest(email),
      fetchConversationsViaSupabase(email),
      fetchTaskNotesViaRest(email).catch(() => ({ notesByTaskId: {}, attachmentsByTaskId: {} })),
    ]);

    return NextResponse.json({
      tasks,
      notifications,
      settings,
      conversations,
      notesByTaskId: taskNotes.notesByTaskId,
      attachmentsByTaskId: taskNotes.attachmentsByTaskId,
    });
  }
}
