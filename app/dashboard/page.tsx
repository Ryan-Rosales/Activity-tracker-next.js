"use client";

import { useMemo, useState } from "react";
import { Archive, CheckCircle2, Clock3, PlayCircle } from "lucide-react";
import { motion } from "framer-motion";
import { StatCard } from "@/components/dashboard/StatCard";
import { TaskFlowDiagram } from "@/components/dashboard/TaskFlowDiagram";
import { RecentTasks } from "@/components/dashboard/RecentTasks";
import { QuickActions } from "@/components/dashboard/QuickActions";
import { TaskModal } from "@/components/tasks/TaskModal";
import { useTaskStore } from "@/lib/store/useTaskStore";
import { useNotificationStore } from "@/lib/store/useNotificationStore";
import { useThemeStore } from "@/lib/store/useThemeStore";

export default function DashboardPage() {
  const tasks = useTaskStore((state) => state.tasks);
  const addTask = useTaskStore((state) => state.addTask);
  const notifications = useNotificationStore((state) => state.notifications);
  const dismissNotification = useNotificationStore((state) => state.dismissNotification);
  const unreadCount = useNotificationStore((state) => state.unreadCount);
  const mode = useThemeStore((state) => state.mode);
  const isLight = mode === "light";

  const [open, setOpen] = useState(false);

  const stats = useMemo(() => {
    const pending = tasks.filter((task) => task.status === "pending").length;
    const ongoing = tasks.filter((task) => task.status === "ongoing").length;
    const completed = tasks.filter((task) => task.status === "completed").length;
    const archived = tasks.filter((task) => task.status === "archived").length;
    return { pending, ongoing, completed, archived };
  }, [tasks]);

  return (
    <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3 }} className="space-y-4">
      <section className="rounded-3xl border border-white/15 bg-white/10 p-5 backdrop-blur-xl">
        <p className="text-xs uppercase tracking-[0.35em] text-violet-300">Command Center</p>
        <h2 className="font-display mt-2 text-3xl font-semibold text-white md:text-4xl">
          Track work with clarity, momentum, and AI-assisted precision.
        </h2>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-300">
          A high-signal dashboard for task flow, team focus, and predictive prompts that keep the work moving.
        </p>
      </section>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard icon={Clock3} label="Pending" count={stats.pending} route="/tasks/pending" gradient="from-amber-500 to-orange-500" />
        <StatCard icon={PlayCircle} label="Ongoing" count={stats.ongoing} route="/tasks/ongoing" gradient="from-blue-500 to-cyan-500" />
        <StatCard icon={CheckCircle2} label="Completed" count={stats.completed} route="/tasks/completed" gradient="from-emerald-500 to-green-500" />
        <StatCard icon={Archive} label="Archived" count={stats.archived} route="/archive" gradient="from-violet-500 to-purple-500" />
      </div>

      <TaskFlowDiagram />

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <RecentTasks tasks={tasks} />
        <QuickActions onAddTask={() => setOpen(true)} notificationCount={unreadCount} />
      </div>

      <div className={`rounded-2xl border p-4 backdrop-blur-xl ${isLight ? "border-slate-200 bg-white shadow-[0_10px_30px_rgba(15,23,42,0.08)]" : "border-white/20 bg-white/10"}`}>
        <h3 className={`mb-2 text-sm font-semibold ${isLight ? "text-slate-900" : "text-slate-200"}`}>Notifications Preview</h3>
        <div className="space-y-2">
          {notifications
            .filter((item) => !item.read)
            .slice(0, 2)
            .map((item) => (
              <div
                key={item.id}
                className={`flex items-center justify-between rounded-xl border p-2 text-sm ${
                  isLight ? "border-slate-200 bg-slate-50 text-slate-900" : "border-white/10 bg-black/10 text-slate-200"
                }`}
              >
                <p>{item.message}</p>
                <button
                  type="button"
                  onClick={() => dismissNotification(item.id)}
                  className={`rounded px-2 py-1 text-xs font-medium ${
                    isLight ? "border border-red-200 bg-red-50 text-red-700 hover:bg-red-100" : "bg-red-500/20 text-red-200"
                  }`}
                >
                  Dismiss
                </button>
              </div>
            ))}
        </div>
      </div>

      {open ? (
        <TaskModal
          onClose={() => setOpen(false)}
          onSave={async (draft) => {
            await addTask(draft);
          }}
        />
      ) : null}
    </motion.div>
  );
}
