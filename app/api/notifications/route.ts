import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { runWithUserContext } from "@/lib/server/db";
import { mapNotificationRow } from "@/lib/server/mappers";
import { fetchNotificationsViaSupabase } from "@/lib/server/supabaseData";

const getEmail = async () => (await cookies()).get("activity_user_email")?.value?.trim().toLowerCase() ?? "";

export async function GET() {
  const email = await getEmail();
  if (!email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const notifications = await runWithUserContext(email, async (client) => {
      const result = await client.query(
        "select * from public.notifications where owner_email = $1 order by timestamp desc",
        [email],
      );
      return result.rows.map(mapNotificationRow);
    });

    return NextResponse.json({ notifications });
  } catch {
    const notifications = await fetchNotificationsViaSupabase(email);
    return NextResponse.json({ notifications });
  }
}

export async function PATCH(request: Request) {
  const email = await getEmail();
  if (!email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json();
  try {
    await runWithUserContext(email, async (client) => {
      if (body.action === "markAllAsRead") {
        await client.query("update public.notifications set read = true where owner_email = $1", [email]);
        return;
      }

      if (body.action === "markAsRead") {
        await client.query("update public.notifications set read = true where id = $1 and owner_email = $2", [body.id, email]);
        return;
      }

      if (body.action === "dismiss") {
        await client.query("delete from public.notifications where id = $1 and owner_email = $2", [body.id, email]);
        return;
      }

      if (body.action === "clearAll") {
        await client.query("delete from public.notifications where owner_email = $1", [email]);
      }
    });
  } catch {
    const client = await import("@/lib/server/supabaseData");
    const supabase = client.getSupabaseDataClient();

    if (body.action === "markAllAsRead") {
      const { error } = await supabase.from("notifications").update({ read: true }).eq("owner_email", email);
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    }

    if (body.action === "markAsRead") {
      const { error } = await supabase.from("notifications").update({ read: true }).eq("id", body.id).eq("owner_email", email);
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    }

    if (body.action === "dismiss") {
      const { error } = await supabase.from("notifications").delete().eq("id", body.id).eq("owner_email", email);
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    }

    if (body.action === "clearAll") {
      const { error } = await supabase.from("notifications").delete().eq("owner_email", email);
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    }
  }

  return NextResponse.json({ ok: true });
}
