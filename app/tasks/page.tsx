"use client";

import { useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import { KanbanBoard } from "@/components/tasks/KanbanBoard";
import { SearchBar } from "@/components/tasks/SearchBar";
import { TaskModal } from "@/components/tasks/TaskModal";
import { TaskNotesModal } from "@/components/tasks/TaskNotesModal";
import { TaskConfirmationAction } from "@/components/tasks/TaskCard";
import { ConfirmationModal } from "@/components/ui/ConfirmationModal";
import { GradientButton } from "@/components/ui/GradientButton";
import { Task } from "@/lib/types";
import { useNotificationStore } from "@/lib/store/useNotificationStore";
import { useTaskStore } from "@/lib/store/useTaskStore";
import { useTaskNotesStore } from "@/lib/store/useTaskNotesStore";

export default function TasksPage() {
  const tasks = useTaskStore((state) => state.tasks);
  const addTask = useTaskStore((state) => state.addTask);
  const updateTask = useTaskStore((state) => state.updateTask);
  const deleteTask = useTaskStore((state) => state.deleteTask);
  const moveTask = useTaskStore((state) => state.moveTask);
  const archiveTask = useTaskStore((state) => state.archiveTask);
  const notesByTaskId = useTaskNotesStore((state) => state.notesByTaskId);
  const attachmentsByTaskId = useTaskNotesStore((state) => state.attachmentsByTaskId);
  const setTaskNote = useTaskNotesStore((state) => state.setTaskNote);
  const setTaskAttachments = useTaskNotesStore((state) => state.setTaskAttachments);
  const removeTaskNote = useTaskNotesStore((state) => state.removeTaskNote);
  const pushNotification = useNotificationStore((state) => state.pushNotification);

  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "pending" | "ongoing" | "completed">("all");
  const [priorityFilter, setPriorityFilter] = useState<"all" | "low" | "medium" | "high">("all");
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Task | null>(null);
  const [notesTask, setNotesTask] = useState<Task | null>(null);
  const [confirmAction, setConfirmAction] = useState<TaskConfirmationAction | null>(null);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  const confirmLabel =
    confirmAction?.type === "move"
      ? `move \"${confirmAction.taskTitle}\" to ${confirmAction.to}`
      : confirmAction?.type === "delete"
        ? `delete \"${confirmAction.taskTitle}\"`
        : confirmAction?.type === "archive"
          ? `archive \"${confirmAction.taskTitle}\"`
          : "";

  const submitConfirmation = () => {
    if (!confirmAction) return;

    if (confirmAction.type === "move") {
      moveTask(confirmAction.taskId, confirmAction.to);
    }

    if (confirmAction.type === "delete") {
      deleteTask(confirmAction.taskId);
      removeTaskNote(confirmAction.taskId);
      void fetch("/api/task-notes", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ taskId: confirmAction.taskId }),
      });
      if (notesTask?.id === confirmAction.taskId) {
        setNotesTask(null);
      }
    }

    if (confirmAction.type === "archive") {
      archiveTask(confirmAction.taskId);
    }

    setConfirmAction(null);
  };

  const priorityOptions: Array<"low" | "medium" | "high"> = ["low", "medium", "high"];

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return tasks.filter((task) => {
      if (task.status === "archived") return false;
      if (statusFilter !== "all" && task.status !== statusFilter) return false;
      if (priorityFilter !== "all" && task.priority !== priorityFilter) return false;
      if (!query) return true;

      const taskNotes = notesByTaskId[task.id] ?? "";
      const attachmentNames = (attachmentsByTaskId[task.id] ?? []).map((attachment) => attachment.name).join(" ");
      const haystack = [task.title, task.description ?? "", task.category ?? "", taskNotes, attachmentNames].join(" ").toLowerCase();

      if (!haystack.includes(query)) {
        return false;
      }
      return true;
    });
  }, [tasks, statusFilter, priorityFilter, search, notesByTaskId, attachmentsByTaskId]);

  return (
    <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3 }} className="space-y-4">
      <section className="rounded-3xl border border-white/15 bg-white/10 p-5 backdrop-blur-xl">
        <p className="text-xs uppercase tracking-[0.35em] text-blue-300">Task Studio</p>
        <h2 className="font-display mt-2 text-2xl font-semibold text-white md:text-3xl">
          Plan clearly, track progress, and complete tasks with confidence.
        </h2>
      </section>

      <SearchBar
        onSearch={setSearch}
        onStatusFilter={setStatusFilter}
        onPriorityFilter={setPriorityFilter}
        priorityOptions={priorityOptions}
      />
      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => {
            setEditing(null);
            setOpen(true);
          }}
          className="rounded-xl bg-gradient-to-r from-violet-600 via-indigo-600 to-blue-500 px-4 py-2 text-sm font-semibold text-white"
        >
          Add Task
        </button>
      </div>

      <KanbanBoard
        tasks={filtered}
        statusFilter={statusFilter}
        onEdit={(task) => {
          setEditing(task);
          setOpen(true);
        }}
        onOpenNotes={(task) => {
          setNotesTask(task);
        }}
        onRequestConfirmation={setConfirmAction}
      />

      {open ? (
        <TaskModal
          task={editing}
          onClose={() => setOpen(false)}
          onSave={async (draft) => {
            if (editing) {
              updateTask(editing.id, draft);
              return;
            }
            await addTask(draft);
          }}
        />
      ) : null}

      {notesTask ? (
        <TaskNotesModal
          task={notesTask}
          note={notesByTaskId[notesTask.id] ?? ""}
          attachments={attachmentsByTaskId[notesTask.id] ?? []}
          onClose={() => setNotesTask(null)}
          onSave={async ({ note, attachments }) => {
            setTaskNote(notesTask.id, note);
            setTaskAttachments(notesTask.id, attachments);
            const response = await fetch("/api/task-notes", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ taskId: notesTask.id, note, attachments }),
            });

            const data = (await response.json().catch(() => null)) as { storage?: "postgres" | "supabase" | "memory" } | null;
            if (!response.ok) {
              throw new Error("Could not save task notes.");
            }

            pushNotification({
              type: "update",
              message: `Notes saved: ${notesTask.title}`,
              taskId: notesTask.id,
              taskTitle: notesTask.title,
            });

            return { storage: data?.storage ?? "postgres" };
          }}
        />
      ) : null}

      <ConfirmationModal
        open={mounted && !!confirmAction}
        title="Confirm Action"
        message={`Are you sure you want to ${confirmLabel}?`}
        confirmLabel="Confirm"
        confirmVariant={confirmAction?.type === "delete" ? "danger" : "primary"}
        onCancel={() => setConfirmAction(null)}
        onConfirm={submitConfirmation}
      />
    </motion.div>
  );
}
