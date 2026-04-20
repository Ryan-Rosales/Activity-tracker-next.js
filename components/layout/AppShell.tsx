"use client";

import { useEffect, useState, useRef } from "react";
import { usePathname } from "next/navigation";
import { FloatingAIChat } from "@/components/ai/FloatingAIChat";
import { ToastCenter } from "@/components/notifications/ToastCenter";
import { Sidebar } from "@/components/layout/Sidebar";
import { Topbar } from "@/components/layout/Topbar";
import { AuthGuard } from "@/components/layout/AuthGuard";
import { useThemeStore } from "@/lib/store/useThemeStore";
import { useTaskStore } from "@/lib/store/useTaskStore";
import { useTaskNotesStore } from "@/lib/store/useTaskNotesStore";
import { useNotificationStore } from "@/lib/store/useNotificationStore";
import { useSettingsStore } from "@/lib/store/useSettingsStore";
import { useAuthStore } from "@/lib/store/useAuthStore";
import type { Task } from "@/lib/types";
import type { TaskNoteAttachment } from "@/lib/types/taskNotes";

const serializeTaskForApi = (task: Task) => ({
  id: task.id,
  title: task.title,
  description: task.description,
  status: task.status,
  priority: task.priority,
  category: task.category,
  dueDate: task.dueDate instanceof Date ? task.dueDate.toISOString() : task.dueDate,
  completedAt: task.completedAt instanceof Date ? task.completedAt.toISOString() : task.completedAt,
  archivedAt: task.archivedAt instanceof Date ? task.archivedAt.toISOString() : task.archivedAt,
  createdAt: task.createdAt instanceof Date ? task.createdAt.toISOString() : task.createdAt,
  updatedAt: task.updatedAt instanceof Date ? task.updatedAt.toISOString() : task.updatedAt,
  subtasks: task.subtasks,
});

const serializeAttachmentForApi = (attachment: TaskNoteAttachment) => ({
  id: attachment.id,
  name: attachment.name,
  type: attachment.type,
  size: attachment.size,
  uploadedAt: attachment.uploadedAt,
  storagePath: attachment.storagePath,
});

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const mode = useThemeStore((state) => state.mode);
  const collapsed = useThemeStore((state) => state.sidebarCollapsed);
  const setSidebarCollapsed = useThemeStore((state) => state.setSidebarCollapsed);
  const tasks = useTaskStore((state) => state.tasks);
  const setTasks = useTaskStore((state) => state.setTasks);
  const setNotesByTaskId = useTaskNotesStore((state) => state.setNotesByTaskId);
  const setAttachmentsByTaskId = useTaskNotesStore((state) => state.setAttachmentsByTaskId);
  const syncTaskNotifications = useNotificationStore((state) => state.syncTaskNotifications);
  const setNotifications = useNotificationStore((state) => state.setNotifications);
  const setNotificationSettings = useNotificationStore((state) => state.setSettings);
  const hydrateSettings = useSettingsStore((state) => state.hydrate);
  const user = useAuthStore((state) => state.user);
  const hydrateSession = useAuthStore((state) => state.hydrateSession);
  const [mobileOpen, setMobileOpen] = useState(false);
  const hydratedEmail = useRef<string | null>(null);
  const migratedEmail = useRef<string | null>(null);

  useEffect(() => {
    if (pathname === "/login") return;
    void hydrateSession();
  }, [hydrateSession, pathname]);

  useEffect(() => {
    syncTaskNotifications(tasks);
  }, [syncTaskNotifications, tasks]);

  useEffect(() => {
    const email = user?.email;
    if (!email || hydratedEmail.current === email) return;

    hydratedEmail.current = email;

    const localTasks = useTaskStore.getState().tasks;
    const localNotesByTaskId = useTaskNotesStore.getState().notesByTaskId;
    const localAttachmentsByTaskId = useTaskNotesStore.getState().attachmentsByTaskId;

    void (async () => {
      try {
        const response = await fetch("/api/bootstrap");
        const data = (await response.json()) as {
          tasks?: Task[];
          notesByTaskId?: Record<string, string>;
          attachmentsByTaskId?: Record<string, TaskNoteAttachment[]>;
          notifications?: Parameters<typeof setNotifications>[0];
          settings?: {
            overdueAlerts: boolean;
            aiReminders: boolean;
            weeklySummary: boolean;
            accent: "violet" | "teal" | "sunset" | "emerald" | "rose";
            themeMode: "system" | "light" | "dark";
            sidebarCollapsed: boolean;
            twoFactorEnabled: boolean;
            displayName?: string;
            email?: string;
            avatar?: string | null;
          };
        };

        if (!response.ok) return;

        const hasServerTasks = Array.isArray(data.tasks) && data.tasks.length > 0;
        if (!hasServerTasks && localTasks.length && migratedEmail.current !== email) {
          for (const task of localTasks) {
            await fetch("/api/tasks", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(serializeTaskForApi(task)),
            });
          }

          for (const [taskId, note] of Object.entries(localNotesByTaskId)) {
            const attachments = localAttachmentsByTaskId[taskId] ?? [];
            await fetch("/api/task-notes", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                taskId,
                note,
                attachments: attachments.map(serializeAttachmentForApi),
              }),
            });
          }

          migratedEmail.current = email;

          const refreshed = await fetch("/api/bootstrap");
          if (refreshed.ok) {
            data.tasks = (await refreshed.json())?.tasks ?? data.tasks;
          }
        }

        if (data.tasks) setTasks(data.tasks);
        if (data.notesByTaskId) setNotesByTaskId(data.notesByTaskId);
        if (data.attachmentsByTaskId) setAttachmentsByTaskId(data.attachmentsByTaskId);
        if (data.notifications) setNotifications(data.notifications);
        if (data.settings) {
          const settings = data.settings;
          setNotificationSettings({
            overdueAlerts: settings.overdueAlerts,
            aiReminders: settings.aiReminders,
            weeklySummary: settings.weeklySummary,
          });
          hydrateSettings({
            accent: settings.accent,
            themeMode: settings.themeMode,
            sidebarCollapsed: settings.sidebarCollapsed,
            overdueAlerts: settings.overdueAlerts,
            aiReminders: settings.aiReminders,
            weeklySummary: settings.weeklySummary,
            twoFactorEnabled: settings.twoFactorEnabled,
            displayName: settings.displayName,
            email: settings.email,
            avatar: settings.avatar ?? undefined,
          });
          useAuthStore.setState((state) => ({
            ...state,
            user: state.user
              ? {
                  ...state.user,
                  name: settings.displayName ?? state.user.name,
                  email: settings.email ?? state.user.email,
                  avatar: settings.avatar ?? state.user.avatar,
                }
              : state.user,
          }));
        }
      } catch {
        // Fall back to local cache if the database is unavailable.
      }
    })();
  }, [hydrateSettings, setAttachmentsByTaskId, setNotesByTaskId, setNotifications, setNotificationSettings, setTasks, user?.email]);

  if (pathname === "/login") {
    return (
      <>
        {children}
        <ToastCenter />
      </>
    );
  }

  const showToastCenter = pathname !== "/notifications";

  return (
    <AuthGuard>
      <div className="min-h-screen bg-transparent text-white">
        <div className="fixed inset-0 -z-10 bg-[radial-gradient(circle_at_top_left,rgba(108,99,255,0.15),transparent_32%),radial-gradient(circle_at_top_right,rgba(59,130,246,0.12),transparent_28%),radial-gradient(circle_at_bottom,rgba(16,185,129,0.08),transparent_30%)]" />

        <div className="hidden md:block">
          <Sidebar />
        </div>

        <button
          type="button"
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          onClick={() => setSidebarCollapsed(!collapsed)}
          className={`fixed z-50 hidden h-8 w-8 items-center justify-center rounded-full border transition-all duration-300 md:flex ${
            mode === "light"
              ? "border-slate-300 bg-white text-slate-700 shadow-[0_6px_18px_rgba(15,23,42,0.18)] hover:border-slate-400 hover:bg-slate-50"
              : "border-slate-500/45 bg-[#020617] text-slate-100 shadow-[0_6px_18px_rgba(0,0,0,0.45)] hover:border-slate-300/70 hover:bg-[#0b1220]"
          }`}
          style={{ top: "50%", left: collapsed ? 64 : 256, transform: "translate(-50%, -50%)" }}
        >
          <span className="text-[12px] font-semibold leading-none tracking-[-0.03em]">{collapsed ? ">" : "<"}</span>
        </button>

        {mobileOpen ? (
          <button
            type="button"
            aria-label="Close navigation drawer"
            onClick={() => setMobileOpen(false)}
            className="fixed inset-0 z-40 bg-black/55 backdrop-blur-sm md:hidden"
          />
        ) : null}

        <div
          className="fixed inset-y-0 left-0 z-50 md:hidden"
          style={{ transform: mobileOpen ? "translateX(0)" : "translateX(-100%)", transition: "transform 220ms ease" }}
        >
          <Sidebar mobile onNavigate={() => setMobileOpen(false)} onClose={() => setMobileOpen(false)} />
        </div>

        <div className={collapsed ? "transition-[margin-left] duration-300 md:ml-16" : "transition-[margin-left] duration-300 md:ml-64"}>
          <Topbar onMenuClick={() => setMobileOpen(true)} />
          <main className="p-4 md:p-6 xl:p-8">{children}</main>
        </div>

        <FloatingAIChat />
        {showToastCenter ? <ToastCenter /> : null}
      </div>
    </AuthGuard>
  );
}
