"use client";

import { useEffect, useState } from "react";
import { CalendarClock, TriangleAlert } from "lucide-react";
import { motion } from "framer-motion";
import { Task } from "@/lib/types";
import { GradientButton } from "@/components/ui/GradientButton";
import { getDueDateState } from "@/lib/utils/dateHelpers";
import { useThemeStore } from "@/lib/store/useThemeStore";

type Draft = {
  title: string;
  description: string;
  priority: Task["priority"];
  category: string;
  dueDate: string;
};

const defaultDraft: Draft = {
  title: "",
  description: "",
  priority: "medium",
  category: "",
  dueDate: "",
};

export function TaskModal({
  onClose,
  onSave,
  task,
}: {
  onClose: () => void;
  onSave: (draft: Omit<Task, "id" | "createdAt" | "updatedAt">) => Promise<void> | void;
  task?: Task | null;
}) {
  const [draft, setDraft] = useState<Draft>(defaultDraft);
  const [saving, setSaving] = useState(false);
  const mode = useThemeStore((state) => state.mode);
  const isLight = mode === "light";
  const dueState = getDueDateState(draft.dueDate ? new Date(draft.dueDate) : undefined);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, []);

  useEffect(() => {
    if (task) {
      setDraft({
        title: task.title,
        description: task.description ?? "",
        priority: task.priority,
        category: task.category ?? "",
        dueDate: task.dueDate ? new Date(task.dueDate).toISOString().slice(0, 10) : "",
      });
    } else {
      setDraft(defaultDraft);
    }
  }, [task]);

  return (
    <div className="fixed inset-0 z-[260] grid place-items-center bg-black/60 p-4">
      <motion.div
        initial={{ opacity: 0, scale: 0.92 }}
        animate={{ opacity: 1, scale: 1 }}
        className={`task-modal w-full max-w-xl rounded-2xl border p-5 backdrop-blur-3xl ${
          isLight
            ? "border-slate-200 bg-slate-50/98 shadow-[0_22px_64px_rgba(15,23,42,0.16)]"
            : "border-white/20 bg-slate-950/85"
        }`}
      >
        <h3 className={`mb-4 text-lg font-semibold ${isLight ? "text-slate-900" : "text-white"}`}>{task ? "Edit Task" : "Add New Task"}</h3>

        <div className="space-y-4">
          {/* Title Field */}
          <div>
            <label className={`mb-2 block text-xs font-semibold uppercase tracking-wide ${isLight ? "text-slate-600" : "text-slate-300"}`}>Title</label>
            <input
              value={draft.title}
              onChange={(event) => setDraft((state) => ({ ...state, title: event.target.value }))}
              placeholder="Enter task title"
              className={`w-full rounded-xl border px-3 py-2 text-sm outline-none focus:border-violet-400 ${
                isLight
                  ? "border-slate-300 bg-white text-slate-900 placeholder:text-slate-400"
                  : "border-white/20 bg-black/20 text-white"
              }`}
              required
            />
          </div>

          {/* Description Field */}
          <div>
            <label className={`mb-2 block text-xs font-semibold uppercase tracking-wide ${isLight ? "text-slate-600" : "text-slate-300"}`}>Description</label>
            <textarea
              value={draft.description}
              onChange={(event) => setDraft((state) => ({ ...state, description: event.target.value }))}
              placeholder="Add task details (optional)"
              className={`h-24 w-full rounded-xl border px-3 py-2 text-sm outline-none focus:border-violet-400 ${
                isLight
                  ? "border-slate-300 bg-white text-slate-900 placeholder:text-slate-400"
                  : "border-white/20 bg-black/20 text-white"
              }`}
            />
          </div>

          {/* Priority, Category, Date Group */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            {/* Priority Field */}
            <div>
              <label className={`mb-2 block text-xs font-semibold uppercase tracking-wide ${isLight ? "text-slate-600" : "text-slate-300"}`}>Priority</label>
              <select
                value={draft.priority}
                onChange={(event) =>
                  setDraft((state) => ({ ...state, priority: event.target.value as Task["priority"] }))
                }
                className={`w-full rounded-xl border px-3 py-2 text-sm ${isLight ? "border-slate-300 bg-white text-slate-900" : "border-white/20 bg-black/20 text-white"}`}
              >
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
              </select>
            </div>

            {/* Category Field */}
            <div>
              <label className={`mb-2 block text-xs font-semibold uppercase tracking-wide ${isLight ? "text-slate-600" : "text-slate-300"}`}>Category</label>
              <input
                value={draft.category}
                onChange={(event) => setDraft((state) => ({ ...state, category: event.target.value }))}
                placeholder="e.g., Work, Personal"
                className={`w-full rounded-xl border px-3 py-2 text-sm outline-none focus:border-violet-400 ${
                  isLight
                    ? "border-slate-300 bg-white text-slate-900 placeholder:text-slate-400"
                    : "border-white/20 bg-black/20 text-white"
                }`}
              />
            </div>

            {/* Date Field */}
            <div>
              <label className={`mb-2 block text-xs font-semibold uppercase tracking-wide ${isLight ? "text-slate-600" : "text-slate-300"}`}>Due Date</label>
              <input
                value={draft.dueDate}
                onChange={(event) => setDraft((state) => ({ ...state, dueDate: event.target.value }))}
                type="date"
                className={`w-full rounded-xl border px-3 py-2 text-sm outline-none ${
                  isLight ? "border-slate-300 bg-white text-slate-900" : "border-white/20 bg-black/20 text-white"
                }`}
              />
              <div
                className={`mt-2 inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium ${
                  isLight
                    ? dueState.status === "overdue"
                      ? "border-red-300 bg-red-50 text-red-700"
                      : dueState.status === "dueToday"
                        ? "border-amber-300 bg-amber-50 text-amber-700"
                        : dueState.status === "dueSoon"
                          ? "border-cyan-300 bg-cyan-50 text-cyan-700"
                          : "border-slate-200 bg-white text-slate-600"
                    : dueState.status === "overdue"
                      ? "border-amber-300/40 bg-amber-500/15 text-amber-100"
                      : dueState.status === "dueToday"
                        ? "border-amber-300/40 bg-amber-500/15 text-amber-100"
                        : dueState.status === "dueSoon"
                          ? "border-cyan-300/40 bg-cyan-500/15 text-cyan-100"
                          : "border-white/15 bg-white/5 text-slate-300"
                }`}
              >
                {dueState.status === "overdue" ? <TriangleAlert className="size-3.5" /> : <CalendarClock className="size-3.5" />}
                {dueState.label}
              </div>
            </div>
          </div>

        </div>

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className={`rounded-xl border px-4 py-2 text-sm ${isLight ? "border-slate-300 bg-white text-slate-700 hover:bg-slate-50" : "border-white/20 text-white"}`}
          >
            Cancel
          </button>
          <GradientButton
            type="button"
            disabled={saving}
            onClick={async () => {
              if (!draft.title.trim()) return;
              setSaving(true);
              try {
                await Promise.resolve(
                  onSave({
                    title: draft.title,
                    description: draft.description || undefined,
                    status: task?.status ?? "pending",
                    priority: draft.priority,
                    category: draft.category || undefined,
                    dueDate: draft.dueDate ? new Date(draft.dueDate) : undefined,
                  }),
                );
                onClose();
              } finally {
                setSaving(false);
              }
            }}
          >
            {saving ? "Saving..." : "Save Task"}
          </GradientButton>
        </div>
      </motion.div>
    </div>
  );
}
