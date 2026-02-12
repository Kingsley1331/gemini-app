"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Wand2, X, Send, Loader2, User, Copy, Check } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

interface PromptAssistantMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
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

IMPORTANT: Every time you present or update a draft prompt, you MUST wrap it between these exact markers:
=== DRAFT START ===
[the refined prompt here]
=== DRAFT END ===

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
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Reset state when modal opens
  useEffect(() => {
    if (isOpen) {
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
      // Focus input after animation
      setTimeout(() => inputRef.current?.focus(), 300);
    }
  }, [isOpen]);

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const currentDraft = extractDraft(messages);

  const handleSend = useCallback(async () => {
    const trimmed = input.trim();
    if (!trimmed || isLoading) return;

    const userMessage: PromptAssistantMessage = {
      id: Date.now().toString(),
      role: "user",
      content: trimmed,
    };

    const updatedMessages = [...messages, userMessage];
    setMessages(updatedMessages);
    setInput("");
    setIsLoading(true);

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

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        assistantContent += chunk;

        setMessages((prev) =>
          prev.map((msg) =>
            msg.id === assistantMessageId
              ? { ...msg, content: assistantContent }
              : msg
          )
        );
      }
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
      setIsLoading(false);
    }
  }, [input, isLoading, messages, selectedModel]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleKeep = () => {
    if (currentDraft) {
      onKeep(currentDraft);
    }
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
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
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
            className="relative z-10 w-full max-w-2xl h-[80vh] max-h-175 bg-white dark:bg-zinc-900 rounded-2xl shadow-2xl border border-zinc-200 dark:border-zinc-700 flex flex-col overflow-hidden"
          >
            {/* Header */}
            <div className="flex items-center justify-between px-5 py-4 border-b border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800/50">
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
            <div className="flex-1 overflow-y-auto p-4 space-y-4">
              {messages.map((m) => (
                <div
                  key={m.id}
                  className={`flex gap-3 ${
                    m.role === "user" ? "justify-end" : "justify-start"
                  }`}
                >
                  {m.role === "assistant" && (
                    <div className="w-7 h-7 rounded-full bg-purple-100 dark:bg-purple-900/30 flex items-center justify-center shrink-0 mt-1">
                      <Wand2 className="w-4 h-4 text-purple-600 dark:text-purple-400" />
                    </div>
                  )}
                  <div
                    className={`max-w-[80%] rounded-2xl px-4 py-3 text-sm ${
                      m.role === "user"
                        ? "bg-blue-600 text-white rounded-br-md"
                        : "bg-zinc-100 dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 rounded-bl-md"
                    }`}
                  >
                    {m.role === "assistant" ? (
                      <div className="prose prose-sm dark:prose-invert max-w-none [&>p:first-child]:mt-0 [&>p:last-child]:mb-0">
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>
                          {m.content.replace(
                            /=== DRAFT START ===[\s\S]*?=== DRAFT END ===/g,
                            ""
                          ).trim()}
                        </ReactMarkdown>
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

              <div ref={messagesEndRef} />
            </div>

            {/* Current Draft Section */}
            {currentDraft && (
              <div className="mx-4 mb-3 p-3 bg-purple-50 dark:bg-purple-900/20 border border-purple-200 dark:border-purple-800 rounded-xl">
                <div className="flex items-center justify-between mb-2">
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
                <div className="prose prose-sm dark:prose-invert max-w-none text-zinc-800 dark:text-zinc-200 leading-relaxed [&>p:first-child]:mt-0 [&>p:last-child]:mb-0">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>
                    {currentDraft}
                  </ReactMarkdown>
                </div>
              </div>
            )}

            {/* Input Area */}
            <div className="px-4 pb-4 pt-2 border-t border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800/50">
              <div className="flex items-center gap-2">
                <input
                  ref={inputRef}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="Describe your idea or answer questions..."
                  disabled={isLoading}
                  className="flex-1 bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-xl px-4 py-2.5 text-sm focus:ring-2 focus:ring-purple-500 focus:border-transparent outline-none shadow-sm transition-all disabled:opacity-50"
                />
                <button
                  onClick={handleSend}
                  disabled={!input.trim() || isLoading}
                  className="p-2.5 bg-purple-600 text-white rounded-xl hover:bg-purple-700 disabled:opacity-50 disabled:hover:bg-purple-600 shadow-lg shadow-purple-500/20 transition-all"
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
              <div className="flex items-center justify-end gap-2 mt-3">
                <button
                  onClick={onClose}
                  className="px-4 py-2 text-sm font-medium text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-zinc-100 dark:hover:bg-zinc-700/50 rounded-lg transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={handleKeep}
                  disabled={!currentDraft}
                  className="px-5 py-2 text-sm font-medium bg-purple-600 text-white rounded-lg hover:bg-purple-700 disabled:opacity-50 disabled:hover:bg-purple-600 shadow-md shadow-purple-500/20 transition-all"
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
