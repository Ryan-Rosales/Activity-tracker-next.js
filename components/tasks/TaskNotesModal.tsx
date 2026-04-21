"use client";

import { useEffect, useRef, useState } from "react";
import {
  Paperclip,
  Eye,
  EyeOff,
  Upload,
  ClipboardPaste,
  Copy,
  RefreshCcw,
  Download,
  FileCheck2,
  FileText,
  Lightbulb,
  Maximize2,
  MessageSquare,
  Minimize2,
  Search,
  ChevronRight,
  X,
  Redo2,
  Scissors,
  Share2,
  Sparkles,
  SpellCheck,
  Trash2,
  Undo2,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { motion } from "framer-motion";
import { Task } from "@/lib/types";
import { GradientButton } from "@/components/ui/GradientButton";
import type { TaskNoteAttachment } from "@/lib/types/taskNotes";
import { useThemeStore } from "@/lib/store/useThemeStore";

type TaskNotesModalProps = {
  task: Task;
  note: string;
  attachments: TaskNoteAttachment[];
  onClose: () => void;
  onSave: (payload: { note: string; attachments: TaskNoteAttachment[] }) => Promise<{ storage?: "postgres" | "supabase" | "memory" } | void> | void;
};

type AiActionKey = "extract" | "summarize" | "tone" | "advice" | "draft";

type AiPaletteItem = {
  key: AiActionKey;
  group: string;
  label: string;
  description: string;
  icon: React.ComponentType<{ className?: string }>;
  mode: "replace" | "append";
};

type AiRequestBody = {
  action: AiActionKey;
  taskTitle: string;
  taskDescription?: string;
  note: string;
};

type AiConversationEntry = {
  action: AiActionKey;
  helper: string;
  generated: string;
  content: string;
};

const aiPaletteItems: AiPaletteItem[] = [
  {
    key: "extract",
    group: "Action Item Extraction",
    label: "Extract checklist",
    description: "Scan the note and turn it into a structured checklist.",
    icon: FileCheck2,
    mode: "append",
  },
  {
    key: "summarize",
    group: "Content Refinement & Summarization",
    label: "Summarize",
    description: "Condense a long or messy note into one clear summary.",
    icon: FileText,
    mode: "replace",
  },
  {
    key: "tone",
    group: "Content Refinement & Summarization",
    label: "Tone change",
    description: "Rewrite the note in a more professional tone.",
    icon: FileText,
    mode: "replace",
  },
  {
    key: "advice",
    group: "Contextual Problem Solving",
    label: "Technical advice",
    description: "Get concrete next steps or tool suggestions for the blocker.",
    icon: Lightbulb,
    mode: "append",
  },
  {
    key: "draft",
    group: "Contextual Problem Solving",
    label: "Draft a message",
    description: "Draft an email or Slack message using the note context.",
    icon: MessageSquare,
    mode: "append",
  },
];

const buildAiGeneratedBlock = (actionLabel: string, generatedAt: string, content: string) => {
  return [
    "[AI GENERATED]",
    `Action: ${actionLabel}`,
    `Helper: ${aiPaletteItems.find((item) => item.key === actionLabel)?.label ?? actionLabel}`,
    `Generated: ${generatedAt}`,
    "",
    content.trim(),
    "",
    "[/AI GENERATED]",
  ].join("\n");
};

const isAiActionKey = (value: string): value is AiActionKey => {
  return ["extract", "summarize", "tone", "advice", "draft"].includes(value);
};

const resolveActionFromHelper = (helper: string): AiActionKey => {
  const normalized = helper.trim().toLowerCase();
  const direct = aiPaletteItems.find((item) => item.label.toLowerCase() === normalized);
  if (direct) return direct.key;

  if (normalized.includes("extract")) return "extract";
  if (normalized.includes("summar")) return "summarize";
  if (normalized.includes("tone")) return "tone";
  if (normalized.includes("advice")) return "advice";
  if (normalized.includes("draft") || normalized.includes("message")) return "draft";

  return "summarize";
};

const parseNoteWithAiBlocks = (raw: string) => {
  const entries: AiConversationEntry[] = [];
  const attachmentsPattern = /\[ATTACHMENTS_JSON\]([\s\S]*?)\[\/ATTACHMENTS_JSON\]/;

  const blockPattern = /\[AI GENERATED\]([\s\S]*?)\[\/AI GENERATED\]/g;

  const withoutAttachments = raw.replace(attachmentsPattern, "").trim();

  const userText = withoutAttachments.replace(blockPattern, (_full, inner: string) => {
    const lines = inner
      .split("\n")
      .map((line) => line.trimEnd())
      .filter((line) => line.trim().length > 0);

    const actionLine = lines.find((line) => line.startsWith("Action:"))?.replace("Action:", "").trim() || "";
    const helper = lines.find((line) => line.startsWith("Helper:"))?.replace("Helper:", "").trim() || "AI Assist";
    const generated = lines.find((line) => line.startsWith("Generated:"))?.replace("Generated:", "").trim() || "Unknown";
    const action = isAiActionKey(actionLine) ? actionLine : resolveActionFromHelper(helper);

    const content = lines
      .filter((line) => !line.startsWith("Action:") && !line.startsWith("Helper:") && !line.startsWith("Generated:"))
      .join("\n")
      .trim();

    if (content) {
      entries.push({ action, helper, generated, content });
    }

    return "";
  });

  return {
    userText: userText.replace(/\n{3,}/g, "\n\n").trim(),
    entries,
  };
};

const serializeNoteWithAiBlocks = (userText: string, entries: AiConversationEntry[]) => {
  const parts: string[] = [];
  const trimmedUserText = userText.trim();
  if (trimmedUserText) {
    parts.push(trimmedUserText);
  }

  for (const entry of entries) {
    parts.push(buildAiGeneratedBlock(entry.action, entry.generated, entry.content));
  }

  return parts.join("\n\n").trim();
};

const isTextAttachment = (attachment: TaskNoteAttachment) => {
  if (attachment.type.startsWith("text/")) return true;
  const lower = attachment.name.toLowerCase();
  return [".txt", ".md", ".json", ".csv", ".xml", ".html", ".js", ".ts", ".tsx", ".css", ".yml", ".yaml"].some((ext) =>
    lower.endsWith(ext),
  );
};

const isDocxAttachment = (attachment: TaskNoteAttachment) =>
  attachment.type === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
  attachment.name.toLowerCase().endsWith(".docx");

const formatFileSize = (size: number) => {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
};

export function TaskNotesModal({ task, note, attachments: initialAttachments, onClose, onSave }: TaskNotesModalProps) {
  const mode = useThemeStore((state) => state.mode);
  const isLight = mode === "light";
  const initialParsed = parseNoteWithAiBlocks(note);
  const [userText, setUserText] = useState(initialParsed.userText);
  const [aiEntries, setAiEntries] = useState<AiConversationEntry[]>(initialParsed.entries);
  const [attachments, setAttachments] = useState<TaskNoteAttachment[]>(initialAttachments);
  const [panelTab, setPanelTab] = useState<"ai" | "files">("ai");
  const [showAiConversation, setShowAiConversation] = useState(true);
  const [panelExpanded, setPanelExpanded] = useState(false);
  const [selectedAttachmentId, setSelectedAttachmentId] = useState<string | null>(initialAttachments[0]?.id ?? null);
  const [undoStack, setUndoStack] = useState<string[]>([]);
  const [redoStack, setRedoStack] = useState<string[]>([]);
  const [zoom, setZoom] = useState(1);
  const [spellcheck, setSpellcheck] = useState(true);
  const [loadingAI, setLoadingAI] = useState(false);
  const [statusMessage, setStatusMessage] = useState("");
  const [aiOpen, setAiOpen] = useState(false);
  const [aiQuery, setAiQuery] = useState("");
  const [docxPreviewHtml, setDocxPreviewHtml] = useState<string>("");
  const [docxPreviewStatus, setDocxPreviewStatus] = useState<"idle" | "loading" | "error">("idle");
  const [textPreview, setTextPreview] = useState("");
  const [textPreviewStatus, setTextPreviewStatus] = useState<"idle" | "loading" | "error">("idle");
  const [isDraggingFiles, setIsDraggingFiles] = useState(false);
  const [isUploadingFiles, setIsUploadingFiles] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [cloudState, setCloudState] = useState<"idle" | "saving" | "postgres" | "supabase" | "memory" | "error">("idle");
  const textAreaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, []);

  useEffect(() => {
    const parsed = parseNoteWithAiBlocks(note);
    setUserText(parsed.userText);
    setAiEntries(parsed.entries);
    setAttachments(initialAttachments);
    setSelectedAttachmentId(initialAttachments[0]?.id ?? null);
    setUndoStack([]);
    setRedoStack([]);
    setStatusMessage("");
  }, [initialAttachments, note, task]);

  // Removed automatic hydration from Storage listing to prevent unsaved files from persisting after refresh.
  // Only attachments saved to the database (in initialAttachments) are shown.
  // This ensures uploads only appear after explicit save.

  const applyTextChange = (nextValue: string, trackHistory = true) => {
    if (trackHistory) {
      setUndoStack((prev) => [...prev, userText]);
      setRedoStack([]);
    }
    setUserText(nextValue);
  };

  const selectionBounds = () => {
    const el = textAreaRef.current;
    if (!el) return null;

    return {
      start: el.selectionStart,
      end: el.selectionEnd,
    };
  };

  const copySelection = async () => {
    const bounds = selectionBounds();
    if (!bounds) return;

    const selectedText = userText.slice(bounds.start, bounds.end) || userText;
    if (!selectedText.trim()) {
      setStatusMessage("Nothing to copy.");
      return;
    }

    try {
      await navigator.clipboard.writeText(selectedText);
      setStatusMessage("Copied.");
    } catch {
      setStatusMessage("Clipboard copy blocked by browser permissions.");
    }
  };

  const cutSelection = async () => {
    const bounds = selectionBounds();
    if (!bounds) return;

    if (bounds.start === bounds.end) {
      setStatusMessage("Select text to cut.");
      return;
    }

    const selectedText = userText.slice(bounds.start, bounds.end);
    try {
      await navigator.clipboard.writeText(selectedText);
      const next = `${userText.slice(0, bounds.start)}${userText.slice(bounds.end)}`;
      applyTextChange(next);
      requestAnimationFrame(() => {
        textAreaRef.current?.focus();
        textAreaRef.current?.setSelectionRange(bounds.start, bounds.start);
      });
      setStatusMessage("Cut.");
    } catch {
      setStatusMessage("Clipboard cut blocked by browser permissions.");
    }
  };

  const pasteAtCursor = async () => {
    const bounds = selectionBounds();
    if (!bounds) return;

    try {
      const text = await navigator.clipboard.readText();
      if (!text) {
        setStatusMessage("Clipboard is empty.");
        return;
      }

      const next = `${userText.slice(0, bounds.start)}${text}${userText.slice(bounds.end)}`;
      applyTextChange(next);
      const cursor = bounds.start + text.length;
      requestAnimationFrame(() => {
        textAreaRef.current?.focus();
        textAreaRef.current?.setSelectionRange(cursor, cursor);
      });
      setStatusMessage("Pasted.");
    } catch {
      setStatusMessage("Clipboard paste blocked by browser permissions.");
    }
  };

  const undo = () => {
    setUndoStack((prev) => {
      const last = prev.at(-1);
      if (last === undefined) return prev;

      setRedoStack((redoPrev) => [userText, ...redoPrev]);
      setUserText(last);
      setStatusMessage("Undo.");
      return prev.slice(0, -1);
    });
  };

  const redo = () => {
    setRedoStack((prev) => {
      const [next, ...rest] = prev;
      if (next === undefined) return prev;

      setUndoStack((undoPrev) => [...undoPrev, userText]);
      setUserText(next);
      setStatusMessage("Redo.");
      return rest;
    });
  };

  const saveAsDownload = () => {
    const safeName = (task.title || "task-notes").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const blob = new Blob([serializeNoteWithAiBlocks(userText, aiEntries)], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${safeName || "task-notes"}.txt`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
    setStatusMessage("Saved to Downloads.");
  };

  const shareText = async () => {
    const exportText = serializeNoteWithAiBlocks(userText, aiEntries);
    if (!exportText.trim()) {
      setStatusMessage("Nothing to share.");
      return;
    }

    if (navigator.share) {
      try {
        await navigator.share({ title: task.title, text: serializeNoteWithAiBlocks(userText, aiEntries) });
        setStatusMessage("Shared.");
      } catch {
        setStatusMessage("Share canceled.");
      }
      return;
    }

    try {
      await navigator.clipboard.writeText(exportText);
      setStatusMessage("Share not supported here. Notes copied to clipboard.");
    } catch {
      setStatusMessage("Share unavailable in this browser.");
    }
  };

  const applyAiResult = (result: string, action: AiPaletteItem) => {
    const trimmed = result.trim();
    if (!trimmed) {
      setStatusMessage("AI suggestion was empty.");
      return;
    }

    setAiEntries((prev) => [
      ...prev,
      {
        action: action.key,
        helper: action.label,
        generated: new Date().toLocaleString(),
        content: trimmed,
      },
    ]);
    setStatusMessage(`AI suggestion added (${action.label}).`);
  };

  const copyAiEntry = async (entry: AiConversationEntry) => {
    try {
      await navigator.clipboard.writeText(entry.content);
      setStatusMessage("AI entry copied.");
    } catch {
      setStatusMessage("Clipboard copy blocked by browser permissions.");
    }
  };

  const deleteAiEntry = (entryIndex: number) => {
    setAiEntries((prev) => prev.filter((_, index) => index !== entryIndex));
    setStatusMessage("AI entry deleted.");
  };

  const formatAiError = (message: string) => {
    const normalized = message.toLowerCase();

    if (normalized.includes("quota") || normalized.includes("resource_exhausted") || normalized.includes("429")) {
      return "Gemini quota limit reached. Please check your Gemini API usage/billing and try again.";
    }

    if (normalized.includes("api key") || normalized.includes("unauth") || normalized.includes("permission")) {
      return "Gemini API key is invalid or missing. Please verify GEMINI_API_KEY.";
    }

    if (normalized.includes("model") || normalized.includes("not found")) {
      return "Gemini model is unavailable. Please verify GEMINI_MODEL (gemini-2.5-flash-lite).";
    }

    return "AI request failed. Please try again in a moment.";
  };

  const runAiAction = async (action: AiPaletteItem, options?: { targetIndex?: number }) => {
    setLoadingAI(true);
    try {
      const response = await fetch("/api/ai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: action.key,
          taskTitle: task.title,
          taskDescription: task.description ?? "",
          note: userText,
        } satisfies AiRequestBody),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        const message =
          typeof errorData?.error === "string"
            ? errorData.error
            : "AI request failed.";
        setStatusMessage(formatAiError(message));
        return;
      }

      const data = await response.json();
      const suggestion = typeof data.reply === "string" ? data.reply.trim() : "";

      if (suggestion) {
        if (typeof options?.targetIndex === "number") {
          setAiEntries((prev) =>
            prev.map((entry, index) =>
              index === options.targetIndex
                ? {
                    ...entry,
                    action: action.key,
                    helper: action.label,
                    generated: new Date().toLocaleString(),
                    content: suggestion,
                  }
                : entry,
            ),
          );
          setStatusMessage(`AI entry regenerated (${action.label}).`);
        } else {
          applyAiResult(suggestion, action);
          setStatusMessage("AI suggestion added.");
        }
        return;
      }

      setStatusMessage("AI provider returned an empty response. Please try again.");
    } catch {
      setStatusMessage("Could not reach Gemini API. Please check your API key and server logs.");
    } finally {
      setLoadingAI(false);
    }
  };

  const regenerateAiEntry = (entry: AiConversationEntry, entryIndex: number) => {
    const action = aiPaletteItems.find((item) => item.key === entry.action);
    if (!action) {
      setStatusMessage("Unable to map this AI entry to an action.");
      return;
    }

    void runAiAction(action, { targetIndex: entryIndex });
  };

  const handleFilesArray = async (fileArray: File[]) => {
    if (!fileArray.length) return;

    const list = fileArray.slice(0, 8);
    setIsUploadingFiles(true);
    const nextAttachments: TaskNoteAttachment[] = [];

    for (const file of list) {
      if (file.size > 8 * 1024 * 1024) {
        setStatusMessage(`Skipped ${file.name}. Maximum file size is 8 MB.`);
        continue;
      }

      try {
        const formData = new FormData();
        formData.append("taskId", task.id);
        formData.append("file", file);

        const response = await fetch("/api/task-notes/attachments", {
          method: "POST",
          body: formData,
        });

        if (!response.ok) {
          const errorPayload = await response.json().catch(() => null);
          const fallbackText = await response.text().catch(() => "");
          const message =
            (errorPayload && typeof errorPayload.error === "string" && errorPayload.error) ||
            (fallbackText ? `Upload failed (${response.status}): ${fallbackText.slice(0, 180)}` : `Could not upload ${file.name}.`);
          setStatusMessage(message);
          continue;
        }

        const data = await response.json();
        if (data?.attachment && typeof data.attachment === "object") {
          nextAttachments.push(data.attachment as TaskNoteAttachment);
        }
      } catch {
        setStatusMessage(`Could not upload ${file.name}.`);
      }
    }

    setIsUploadingFiles(false);

    if (nextAttachments.length) {
      setAttachments((prev) => {
        const merged = [...prev, ...nextAttachments];
        if (!selectedAttachmentId) {
          setSelectedAttachmentId(nextAttachments[0].id);
        }
        return merged;
      });
      setPanelTab("files");
      setStatusMessage(`${nextAttachments.length} file(s) attached.`);
    }

    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  const handleFilesSelected = async (files: FileList | null) => {
    if (!files?.length) return;
    await handleFilesArray(Array.from(files));
  };

  const selectedAttachment = attachments.find((item) => item.id === selectedAttachmentId) ?? null;
  const showSidePanel = showAiConversation && (aiEntries.length || attachments.length);

  useEffect(() => {
    const selected = attachments.find((item) => item.id === selectedAttachmentId);
    const isDocx = !!selected && isDocxAttachment(selected);
    const previewUrl = selected?.previewUrl;

    if (!selected || !isDocx || !previewUrl) {
      setDocxPreviewStatus("idle");
      setDocxPreviewHtml("");
      return;
    }

    let canceled = false;

    const renderDocxPreview = async () => {
      setDocxPreviewStatus("loading");
      try {
        const mammoth = await import("mammoth/mammoth.browser");
        const fileResponse = await fetch(previewUrl);
        const buffer = await fileResponse.arrayBuffer();
        const result = await mammoth.convertToHtml({ arrayBuffer: buffer });
        if (!canceled) {
          setDocxPreviewHtml(result.value || "");
          setDocxPreviewStatus("idle");
        }
      } catch {
        if (!canceled) {
          setDocxPreviewStatus("error");
          setDocxPreviewHtml("");
        }
      }
    };

    void renderDocxPreview();

    return () => {
      canceled = true;
    };
  }, [attachments, selectedAttachmentId]);

  useEffect(() => {
    const selected = attachments.find((item) => item.id === selectedAttachmentId);

    if (!selected || !isTextAttachment(selected) || !selected.previewUrl) {
      setTextPreviewStatus("idle");
      setTextPreview("");
      return;
    }

    let canceled = false;

    const renderTextPreview = async () => {
      setTextPreviewStatus("loading");
      try {
        const response = await fetch(selected.previewUrl as string);
        const text = await response.text();

        if (!canceled) {
          setTextPreview(text.slice(0, 3000));
          setTextPreviewStatus("idle");
        }
      } catch {
        if (!canceled) {
          setTextPreviewStatus("error");
          setTextPreview("");
        }
      }
    };

    void renderTextPreview();

    return () => {
      canceled = true;
    };
  }, [attachments, selectedAttachmentId]);

  const removeAttachment = (id: string) => {
    void (async () => {
      const response = await fetch("/api/task-notes/attachments", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ taskId: task.id, attachmentId: id }),
      });

      if (!response.ok) {
        setStatusMessage("Unable to delete attachment right now.");
        return;
      }

      setAttachments((prev) => {
        const next = prev.filter((item) => item.id !== id);
        if (selectedAttachmentId === id) {
          setSelectedAttachmentId(next[0]?.id ?? null);
        }
        return next;
      });
      setStatusMessage("Attachment removed.");
    })();
  };

  const cloudBadgeLabel =
    cloudState === "postgres"
      ? "Saved to cloud"
      : cloudState === "supabase"
        ? "Saved to cloud fallback"
        : cloudState === "memory"
          ? "Saved locally"
          : cloudState === "saving"
            ? "Saving to cloud..."
            : "Not saved yet";

  const cloudBadgeClass =
    isLight
      ? cloudState === "postgres"
        ? "border-emerald-300 bg-emerald-50 text-emerald-700"
        : cloudState === "supabase"
          ? "border-amber-300 bg-amber-50 text-amber-700"
          : cloudState === "memory"
            ? "border-slate-300 bg-slate-100 text-slate-700"
            : cloudState === "saving"
              ? "border-violet-300 bg-violet-50 text-violet-700"
              : "border-slate-300 bg-white text-slate-600"
      : cloudState === "postgres"
        ? "border-emerald-300/40 bg-emerald-500/15 text-emerald-100"
        : cloudState === "supabase"
          ? "border-amber-300/40 bg-amber-500/15 text-amber-100"
          : cloudState === "memory"
            ? "border-white/15 bg-white/5 text-slate-300"
            : cloudState === "saving"
              ? "border-violet-300/40 bg-violet-500/15 text-violet-100"
              : "border-white/15 bg-white/5 text-slate-300";

  const handleSave = async () => {
    setIsSaving(true);
    setCloudState("saving");

    try {
      const result = await Promise.resolve(onSave({ note: serializeNoteWithAiBlocks(userText, aiEntries), attachments }));
      const storage = result && typeof result === "object" && "storage" in result ? result.storage : undefined;
      setCloudState(storage ?? "postgres");
      setStatusMessage(storage === "supabase" ? "Saved to cloud fallback." : "Saved to cloud.");
    } catch {
      setCloudState("error");
      setStatusMessage("Save failed. Please try again.");
      return;
    } finally {
      setIsSaving(false);
    }

    onClose();
  };

  return (
    <>
      <div className="fixed inset-0 z-[260] grid place-items-center bg-black/60 p-2 sm:p-4">
        <motion.div
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          className={`task-notes-modal flex h-[94vh] w-full max-w-5xl flex-col overflow-hidden rounded-2xl border p-4 backdrop-blur-3xl sm:p-5 ${
            isLight
              ? "border-slate-200 bg-slate-50/98 shadow-[0_24px_70px_rgba(15,23,42,0.16)]"
              : "border-white/20 bg-slate-950/90"
          }`}
        >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className={`text-lg font-semibold ${isLight ? "text-slate-900" : "text-white"}`}>Task Notepad</h3>
            <p className={`mt-1 text-sm ${isLight ? "text-slate-600" : "text-slate-300"}`}>{task.title}</p>
            <div className={`mt-2 inline-flex items-center rounded-full border px-2.5 py-1 text-[11px] font-semibold ${cloudBadgeClass}`}>
              {cloudBadgeLabel}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setAiOpen((state) => !state)}
              disabled={loadingAI}
              title="AI Suggest"
              aria-label="AI Suggest"
              className={`inline-flex size-10 items-center justify-center rounded-full border transition disabled:cursor-not-allowed disabled:opacity-50 ${
                isLight
                  ? "border-violet-300 bg-violet-50 text-violet-700 hover:bg-violet-100"
                  : "border-violet-300/40 bg-violet-500/15 text-violet-100 hover:bg-violet-500/25"
              }`}
            >
              <Sparkles className="size-4" />
            </button>
            <button
              type="button"
              onClick={() => setShowAiConversation((state) => !state)}
              title={showAiConversation ? "Hide files panel" : "Show files panel"}
              aria-label={showAiConversation ? "Hide files panel" : "Show files panel"}
              className={`inline-flex size-10 items-center justify-center rounded-full border transition ${
                isLight
                  ? "border-cyan-300 bg-cyan-50 text-cyan-700 hover:bg-cyan-100"
                  : "border-cyan-300/40 bg-cyan-500/15 text-cyan-100 hover:bg-cyan-500/25"
              }`}
            >
              {showAiConversation ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
            </button>
            <button
              type="button"
              onClick={onClose}
              title="Close notes"
              aria-label="Close notes"
              className={`inline-flex size-10 items-center justify-center rounded-full border transition ${
                isLight
                  ? "border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
                  : "border-white/20 bg-white/5 text-white hover:bg-white/10"
              }`}
            >
              <X className="size-4" />
            </button>
          </div>
        </div>

        <div className={`mt-4 flex flex-wrap gap-2 rounded-xl border p-2 ${isLight ? "border-slate-200 bg-white" : "border-white/10 bg-black/20"}`}>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept=".pdf,.doc,.docx,.txt,.md,image/*"
            className="hidden"
            onChange={(event) => {
              void handleFilesSelected(event.target.files);
            }}
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={isUploadingFiles}
            title="Attach files"
            aria-label="Attach files"
            className={`inline-flex items-center justify-center rounded-lg border p-2 disabled:cursor-not-allowed disabled:opacity-55 ${
              isLight
                ? "border-cyan-300 bg-cyan-50 text-cyan-700 hover:bg-cyan-100"
                : "border-cyan-300/35 bg-cyan-500/15 text-cyan-100"
            }`}
          >
            <Paperclip className="size-4" />
          </button>
          <button
            type="button"
            onClick={saveAsDownload}
            title="Save to downloads"
            aria-label="Save to downloads"
            className={`inline-flex items-center justify-center rounded-lg border p-2 ${
              isLight ? "border-slate-300 bg-white text-slate-700 hover:bg-slate-50" : "border-white/20 bg-white/10 text-white"
            }`}
          >
            <Download className="size-4" />
          </button>
          <button
            type="button"
            onClick={shareText}
            title="Share text"
            aria-label="Share text"
            className={`inline-flex items-center justify-center rounded-lg border p-2 ${
              isLight ? "border-slate-300 bg-white text-slate-700 hover:bg-slate-50" : "border-white/20 bg-white/10 text-white"
            }`}
          >
            <Share2 className="size-4" />
          </button>
          <button
            type="button"
            onClick={cutSelection}
            title="Cut"
            aria-label="Cut"
            className={`inline-flex items-center justify-center rounded-lg border p-2 ${
              isLight ? "border-slate-300 bg-white text-slate-700 hover:bg-slate-50" : "border-white/20 bg-white/10 text-white"
            }`}
          >
            <Scissors className="size-4" />
          </button>
          <button
            type="button"
            onClick={copySelection}
            title="Copy"
            aria-label="Copy"
            className={`inline-flex items-center justify-center rounded-lg border p-2 ${
              isLight ? "border-slate-300 bg-white text-slate-700 hover:bg-slate-50" : "border-white/20 bg-white/10 text-white"
            }`}
          >
            <Copy className="size-4" />
          </button>
          <button
            type="button"
            onClick={pasteAtCursor}
            title="Paste"
            aria-label="Paste"
            className={`inline-flex items-center justify-center rounded-lg border p-2 ${
              isLight ? "border-slate-300 bg-white text-slate-700 hover:bg-slate-50" : "border-white/20 bg-white/10 text-white"
            }`}
          >
            <ClipboardPaste className="size-4" />
          </button>
          <button
            type="button"
            onClick={undo}
            disabled={!undoStack.length}
            title="Undo"
            aria-label="Undo"
            className={`inline-flex items-center justify-center rounded-lg border p-2 disabled:cursor-not-allowed disabled:opacity-40 ${
              isLight ? "border-slate-300 bg-white text-slate-700 hover:bg-slate-50" : "border-white/20 bg-white/10 text-white"
            }`}
          >
            <Undo2 className="size-4" />
          </button>
          <button
            type="button"
            onClick={redo}
            disabled={!redoStack.length}
            title="Redo"
            aria-label="Redo"
            className={`inline-flex items-center justify-center rounded-lg border p-2 disabled:cursor-not-allowed disabled:opacity-40 ${
              isLight ? "border-slate-300 bg-white text-slate-700 hover:bg-slate-50" : "border-white/20 bg-white/10 text-white"
            }`}
          >
            <Redo2 className="size-4" />
          </button>
          <button
            type="button"
            onClick={() => {
              setZoom((prev) => Math.max(0.8, Number((prev - 0.1).toFixed(1))));
              setStatusMessage("Zoomed out.");
            }}
            title="Zoom out"
            aria-label="Zoom out"
            className={`inline-flex items-center justify-center rounded-lg border p-2 ${
              isLight ? "border-slate-300 bg-white text-slate-700 hover:bg-slate-50" : "border-white/20 bg-white/10 text-white"
            }`}
          >
            <ZoomOut className="size-4" />
          </button>
          <button
            type="button"
            onClick={() => {
              setZoom((prev) => Math.min(2, Number((prev + 0.1).toFixed(1))));
              setStatusMessage("Zoomed in.");
            }}
            title="Zoom in"
            aria-label="Zoom in"
            className={`inline-flex items-center justify-center rounded-lg border p-2 ${
              isLight ? "border-slate-300 bg-white text-slate-700 hover:bg-slate-50" : "border-white/20 bg-white/10 text-white"
            }`}
          >
            <ZoomIn className="size-4" />
          </button>
          <button
            type="button"
            onClick={() => {
              setSpellcheck((prev) => !prev);
              setStatusMessage(`Spell check ${!spellcheck ? "enabled" : "disabled"}.`);
            }}
            title="Spell check"
            aria-label="Spell check"
            className={`inline-flex items-center justify-center rounded-lg border p-2 ${
              isLight
                ? spellcheck
                  ? "border-violet-300 bg-violet-50 text-violet-700"
                  : "border-slate-300 bg-white text-slate-700"
                : spellcheck
                  ? "border-violet-400 bg-violet-500/20 text-white"
                  : "border-white/20 bg-white/10 text-white"
            }`}
          >
            <SpellCheck className="size-4" />
          </button>
        </div>

        <div className="mt-4 min-h-0 flex-1 overflow-hidden">
          <div
            className={`grid h-full min-h-0 grid-cols-1 gap-3 ${
              showSidePanel
                ? panelExpanded
                  ? "md:grid-cols-[0.7fr_1.3fr]"
                  : "md:grid-cols-2"
                : ""
            }`}
          >
          <div
            className={`min-h-0 rounded-xl transition ${isDraggingFiles ? "ring-2 ring-cyan-400/70" : ""}`}
            onDragOver={(event) => {
              event.preventDefault();
              setIsDraggingFiles(true);
            }}
            onDragLeave={(event) => {
              event.preventDefault();
              const currentTarget = event.currentTarget;
              const related = event.relatedTarget as Node | null;
              if (!related || !currentTarget.contains(related)) {
                setIsDraggingFiles(false);
              }
            }}
            onDrop={(event) => {
              event.preventDefault();
              setIsDraggingFiles(false);
              const dropped = Array.from(event.dataTransfer.files || []);
              void handleFilesArray(dropped);
            }}
          >
            <textarea
              ref={textAreaRef}
              value={userText}
              onChange={(event) => applyTextChange(event.target.value)}
              spellCheck={spellcheck}
              autoCorrect={spellcheck ? "on" : "off"}
              autoCapitalize="sentences"
              lang="en-US"
              placeholder="Write your notes here..."
              style={{
                fontSize: `${zoom}rem`,
                lineHeight: 1.8,
                backgroundImage:
                  "repeating-linear-gradient(to bottom, transparent 0, transparent calc(1.8em - 1px), rgba(148,163,184,0.2) calc(1.8em - 1px), rgba(148,163,184,0.2) 1.8em)",
                backgroundPositionY: "0.9em",
              }}
              className="h-full min-h-[18rem] w-full rounded-xl border border-white/20 bg-black/20 px-3 pb-8 pt-3.5 text-white outline-none focus:border-violet-400"
            />
            {isDraggingFiles ? (
              <div className="pointer-events-none -mt-10 flex justify-center">
                <span className="inline-flex items-center gap-1 rounded-full border border-cyan-300/45 bg-cyan-500/20 px-2 py-1 text-xs text-cyan-100">
                  <Upload className="size-3.5" /> Drop files to attach
                </span>
              </div>
            ) : null}
          </div>

          {showSidePanel ? (
            <div className="flex min-h-0 flex-col rounded-xl border border-white/10 bg-black/15 p-3">
              <div className="mb-2 flex items-center justify-between gap-2">
                <div className="inline-flex items-center rounded-lg border border-white/15 bg-white/5 p-0.5">
                  <button
                    type="button"
                    onClick={() => setPanelTab("ai")}
                    className={`rounded-md px-2 py-1 text-xs ${panelTab === "ai" ? "bg-violet-500/30 text-violet-100" : "text-slate-300"}`}
                  >
                    AI Conversation
                  </button>
                  <button
                    type="button"
                    onClick={() => setPanelTab("files")}
                    className={`rounded-md px-2 py-1 text-xs ${panelTab === "files" ? "bg-cyan-500/30 text-cyan-100" : "text-slate-300"}`}
                  >
                    Uploaded Files ({attachments.length}){isUploadingFiles ? "..." : ""}
                  </button>
                </div>
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => setPanelExpanded((prev) => !prev)}
                    title={panelExpanded ? "Restore panel" : "Expand panel"}
                    aria-label={panelExpanded ? "Restore panel" : "Expand panel"}
                    className="inline-flex items-center justify-center rounded-lg border border-white/20 bg-white/5 p-1.5 text-slate-300 hover:bg-white/10"
                  >
                    {panelExpanded ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowAiConversation(false)}
                    title="Hide side panel"
                    aria-label="Hide side panel"
                    className="inline-flex items-center justify-center rounded-lg border border-white/20 bg-white/5 p-1.5 text-slate-300 hover:bg-white/10"
                  >
                    <EyeOff className="size-4" />
                  </button>
                </div>
              </div>

              {panelTab === "ai" ? (
                <div className="min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
                  {aiEntries.map((entry, index) => (
                  <div
                    key={`${entry.generated}-${index}`}
                    className="rounded-2xl border border-white/15 bg-white/5 p-3 backdrop-blur-xl"
                  >
                    <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <span className="inline-flex items-center gap-1 rounded-full border border-violet-300/40 bg-violet-500/15 px-2 py-0.5 text-[11px] font-semibold text-violet-200">
                          <Sparkles className="size-3" /> AI Generated
                        </span>
                        <span className="text-[11px] text-slate-400">{entry.generated}</span>
                      </div>
                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => {
                            void copyAiEntry(entry);
                          }}
                          title="Copy AI entry"
                          aria-label="Copy AI entry"
                          className="inline-flex items-center justify-center rounded-lg border border-white/20 bg-white/5 p-1.5 text-slate-200 transition hover:bg-white/10"
                        >
                          <Copy className="size-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            regenerateAiEntry(entry, index);
                          }}
                          disabled={loadingAI}
                          title="Regenerate AI entry"
                          aria-label="Regenerate AI entry"
                          className="inline-flex items-center justify-center rounded-lg border border-white/20 bg-white/5 p-1.5 text-slate-200 transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          <RefreshCcw className="size-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            deleteAiEntry(index);
                          }}
                          title="Delete AI entry"
                          aria-label="Delete AI entry"
                          className="inline-flex items-center justify-center rounded-lg border border-rose-300/30 bg-rose-500/10 p-1.5 text-rose-200 transition hover:bg-rose-500/20"
                        >
                          <Trash2 className="size-3.5" />
                        </button>
                      </div>
                    </div>
                    <p className="text-xs font-medium text-cyan-200">Helper: {entry.helper}</p>
                    <pre className="mt-2 whitespace-pre-wrap text-sm text-slate-100">{entry.content}</pre>
                  </div>
                  ))}
                  {!aiEntries.length ? (
                    <div className="rounded-2xl border border-white/10 bg-white/5 p-4 text-sm text-slate-300">
                      No AI responses yet.
                    </div>
                  ) : null}
                </div>
              ) : (
                <div className="min-h-0 flex-1 overflow-y-auto pr-1 pb-10">
                  {attachments.length ? (
                    <div className="space-y-2">
                      <div className="space-y-1">
                        {attachments.map((file) => (
                          <div key={file.id} className="flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-2 py-1.5">
                            <button
                              type="button"
                              onClick={() => setSelectedAttachmentId(file.id)}
                              className={`min-w-0 flex-1 truncate text-left text-xs ${selectedAttachmentId === file.id ? "text-cyan-100" : "text-slate-300"}`}
                            >
                              {file.name} · {formatFileSize(file.size)}
                            </button>
                            <button
                              type="button"
                              onClick={() => removeAttachment(file.id)}
                              className="rounded border border-rose-300/35 bg-rose-500/10 p-1 text-rose-200"
                            >
                              <Trash2 className="size-3.5" />
                            </button>
                          </div>
                        ))}
                      </div>

                      {selectedAttachment ? (
                        <div className="rounded-xl border border-white/15 bg-black/20 p-2">
                          <p className="mb-2 text-xs text-slate-400">{selectedAttachment.name}</p>
                          {selectedAttachment.type.startsWith("image/") && selectedAttachment.previewUrl ? (
                            <img
                              src={selectedAttachment.previewUrl}
                              alt={selectedAttachment.name}
                              className={`w-full rounded-lg object-contain ${panelExpanded ? "max-h-[58vh]" : "max-h-[42vh]"}`}
                            />
                          ) : (selectedAttachment.type === "application/pdf" || selectedAttachment.name.toLowerCase().endsWith(".pdf")) && selectedAttachment.previewUrl ? (
                            <div className="space-y-2">
                              <iframe
                                src={selectedAttachment.previewUrl}
                                className={`w-full rounded-lg border border-white/10 ${panelExpanded ? "h-[58vh]" : "h-[42vh]"}`}
                                title={selectedAttachment.name}
                              />
                              <a href={selectedAttachment.previewUrl} target="_blank" rel="noreferrer" className="text-xs text-cyan-200 underline">
                                Download original PDF
                              </a>
                            </div>
                          ) : isDocxAttachment(selectedAttachment) && selectedAttachment.previewUrl ? (
                            docxPreviewStatus === "loading" ? (
                              <p className="text-xs text-slate-400">Rendering Word preview...</p>
                            ) : docxPreviewStatus === "error" ? (
                              <p className="text-xs text-slate-400">Unable to render this Word file preview. You can download it instead.</p>
                            ) : (
                              <div
                                className={`overflow-y-auto rounded-lg border border-white/10 bg-white/5 p-3 text-xs text-slate-100 ${panelExpanded ? "max-h-[52vh]" : "max-h-56"}`}
                                dangerouslySetInnerHTML={{ __html: docxPreviewHtml || "<p>No readable content found in this document.</p>" }}
                              />
                            )
                          ) : isTextAttachment(selectedAttachment) ? (
                            textPreviewStatus === "loading" ? (
                              <p className="text-xs text-slate-400">Loading text preview...</p>
                            ) : textPreviewStatus === "error" ? (
                              <p className="text-xs text-slate-400">Unable to load this text preview right now.</p>
                            ) : (
                              <pre className={`overflow-y-auto whitespace-pre-wrap text-xs text-slate-200 ${panelExpanded ? "max-h-[58vh]" : "max-h-[42vh]"}`}>{textPreview}</pre>
                            )
                          ) : selectedAttachment.previewUrl ? (
                            <a href={selectedAttachment.previewUrl} target="_blank" rel="noreferrer" className="text-sm text-cyan-200 underline">
                              Open file preview
                            </a>
                          ) : (
                            <p className="text-xs text-slate-400">Preview unavailable for this file.</p>
                          )}
                        </div>
                      ) : null}
                    </div>
                  ) : (
                    <div className="rounded-2xl border border-white/10 bg-white/5 p-4 text-sm text-slate-300">
                      No files uploaded yet.
                    </div>
                  )}
                </div>
              )}
            </div>
          ) : null}
        </div>
      </div>

        <div className="mt-3 flex shrink-0 flex-wrap items-center justify-end gap-2">
          <div className="flex flex-wrap gap-2">
            <GradientButton
              type="button"
              disabled={isSaving}
              onClick={() => {
                void handleSave();
              }}
            >
              {isSaving ? "Saving..." : "Save Notes"}
            </GradientButton>
          </div>
        </div>
        <p className="mt-2 text-xs text-slate-400">{statusMessage}</p>
      </motion.div>
    </div>

    {aiOpen ? (
        <div className="fixed inset-0 z-[280] grid place-items-center bg-black/65 p-2 sm:p-4">
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            className={`task-notes-modal-suggest z-[270] flex w-full max-w-3xl max-h-[88vh] flex-col overflow-y-auto rounded-2xl border p-4 shadow-[0_24px_70px_rgba(15,23,42,0.22)] backdrop-blur-3xl ${
              isLight ? "border-slate-200 bg-slate-50/98" : "border-white/20 bg-slate-950/95"
            }`}
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <h4 className={`text-lg font-semibold ${isLight ? "text-slate-900" : "text-white"}`}>AI Suggest</h4>
                <p className={`mt-1 text-sm ${isLight ? "text-slate-600" : "text-slate-300"}`}>Search a command and insert an API-generated suggestion.</p>
              </div>
              <button
                type="button"
                onClick={() => {
                  setAiOpen(false);
                  setAiQuery("");
                }}
                title="Close AI suggest"
                aria-label="Close AI suggest"
                className={`inline-flex size-10 items-center justify-center rounded-full border transition ${
                  isLight ? "border-slate-300 bg-white text-slate-700 hover:bg-slate-50" : "border-white/20 bg-white/5 text-white hover:bg-white/10"
                }`}
              >
                <X className="size-4" />
              </button>
            </div>

            <div className="relative mt-5">
              <Search className={`pointer-events-none absolute left-3 top-3 size-4 ${isLight ? "text-slate-500" : "text-slate-400"}`} />
              <input
                value={aiQuery}
                onChange={(event) => setAiQuery(event.target.value)}
                placeholder="Search AI actions..."
                className={`w-full rounded-2xl border py-3 pl-10 pr-10 text-sm outline-none placeholder:text-slate-500 focus:border-violet-400 ${
                  isLight ? "border-slate-300 bg-white text-slate-900 placeholder:text-slate-400" : "border-white/15 bg-white/5 text-white"
                }`}
              />
              {aiQuery ? (
                <button
                  type="button"
                  onClick={() => setAiQuery("")}
                  className={`absolute right-2 top-2 rounded-lg border p-1.5 ${isLight ? "border-slate-200 bg-white text-slate-600 hover:bg-slate-50" : "border-white/10 bg-white/5 text-slate-300 hover:bg-white/10"}`}
                  aria-label="Clear search"
                >
                  <X className="size-3.5" />
                </button>
              ) : null}
            </div>

            <div className="mt-5 min-h-0 flex-1 space-y-4 overflow-y-auto pr-1">
              {([
                "Action Item Extraction",
                "Content Refinement & Summarization",
                "Contextual Problem Solving",
              ] as const).map((group) => {
                const items = aiPaletteItems.filter((item) => item.group === group).filter((item) => {
                  const haystack = `${item.group} ${item.label} ${item.description}`.toLowerCase();
                  return haystack.includes(aiQuery.toLowerCase().trim());
                });

                if (!items.length) return null;

                return (
                  <div key={group} className="space-y-2">
                    <p className="text-[11px] font-semibold uppercase tracking-[0.35em] text-slate-500">{group}</p>
                    <div className="grid gap-2">
                      {items.map((item) => {
                        const Icon = item.icon;
                        return (
                          <button
                            key={item.key}
                            type="button"
                            onClick={() => {
                              setAiOpen(false);
                              setAiQuery("");
                              void runAiAction(item);
                            }}
                            className={`flex items-start gap-3 rounded-2xl border p-4 text-left transition hover:border-violet-400/60 ${
                              isLight ? "border-slate-200 bg-white hover:bg-slate-50" : "border-white/15 bg-white/5 hover:bg-white/10"
                            }`}
                          >
                            <div className={`rounded-xl border p-2 ${isLight ? "border-violet-200 bg-violet-50 text-violet-700" : "border-white/10 bg-white/10 text-white"}`}>
                              <Icon className="size-4" />
                            </div>
                            <div className="flex-1">
                              <p className={`font-semibold ${isLight ? "text-slate-900" : "text-white"}`}>{item.label}</p>
                              <p className={`mt-1 text-sm ${isLight ? "text-slate-600" : "text-slate-300"}`}>{item.description}</p>
                            </div>
                            <ChevronRight className={`mt-1 size-4 ${isLight ? "text-slate-500" : "text-slate-400"}`} />
                          </button>
                        );
                      })}
                    </div>
                  </div>
                );
              })}

              {aiPaletteItems.filter((item) => `${item.group} ${item.label} ${item.description}`.toLowerCase().includes(aiQuery.toLowerCase().trim())).length === 0 ? (
                <div className="rounded-2xl border border-white/15 bg-white/5 p-4 text-sm text-slate-300">
                  No actions match your search.
                </div>
              ) : null}
            </div>
          </motion.div>
        </div>
      ) : null}
    </>
  );
}