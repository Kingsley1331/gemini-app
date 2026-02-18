"use client";

import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Wand2, X, Send, Loader2, User, Copy, Check, Type, FileText } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import RichTextEditor, { RichTextEditorRef } from "./RichTextEditor";

interface PromptAssistantMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
}

interface OptionGroup {
  category: string;
  options: string[];
}

interface PromptAssistantProps {
  isOpen: boolean;
  onClose: () => void;
  onKeep: (draft: string) => void;
  selectedModel: string;
}

const PROMPT_ASSISTANT_SYSTEM_INSTRUCTION = `You are a prompt engineering assistant. Your sole purpose is to help the user craft a clear, detailed, and effective prompt they can send to an AI model.

When the user shares their idea:
1. Ask 2-3 targeted clarifying questions about scope, audience, tone, format, or specifics to understand exactly what they need.
2. After getting answers, present a refined prompt draft.
3. Ask if they want any changes.
4. Continue refining until they are satisfied.
5. When useful, provide optional additions the user can choose from.

IMPORTANT: Every time you present or update a draft prompt, you MUST wrap it between these exact markers:
=== DRAFT START ===
[the refined prompt here]
=== DRAFT END ===

When you provide options, you MUST wrap them between these exact markers:
=== OPTIONS START ===
- option one
- option two
=== OPTIONS END ===

Use one option per line.
Always include an OPTIONS block when:
- you ask clarifying questions (include likely answer choices),
- you propose optional additions,
- or you offer alternative directions.
If no specific options are available, include at least one safe fallback option such as:
- Use your best judgment and keep it concise.

Keep your conversational responses concise. Focus on making the prompt specific, actionable, and well-structured. Do not answer the prompt itself — only help craft it.`;

function extractDraft(messages: PromptAssistantMessage[]): string | null {
  // Walk through messages in reverse to find the latest draft
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "assistant") {
      const match = msg.content.match(
        /=== DRAFT START ===\s*([\s\S]*?)\s*=== DRAFT END ===/
      );
      if (match) {
        return match[1].trim();
      }
    }
  }
  return null;
}

// Find the ID of the message containing the latest draft
function findLatestDraftMessageId(messages: PromptAssistantMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "assistant" && /=== DRAFT START ===/.test(msg.content)) {
      return msg.id;
    }
  }
  return null;
}

// Build a map of message ID -> draft version number (1-indexed)
function buildDraftVersionMap(messages: PromptAssistantMessage[]): Map<string, number> {
  const map = new Map<string, number>();
  let version = 1;
  for (const msg of messages) {
    if (msg.role === "assistant" && /=== DRAFT START ===/.test(msg.content)) {
      map.set(msg.id, version);
      version++;
    }
  }
  return map;
}

const DRAFT_REGEX = /=== DRAFT START ===\s*([\s\S]*?)\s*=== DRAFT END ===/g;
const OPTIONS_BLOCK_REGEX = /=== OPTIONS START ===\s*([\s\S]*?)\s*=== OPTIONS END ===/g;

function parseOptionsBlock(rawOptions: string): string[] {
  const seen = new Set<string>();
  const options: string[] = [];

  rawOptions
    .split("\n")
    .map((line) => line.trim())
    .forEach((line) => {
      if (!line) return;

      // Accept bullet, numbered, or checkbox-style markdown lines.
      const cleaned = line
        .replace(/^[-*]\s+/, "")
        .replace(/^\d+\.\s+/, "")
        .replace(/^\[(?: |x|X)\]\s*/, "")
        .trim();

      if (!cleaned || seen.has(cleaned)) return;
      seen.add(cleaned);
      options.push(cleaned);
    });

  return options;
}

function dedupeOptions(options: string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  const questionStarterRegex =
    /^(what|why|how|when|where|which|who|whom|whose|is|are|am|do|does|did|can|could|should|would|will|have|has|had)\b/i;

  options.forEach((option) => {
    let cleaned = option
      .trim()
      .replace(/\s+/g, " ")
      .replace(/[.?!]+$/, "");

    // If an option contains only one side of parentheses, remove it.
    // Example: "(HTML" -> "HTML", "JS)" -> "JS".
    const hasOpenParen = cleaned.includes("(");
    const hasCloseParen = cleaned.includes(")");
    if (hasOpenParen !== hasCloseParen) {
      cleaned = cleaned.replace(/[()]/g, "").trim();
    }

    // Do not surface question-like text as checkbox options.
    if (cleaned.includes("?")) return;
    if (questionStarterRegex.test(cleaned)) return;

    if (!cleaned || seen.has(cleaned)) return;
    seen.add(cleaned);
    normalized.push(cleaned);
  });

  return normalized;
}

function normalizeCategory(category: string): string {
  let normalized = category.trim().replace(/\*\*/g, "").replace(/\s+/g, " ");

  // If intro text and first numbered question are on one line
  // (e.g. "... clarifying questions: 1. What platform/language?"),
  // keep only the numbered question tail.
  const numberedTailMatch = normalized.match(/(\d+\.\s*[^?]+\??)\s*$/);
  if (numberedTailMatch) {
    normalized = numberedTailMatch[1];
  }

  return normalized
    .replace(/^\d+\.\s*/, "")
    .replace(/^[-*]\s+/, "")
    .replace(/\?\s*$/, "")
    .replace(/\s+/g, " ");
}

function mergeOptionGroups(groups: OptionGroup[]): OptionGroup[] {
  const grouped = new Map<string, string[]>();

  groups.forEach((group) => {
    const category = normalizeCategory(group.category) || "Options";
    const existing = grouped.get(category) || [];
    grouped.set(category, dedupeOptions([...existing, ...group.options]));
  });

  return Array.from(grouped.entries())
    .map(([category, options]) => ({ category, options }))
    .filter((group) => group.options.length > 0);
}

function splitInlineOptions(raw: string): string[] {
  const cleaned = raw
    .replace(/^for example[:,]?\s*/i, "")
    .replace(/^examples?[:,]?\s*/i, "")
    .replace(/\?\s*$/, "")
    .trim();

  if (!cleaned) return [];

  const parts = cleaned
    .replace(/\s+or\s+/gi, ", ")
    .replace(/\s*\/\s*/g, ", ")
    .replace(/\s*;\s*/g, ", ")
    .split(",")
    .map((part) =>
      part
        .trim()
        .replace(/^and\s+/i, "")
        .replace(/^or\s+/i, "")
        .replace(/^[-*]\s+/, "")
        .trim()
    )
    .filter(Boolean);

  return dedupeOptions(parts);
}

function extractQuestionInlineOptionGroups(content: string): OptionGroup[] {
  const text = stripOptionsBlocks(content)
    .replace(/=== DRAFT START ===[\s\S]*?=== DRAFT END ===/g, "")
    .trim();

  if (!text) return [];

  const groups: OptionGroup[] = [];
  const noMarkdown = text.replace(/\*\*/g, "").replace(/\s+/g, " ").trim();
  const questionWithContextRegex = /([^?]{8,}\?)\s*([^?]+)/g;

  let match: RegExpExecArray | null;
  while ((match = questionWithContextRegex.exec(noMarkdown)) !== null) {
    const category = normalizeCategory(match[1] || "");
    const trailing = match[2]?.trim() || "";
    const options = splitInlineOptions(trailing);
    if (!category || options.length === 0) continue;
    groups.push({ category, options });
  }

  return mergeOptionGroups(groups);
}

function extractLatestOptionGroups(messages: PromptAssistantMessage[]): OptionGroup[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== "assistant") continue;

    const regex = new RegExp(OPTIONS_BLOCK_REGEX.source, "g");
    let match: RegExpExecArray | null;
    let latestBlock: string | null = null;

    while ((match = regex.exec(msg.content)) !== null) {
      latestBlock = match[1];
    }

    const inlineGroups = extractQuestionInlineOptionGroups(msg.content);
    const blockOptions = latestBlock ? parseOptionsBlock(latestBlock) : [];
    const blockGroups =
      blockOptions.length > 0
        ? [{ category: "Additional options", options: blockOptions }]
        : [];

    const mergedGroups = mergeOptionGroups([...inlineGroups, ...blockGroups]);
    if (mergedGroups.length > 0) {
      return mergedGroups;
    }
  }

  return [];
}

function stripOptionsBlocks(content: string): string {
  return content.replace(OPTIONS_BLOCK_REGEX, "").trim();
}

function stripInlineQuestionOptions(content: string): string {
  return content
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.includes("?")) return line;

      const markdownless = trimmed.replace(/\*\*/g, "");
      const qIndex = markdownless.indexOf("?");
      if (qIndex === -1) return line;

      const trailing = markdownless.slice(qIndex + 1).trim();
      if (!trailing) return line;
      if (splitInlineOptions(trailing).length === 0) return line;

      // If this line looks like a clarifying question with inline choices,
      // keep only the question text and render choices as checkboxes below.
      const questionOnly = normalizeCategory(markdownless.slice(0, qIndex + 1));
      return questionOnly ? `${questionOnly}?` : line;
    })
    .join("\n");
}

export default function PromptAssistant({
  isOpen,
  onClose,
  onKeep,
  selectedModel,
}: PromptAssistantProps) {
  const [messages, setMessages] = useState<PromptAssistantMessage[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [copiedDraft, setCopiedDraft] = useState(false);
  const [copiedPreviousDraft, setCopiedPreviousDraft] = useState<string | null>(null);
  const [isRichText, setIsRichText] = useState(false);
  const [richTextContent, setRichTextContent] = useState("");
  const [selectedOptions, setSelectedOptions] = useState<string[]>([]);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const isStreamingRef = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const richTextRef = useRef<RichTextEditorRef>(null);
  const wasOpenRef = useRef(false);

  // Reset state when modal opens
  useEffect(() => {
    if (isOpen && !wasOpenRef.current) {
      setMessages([
        {
          id: "welcome",
          role: "assistant",
          content:
            "Welcome! I'm here to help you craft the perfect prompt. What would you like to create a prompt for? Share your rough idea and I'll help refine it.",
        },
      ]);
      setInput("");
      setIsLoading(false);
      setCopiedDraft(false);
      setRichTextContent("");
      setSelectedOptions([]);
      richTextRef.current?.clear();
      // Focus input after animation
      setTimeout(() => {
        if (isRichText) {
          richTextRef.current?.focus();
        } else {
          inputRef.current?.focus();
        }
      }, 300);
    }
    wasOpenRef.current = isOpen;
  }, [isOpen]);

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);

  const currentDraft = extractDraft(messages);
  const latestDraftMessageId = findLatestDraftMessageId(messages);
  const draftVersionMap = buildDraftVersionMap(messages);
  const currentOptionGroups = useMemo(() => extractLatestOptionGroups(messages), [messages]);
  const currentOptionItems = useMemo(
    () =>
      currentOptionGroups.flatMap((group) =>
        group.options.map((option) => ({
          key: `${group.category}::${option}`,
          category: group.category,
          option,
        }))
      ),
    [currentOptionGroups]
  );

  useEffect(() => {
    setSelectedOptions((prev) => {
      const next = prev.filter((optionKey) =>
        currentOptionItems.some((item) => item.key === optionKey)
      );
      const isSame =
        next.length === prev.length && next.every((value, index) => value === prev[index]);
      return isSame ? prev : next;
    });
  }, [currentOptionItems]);

  const handleSend = useCallback(async (overrideMessage?: string) => {
    const richContent = isRichText ? richTextRef.current?.getMarkdown() || "" : "";
    const messageInput =
      typeof overrideMessage === "string"
        ? overrideMessage
        : (isRichText ? richContent : input);
    const trimmed = messageInput.trim();
    if (!trimmed || isLoading) return;

    const userMessage: PromptAssistantMessage = {
      id: Date.now().toString(),
      role: "user",
      content: trimmed,
    };

    const updatedMessages = [...messages, userMessage];
    setMessages(updatedMessages);
    setInput("");
    if (isRichText) {
      richTextRef.current?.clear();
      setRichTextContent("");
    }
    setIsLoading(true);
    scrollToBottom();

    try {
      // Build messages for API (exclude the welcome message which isn't a real API message)
      const apiMessages = updatedMessages
        .filter((m) => m.id !== "welcome")
        .map((m) => ({
          role: m.role,
          content: m.content,
        }));

      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: selectedModel,
          messages: apiMessages,
          systemInstruction: PROMPT_ASSISTANT_SYSTEM_INSTRUCTION,
        }),
      });

      if (!response.ok) throw new Error("Failed to get response");
      if (!response.body) throw new Error("No response body");

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let assistantContent = "";

      const assistantMessageId = (Date.now() + 1).toString();
      const assistantMessage: PromptAssistantMessage = {
        id: assistantMessageId,
        role: "assistant",
        content: "",
      };

      setMessages((prev) => [...prev, assistantMessage]);
      isStreamingRef.current = true;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        assistantContent += chunk;

        const container = messagesContainerRef.current;
        const scrollTop = container?.scrollTop ?? 0;
        const atBottom = container
          ? container.scrollHeight - container.scrollTop - container.clientHeight < 40
          : true;

        setMessages((prev) =>
          prev.map((msg) =>
            msg.id === assistantMessageId
              ? { ...msg, content: assistantContent }
              : msg
          )
        );

        // Wait for React render + browser layout, then fix scroll position
        await new Promise<void>((resolve) => {
          setTimeout(() => {
            if (container) {
              if (atBottom) {
                container.scrollTop = container.scrollHeight;
              } else {
                container.scrollTop = scrollTop;
              }
            }
            resolve();
          }, 0);
        });
      }

      isStreamingRef.current = false;
    } catch (error) {
      console.error("Prompt assistant error:", error);
      setMessages((prev) => [
        ...prev,
        {
          id: (Date.now() + 2).toString(),
          role: "assistant",
          content:
            "Sorry, I encountered an error. Please try again.",
        },
      ]);
    } finally {
      isStreamingRef.current = false;
      setIsLoading(false);
    }
  }, [input, isLoading, messages, selectedModel, isRichText]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleKeep = () => {
    if (currentDraft) {
      const chosenItems = currentOptionItems.filter((item) =>
        selectedOptions.includes(item.key)
      );

      const finalDraft =
        chosenItems.length > 0
          ? `${currentDraft}\n\nAdditional requirements:\n${mergeOptionGroups(
              chosenItems.map((item) => ({
                category: item.category,
                options: [item.option],
              }))
            )
              .map(
                (group) =>
                  `${group.category}:\n${group.options
                    .map((option) => `- ${option}`)
                    .join("\n")}`
              )
              .join("\n\n")}`
          : currentDraft;

      onKeep(finalDraft);
    }
  };

  const toggleOption = (optionKey: string) => {
    setSelectedOptions((prev) =>
      prev.includes(optionKey)
        ? prev.filter((selected) => selected !== optionKey)
        : [...prev, optionKey]
    );
  };

  const submitSelectedOptions = (groups: OptionGroup[]) => {
    const selectedItems = groups.flatMap((group) =>
      group.options
        .filter((option) => selectedOptions.includes(`${group.category}::${option}`))
        .map((option) => ({ category: group.category, option }))
    );

    if (selectedItems.length === 0 || isLoading) return;

    const groupedText = mergeOptionGroups(
      selectedItems.map((item) => ({
        category: item.category,
        options: [item.option],
      }))
    )
      .map((group) => `${group.category}: ${group.options.join(", ")}`)
      .join("\n");

    handleSend(`Here are my selected options:\n${groupedText}`);
  };

  const renderOptionGroupsForMessage = (message: PromptAssistantMessage) => {
    if (message.role !== "assistant") return null;
    if (message.id === "welcome") return null;

    const messageOptionGroups = extractLatestOptionGroups([message]);
    if (messageOptionGroups.length === 0) return null;

    return (
      <div className="mt-3 space-y-3 rounded-lg border border-zinc-300/70 bg-white/60 p-2.5 dark:border-zinc-600 dark:bg-zinc-900/30">
        {messageOptionGroups.map((group, groupIdx) => (
          <div key={`${message.id}-${group.category}-${groupIdx}`}>
            <p className="mb-1 px-1 text-[11px] font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
              {group.category}
            </p>
            <div className="space-y-1">
              {group.options.map((option, optionIdx) => {
                const optionKey = `${group.category}::${option}`;
                const inputId = `prompt-inline-option-${message.id}-${groupIdx}-${optionIdx}`;
                const isChecked = selectedOptions.includes(optionKey);
                return (
                  <label
                    key={`${message.id}-${optionKey}`}
                    htmlFor={inputId}
                    className="flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 transition-colors hover:bg-zinc-100 dark:hover:bg-zinc-700/50"
                  >
                    <input
                      id={inputId}
                      type="checkbox"
                      checked={isChecked}
                      onChange={() => toggleOption(optionKey)}
                      className="mt-0.5 h-4 w-4 rounded border-zinc-300 text-purple-600 focus:ring-purple-500 dark:border-zinc-600 dark:bg-zinc-800"
                    />
                    <span className="text-sm leading-snug text-zinc-700 dark:text-zinc-200">
                      {option}
                    </span>
                  </label>
                );
              })}
            </div>
          </div>
        ))}
        <div className="pt-1">
          <button
            type="button"
            onClick={() => submitSelectedOptions(messageOptionGroups)}
            disabled={
              isLoading ||
              !messageOptionGroups.some((group) =>
                group.options.some((option) =>
                  selectedOptions.includes(`${group.category}::${option}`)
                )
              )
            }
            className="rounded-lg bg-purple-600 px-3 py-2 text-xs font-medium text-white transition-colors hover:bg-purple-700 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-purple-600"
          >
            Submit selections
          </button>
        </div>
      </div>
    );
  };

  const handleCopyDraft = () => {
    if (currentDraft) {
      navigator.clipboard.writeText(currentDraft);
      setCopiedDraft(true);
      setTimeout(() => setCopiedDraft(false), 2000);
    }
  };

  // Close on Escape
  useEffect(() => {
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape" && isOpen) {
        onClose();
      }
    };
    document.addEventListener("keydown", handleEsc);
    return () => document.removeEventListener("keydown", handleEsc);
  }, [isOpen, onClose]);

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-50 flex items-center justify-center p-2 sm:p-4"
        >
          {/* Backdrop */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute inset-0 bg-black/50 backdrop-blur-sm"
            onClick={onClose}
          />

          {/* Modal */}
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 20 }}
            transition={{ type: "spring", damping: 25, stiffness: 300 }}
            className="relative z-10 flex h-[92dvh] max-h-[92dvh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-2xl dark:border-zinc-700 dark:bg-zinc-900 sm:h-[80vh] sm:max-h-[80vh]"
          >
            {/* Header */}
            <div className="flex items-center justify-between border-b border-zinc-200 bg-zinc-50 px-4 py-3 dark:border-zinc-700 dark:bg-zinc-800/50 sm:px-5 sm:py-4">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-purple-500 rounded-lg">
                  <Wand2 className="w-5 h-5 text-white" />
                </div>
                <div>
                  <h2 className="font-bold text-zinc-900 dark:text-zinc-100">
                    Prompt Assistant
                  </h2>
                  <p className="text-xs text-zinc-500 dark:text-zinc-400">
                    Let me help you craft the perfect prompt
                  </p>
                </div>
              </div>
              <button
                onClick={onClose}
                className="p-2 text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-700/50 rounded-lg transition-colors"
                title="Close"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Messages Area */}
            <div
              ref={messagesContainerRef}
              className="flex-1 space-y-4 overflow-y-auto p-3 sm:p-4"
              style={{ overflowAnchor: "none" }}
            >
              {messages.map((m) => (
                <div
                  key={m.id}
                  className={`flex gap-3 ${
                    m.role === "user" ? "justify-end" : "justify-start"
                  }`}
                  style={{ overflowAnchor: "none" }}
                >
                  {m.role === "assistant" && (
                    <div className="w-7 h-7 rounded-full bg-purple-100 dark:bg-purple-900/30 flex items-center justify-center shrink-0 mt-1">
                      <Wand2 className="w-4 h-4 text-purple-600 dark:text-purple-400" />
                    </div>
                  )}
                  <div
                    className={`max-w-[90%] rounded-2xl px-3 py-2.5 text-sm sm:max-w-[80%] sm:px-4 sm:py-3 ${
                      m.role === "user"
                        ? "bg-blue-600 text-white rounded-br-md"
                        : "bg-zinc-100 dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 rounded-bl-md"
                    }`}
                  >
                    {m.role === "assistant" ? (
                      <div className="prose prose-sm dark:prose-invert max-w-none [&>p:first-child]:mt-0 [&>p:last-child]:mb-0">
                        {m.id === latestDraftMessageId ? (
                          // Latest draft message: strip the draft (shown in Current Draft panel)
                          <>
                            <ReactMarkdown remarkPlugins={[remarkGfm]}>
                              {stripInlineQuestionOptions(
                                stripOptionsBlocks(
                                  m.content.replace(
                                    /=== DRAFT START ===[\s\S]*?=== DRAFT END ===/g,
                                    ""
                                  )
                                )
                              )}
                            </ReactMarkdown>
                            {renderOptionGroupsForMessage(m)}
                          </>
                        ) : draftVersionMap.has(m.id) ? (
                          // Older message with a draft: show draft inline
                          (() => {
                            const parts = m.content.split(/=== DRAFT START ===[\s\S]*?=== DRAFT END ===/);
                            const drafts: string[] = [];
                            let match: RegExpExecArray | null;
                            const re = new RegExp(DRAFT_REGEX.source, "g");
                            while ((match = re.exec(m.content)) !== null) {
                              drafts.push(match[1].trim());
                            }
                            const version = draftVersionMap.get(m.id);
                            return (
                              <>
                                {parts.map((part, idx) => (
                                  <span key={idx}>
                                    {stripOptionsBlocks(part).trim() && (
                                      <ReactMarkdown remarkPlugins={[remarkGfm]}>
                                        {stripInlineQuestionOptions(stripOptionsBlocks(part))}
                                      </ReactMarkdown>
                                    )}
                                    {idx < drafts.length && (() => {
                                      const draftKey = `${m.id}-${idx}`;
                                      const isCopied = copiedPreviousDraft === draftKey;
                                      return (
                                        <div className="my-2 p-2.5 bg-zinc-200/60 dark:bg-zinc-700/50 border border-zinc-300 dark:border-zinc-600 rounded-lg">
                                          <div className="flex items-center justify-between mb-1.5">
                                            <div className="flex items-center gap-1.5">
                                              <FileText className="w-3 h-3 text-zinc-500 dark:text-zinc-400" />
                                              <span className="text-[10px] font-semibold text-zinc-500 dark:text-zinc-400 uppercase tracking-wide">
                                                Draft v{version}
                                              </span>
                                            </div>
                                            <button
                                              onClick={() => {
                                                navigator.clipboard.writeText(drafts[idx]);
                                                setCopiedPreviousDraft(draftKey);
                                                setTimeout(() => setCopiedPreviousDraft(null), 2000);
                                              }}
                                              className="p-1 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200 rounded transition-colors"
                                              title="Copy draft"
                                            >
                                              {isCopied ? (
                                                <Check className="w-3 h-3" />
                                              ) : (
                                                <Copy className="w-3 h-3" />
                                              )}
                                            </button>
                                          </div>
                                          <div className="text-xs text-zinc-600 dark:text-zinc-300 leading-relaxed [&>p:first-child]:mt-0 [&>p:last-child]:mb-0 select-text">
                                            <ReactMarkdown remarkPlugins={[remarkGfm]}>
                                              {drafts[idx]}
                                            </ReactMarkdown>
                                          </div>
                                        </div>
                                      );
                                    })()}
                                  </span>
                                ))}
                              </>
                            );
                          })()
                        ) : (
                          // Regular assistant message (no draft)
                          <ReactMarkdown remarkPlugins={[remarkGfm]}>
                            {stripInlineQuestionOptions(stripOptionsBlocks(m.content))}
                          </ReactMarkdown>
                        )}
                        {m.id !== latestDraftMessageId && renderOptionGroupsForMessage(m)}
                      </div>
                    ) : (
                      <p className="whitespace-pre-wrap">{m.content}</p>
                    )}
                  </div>
                  {m.role === "user" && (
                    <div className="w-7 h-7 rounded-full bg-blue-100 dark:bg-blue-900/30 flex items-center justify-center shrink-0 mt-1">
                      <User className="w-4 h-4 text-blue-600 dark:text-blue-400" />
                    </div>
                  )}
                </div>
              ))}

              {isLoading && messages[messages.length - 1]?.role !== "assistant" && (
                <div className="flex gap-3">
                  <div className="w-7 h-7 rounded-full bg-purple-100 dark:bg-purple-900/30 flex items-center justify-center shrink-0">
                    <Wand2 className="w-4 h-4 text-purple-600 dark:text-purple-400" />
                  </div>
                  <div className="bg-zinc-100 dark:bg-zinc-800 rounded-2xl rounded-bl-md px-4 py-3">
                    <div className="flex gap-1.5">
                      <motion.div
                        animate={{ scale: [1, 1.2, 1] }}
                        transition={{
                          repeat: Infinity,
                          duration: 1,
                          delay: 0,
                        }}
                        className="w-2 h-2 bg-purple-500 rounded-full"
                      />
                      <motion.div
                        animate={{ scale: [1, 1.2, 1] }}
                        transition={{
                          repeat: Infinity,
                          duration: 1,
                          delay: 0.2,
                        }}
                        className="w-2 h-2 bg-purple-500 rounded-full"
                      />
                      <motion.div
                        animate={{ scale: [1, 1.2, 1] }}
                        transition={{
                          repeat: Infinity,
                          duration: 1,
                          delay: 0.4,
                        }}
                        className="w-2 h-2 bg-purple-500 rounded-full"
                      />
                    </div>
                  </div>
                </div>
              )}

              <div ref={messagesEndRef} style={{ overflowAnchor: "none" }} />
            </div>

            {/* Current Draft Section */}
            {currentDraft && (
              <div className="mx-3 mb-3 flex max-h-[32vh] shrink-0 flex-col rounded-xl border border-purple-200 bg-purple-50 p-3 dark:border-purple-800 dark:bg-purple-900/20 sm:mx-4 sm:max-h-[30vh]">
                <div className="flex items-center justify-between mb-2 shrink-0">
                  <span className="text-xs font-semibold text-purple-700 dark:text-purple-300 uppercase tracking-wide">
                    Current Draft
                  </span>
                  <button
                    onClick={handleCopyDraft}
                    className="p-1 text-purple-500 hover:text-purple-700 dark:hover:text-purple-300 rounded transition-colors"
                    title="Copy draft"
                  >
                    {copiedDraft ? (
                      <Check className="w-3.5 h-3.5" />
                    ) : (
                      <Copy className="w-3.5 h-3.5" />
                    )}
                  </button>
                </div>
                <div className="overflow-y-auto prose prose-sm dark:prose-invert max-w-none text-zinc-800 dark:text-zinc-200 leading-relaxed [&>p:first-child]:mt-0 [&>p:last-child]:mb-0">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>
                    {currentDraft}
                  </ReactMarkdown>
                </div>
              </div>
            )}

            {/* Input Area */}
            <div className="shrink-0 border-t border-zinc-200 bg-zinc-50 px-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] pt-2 dark:border-zinc-700 dark:bg-zinc-800/50 sm:px-4 sm:pb-4">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                <button
                  type="button"
                  onClick={() => {
                    setIsRichText((prev) => {
                      if (prev) {
                        // Switching from rich to plain: pull content as markdown
                        const md = richTextRef.current?.getMarkdown() || "";
                        setInput(md);
                      } else {
                        // Switching from plain to rich: pass content to editor after mount
                        setTimeout(() => {
                          if (input.trim()) {
                            richTextRef.current?.setContent(input);
                            setRichTextContent(input);
                          }
                        }, 100);
                      }
                      return !prev;
                    });
                  }}
                  className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl transition-all sm:h-10 sm:w-10 ${
                    isRichText
                      ? "text-purple-600 bg-purple-50 dark:bg-purple-900/20"
                      : "text-zinc-500 hover:text-purple-600 hover:bg-purple-50 dark:hover:bg-purple-900/20"
                  }`}
                  title={isRichText ? "Switch to plain text" : "Switch to rich text editor"}
                >
                  <Type className="w-5 h-5" />
                </button>
                {isRichText ? (
                  <RichTextEditor
                    ref={richTextRef}
                    placeholder="Describe your idea or answer questions..."
                    onSubmit={() => handleSend()}
                    onChange={(md) => setRichTextContent(md)}
                    initialContent={input}
                  />
                ) : (
                  <input
                    ref={inputRef}
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder="Describe your idea or answer questions..."
                    disabled={isLoading}
                    className="w-full flex-1 rounded-xl border border-zinc-200 bg-white px-4 py-2.5 text-sm outline-none shadow-sm transition-all focus:border-transparent focus:ring-2 focus:ring-purple-500 disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-800"
                  />
                )}
                <button
                  onClick={handleSend}
                  disabled={!(isRichText ? richTextContent.trim() : input.trim()) || isLoading}
                  className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-purple-600 text-white shadow-lg shadow-purple-500/20 transition-all hover:bg-purple-700 disabled:opacity-50 disabled:hover:bg-purple-600 sm:h-10 sm:w-10"
                  title="Send"
                >
                  {isLoading ? (
                    <Loader2 className="w-5 h-5 animate-spin" />
                  ) : (
                    <Send className="w-5 h-5" />
                  )}
                </button>
              </div>

              {/* Footer Buttons */}
              <div className="mt-3 flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-end">
                <button
                  onClick={onClose}
                  className="rounded-lg px-4 py-2 text-sm font-medium text-zinc-600 transition-colors hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-700/50 dark:hover:text-zinc-100"
                >
                  Cancel
                </button>
                <button
                  onClick={handleKeep}
                  disabled={!currentDraft}
                  className="rounded-lg bg-purple-600 px-5 py-2 text-sm font-medium text-white shadow-md shadow-purple-500/20 transition-all hover:bg-purple-700 disabled:opacity-50 disabled:hover:bg-purple-600"
                >
                  Keep
                </button>
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
