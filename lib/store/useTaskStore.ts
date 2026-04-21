"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";
import { Task, TaskStatus } from "@/lib/types";
import { useNotificationStore } from "@/lib/store/useNotificationStore";

interface TaskStore {
  tasks: Task[];
  setTasks: (tasks: Task[]) => void;
  addTask: (task: Omit<Task, "id" | "createdAt" | "updatedAt">) => Promise<Task>;
  updateTask: (id: string, updates: Partial<Task>) => void;
  deleteTask: (id: string) => void;
  moveTask: (id: string, status: TaskStatus) => void;
  archiveTask: (id: string) => void;
  getTasksByStatus: (status: TaskStatus) => Task[];
}

const normalizeTask = (task: Task): Task => ({
  ...task,
  createdAt: new Date(task.createdAt),
  updatedAt: new Date(task.updatedAt),
  dueDate: task.dueDate ? new Date(task.dueDate) : undefined,
  completedAt: task.completedAt ? new Date(task.completedAt) : undefined,
});

const mergeTasks = (currentTasks: Task[], persistedTasks: Task[]) => {
  if (!currentTasks.length) return persistedTasks.map(normalizeTask);
  if (!persistedTasks.length) return currentTasks;

  const merged = new Map<string, Task>();

  for (const task of persistedTasks) {
    merged.set(task.id, normalizeTask(task));
  }

  for (const task of currentTasks) {
    const existing = merged.get(task.id);
    if (!existing) {
      merged.set(task.id, task);
      continue;
    }

    const existingUpdated = new Date(existing.updatedAt).getTime();
    const incomingUpdated = new Date(task.updatedAt).getTime();
    merged.set(task.id, incomingUpdated >= existingUpdated ? task : existing);
  }

  return Array.from(merged.values()).sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );
};

export const useTaskStore = create<TaskStore>()(
  persist(
    (set, get) => ({
      tasks: [],
      setTasks: (tasks) => set({ tasks }),
      addTask: async (task) => {
        const now = new Date();
        const createdTask = {
          ...task,
          id: crypto.randomUUID(),
          createdAt: now,
          updatedAt: now,
        };

        set((state) => ({
          tasks: [
            createdTask,
            ...state.tasks,
          ],
        }));

        useNotificationStore.getState().pushNotification({
          type: "update",
          message: `Task created: ${createdTask.title}`,
          taskId: createdTask.id,
          taskTitle: createdTask.title,
        });

        const response = await fetch("/api/tasks", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(createdTask),
        });

        if (!response.ok) {
          throw new Error("Failed to save task.");
        }

        return createdTask;
      },
      updateTask: (id, updates) => {
        const existing = get().tasks.find((task) => task.id === id);
        set((state) => ({
          tasks: state.tasks.map((task) =>
            task.id === id ? { ...task, ...updates, updatedAt: new Date() } : task,
          ),
        }));

        if (existing) {
          useNotificationStore.getState().pushNotification({
            type: "update",
            message: `Task updated: ${existing.title}`,
            taskId: id,
            taskTitle: existing.title,
          });
        }

        void fetch("/api/tasks", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id, updates }),
        });
      },
      deleteTask: (id) => {
        const existing = get().tasks.find((task) => task.id === id);
        set((state) => ({ tasks: state.tasks.filter((task) => task.id !== id) }));

        if (existing) {
          useNotificationStore.getState().pushNotification({
            type: "update",
            message: `Task deleted: ${existing.title}`,
            taskTitle: existing.title,
          });
        }

        void fetch("/api/tasks", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id }),
        });
      },
      moveTask: (id, status) => {
        const nextTask = get().tasks.find((task) => task.id === id);
        const updates: Partial<Task> = {
          status,
          completedAt: status === "completed" ? new Date() : nextTask?.completedAt,
          updatedAt: new Date(),
        };

        set((state) => ({
          tasks: state.tasks.map((task) =>
            task.id === id
              ? {
                  ...task,
                  ...updates,
                }
              : task,
          ),
        }));

        if (nextTask) {
          useNotificationStore.getState().pushNotification({
            type: status === "completed" ? "completion" : "update",
            message:
              status === "completed"
                ? `Task completed: ${nextTask.title}`
                : `Task moved to ${status}: ${nextTask.title}`,
            taskId: id,
            taskTitle: nextTask.title,
          });
        }

        void fetch("/api/tasks", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id, updates }),
        });
      },
      archiveTask: (id) => {
        const existing = get().tasks.find((task) => task.id === id);
        const updates: Partial<Task> = {
          status: "archived",
          archivedAt: new Date(),
          updatedAt: new Date(),
        };

        set((state) => ({
          tasks: state.tasks.map((task) =>
            task.id === id ? { ...task, ...updates } : task,
          ),
        }));

        if (existing) {
          useNotificationStore.getState().pushNotification({
            type: "update",
            message: `Task archived: ${existing.title}`,
            taskId: id,
            taskTitle: existing.title,
          });
        }

        void fetch("/api/tasks", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id, updates }),
        });
      },
      getTasksByStatus: (status) => get().tasks.filter((task) => task.status === status),
    }),
    {
      name: "task-store",
      merge: (persistedState, currentState) => {
        const state = persistedState as TaskStore | undefined;
        if (!state?.tasks?.length) return currentState;

        if (currentState.tasks.length && !state.tasks.length) {
          return currentState;
        }

        return {
          ...currentState,
          ...state,
          tasks: mergeTasks(currentState.tasks, state.tasks),
        };
      },
    },
  ),
);
