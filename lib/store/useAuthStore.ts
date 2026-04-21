"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";
import { User } from "@/lib/types";
import { useNotificationStore } from "@/lib/store/useNotificationStore";
import { useTaskStore } from "@/lib/store/useTaskStore";
import { useTaskNotesStore } from "@/lib/store/useTaskNotesStore";
import { useSettingsStore } from "@/lib/store/useSettingsStore";

interface AuthState {
  user: User | null;
  isAuthenticated: boolean;
  login: (email: string, password: string, remember?: boolean) => Promise<void>;
  signup: (email: string, password: string, fullName?: string) => Promise<{ message: string; user?: User }>;
  logout: () => void;
  updateProfile: (updates: Partial<User>) => Promise<void>;
  hydrateSession: () => Promise<void>;
}

const readJsonSafe = async (response: Response) => {
  const text = await response.text();
  if (!text.trim()) return {};

  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error("Authentication service returned an invalid response. Please try again.");
  }
};

const setUserEmailCookie = (email: string | null) => {
  if (typeof document === "undefined") return;

  if (!email) {
    document.cookie = "activity_user_email=; Path=/; Max-Age=0; SameSite=Lax";
    return;
  }

  document.cookie = `activity_user_email=${encodeURIComponent(email)}; Path=/; Max-Age=2592000; SameSite=Lax`;
};

const AI_CONVERSATIONS_CACHE_KEY = "activity-ai-conversations-cache-v1";

const normalizeEmail = (value: string | null | undefined) => (value ?? "").trim().toLowerCase();

const shouldResetScopedData = (currentEmail: string | null | undefined, nextEmail: string | null | undefined) => {
  const current = normalizeEmail(currentEmail);
  const next = normalizeEmail(nextEmail);
  return !!next && current !== next;
};

const clearClientScopedData = () => {
  useTaskStore.getState().setTasks([]);
  useTaskNotesStore.getState().setNotesByTaskId({});
  useTaskNotesStore.getState().setAttachmentsByTaskId({});
  useNotificationStore.getState().setNotifications([]);
  useSettingsStore.getState().hydrate({
    displayName: undefined,
    email: undefined,
    avatar: undefined,
    twoFactorEnabled: false,
    overdueAlerts: true,
    aiReminders: true,
    weeklySummary: false,
  });

  if (typeof window !== "undefined") {
    const keysToRemove = Object.keys(window.localStorage).filter(
      (key) => key === AI_CONVERSATIONS_CACHE_KEY || key.startsWith(`${AI_CONVERSATIONS_CACHE_KEY}:`),
    );

    for (const key of keysToRemove) {
      window.localStorage.removeItem(key);
    }
  }
};

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      user: null,
      isAuthenticated: false,
      login: async (email, password, remember = true) => {
        if (!email.trim() || !password.trim()) {
          throw new Error("Email and password are required");
        }

        const response = await fetch("/api/auth/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email, password, remember }),
        });

        const data = await readJsonSafe(response);
        const userData = data.user as { email?: string; name?: string; avatar?: string | null } | undefined;
        if (!response.ok || !userData?.email) {
          throw new Error((data.error as string) ?? "Login failed");
        }

        const existingAvatar = get().user?.avatar ?? "";

        const user: User = {
          name: userData.name ?? userData.email.split("@")[0] ?? "User",
          email: userData.email,
          avatar: typeof userData.avatar === "string" ? userData.avatar : existingAvatar,
        };

        if (shouldResetScopedData(get().user?.email, user.email)) {
          clearClientScopedData();
        }
        setUserEmailCookie(user.email);
        set({ user, isAuthenticated: true });
        useNotificationStore.getState().pushNotification({
          type: "update",
          message: "Signed in successfully.",
        });
      },
      signup: async (email, password, fullName) => {
        const response = await fetch("/api/auth/signup", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email, password, fullName }),
        });

        const data = await readJsonSafe(response);
        if (!response.ok) {
          throw new Error((data.error as string) ?? "Sign up failed");
        }

        const userData = data.user as { email?: string; name?: string } | undefined;
        const user = userData?.email
          ? {
              email: userData.email,
              name: userData.name ?? userData.email.split("@")[0] ?? "User",
              avatar: "",
            }
          : undefined;

        if (user) {
          if (shouldResetScopedData(get().user?.email, user.email)) {
            clearClientScopedData();
          }
          setUserEmailCookie(user.email);
          set({ user, isAuthenticated: true });
          useNotificationStore.getState().pushNotification({
            type: "update",
            message: "Account created and signed in.",
          });
        }

        return {
          message: (data.message as string) ?? "Account created.",
          user,
        };
      },
      logout: () => {
        clearClientScopedData();
        void fetch("/api/auth/logout", { method: "POST" });
        setUserEmailCookie(null);
        set({ user: null, isAuthenticated: false });
      },
      updateProfile: async (updates) => {
        const previousUser = get().user;
        if (!previousUser) {
          throw new Error("You must be signed in to update your profile.");
        }

        const optimisticUser: User = { ...previousUser, ...updates };
        const optimisticEmail = optimisticUser.email;

        set({ user: optimisticUser });

        try {
          const response = await fetch("/api/auth/profile", {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              displayName: updates.name,
              email: updates.email,
              avatar: updates.avatar === undefined ? undefined : updates.avatar,
            }),
          });

          const data = await readJsonSafe(response);
          if (!response.ok) {
            throw new Error((data.error as string) ?? "Failed to update profile");
          }

          const profile = data.profile as { displayName?: string; email?: string; avatar?: string | null } | undefined;
          const nextEmail = profile?.email ?? optimisticEmail;
          if (nextEmail) {
            setUserEmailCookie(nextEmail);
          }

          set((state) => {
            if (!state.user) return state;
            return {
              user: {
                ...state.user,
                name: profile?.displayName ?? state.user.name,
                email: profile?.email ?? state.user.email,
                avatar: profile?.avatar ?? state.user.avatar,
              },
            };
          });
        } catch (error) {
          set({ user: previousUser });
          setUserEmailCookie(previousUser.email);
          throw error instanceof Error ? error : new Error("Failed to save profile.");
        }
      },
      hydrateSession: async () => {
        try {
          const response = await fetch("/api/auth/session", { cache: "no-store" });
          if (!response.ok) {
            set({ user: null, isAuthenticated: false });
            return;
          }

          const data = await readJsonSafe(response);
          const userData = data.user as { email?: string; name?: string; avatar?: string | null } | undefined;
          if (!userData?.email) {
            set({ user: null, isAuthenticated: false });
            return;
          }

          const existingAvatar = get().user?.avatar ?? "";

          const user: User = {
            name: userData.name ?? userData.email.split("@")[0] ?? "User",
            email: userData.email,
            avatar: typeof userData.avatar === "string" ? userData.avatar : existingAvatar,
          };

          if (shouldResetScopedData(get().user?.email, user.email)) {
            clearClientScopedData();
          }
          setUserEmailCookie(user.email);
          set({ user, isAuthenticated: true });
        } catch {
          set({ user: null, isAuthenticated: false });
        }
      },
    }),
    {
      name: "auth-store",
      onRehydrateStorage: () => () => {},
    },
  ),
);
