"use client";

import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import {
  Send,
  Image as ImageIcon,
  Loader2,
  Bot,
  Sparkles,
  Paperclip,
  X,
  Mic,
  Upload,
  ChevronDown,
  Type,
  Wand2,
} from "lucide-react";
import RichTextEditor, { RichTextEditorRef } from "./RichTextEditor";
import PromptAssistant from "./PromptAssistant";
import { motion, AnimatePresence } from "framer-motion";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import MessageItem, { Message } from "./MessageItem";

// Types for Web Speech API
interface SpeechRecognitionEvent extends Event {
  resultIndex: number;
  results: SpeechRecognitionResultList;
}

interface SpeechRecognitionErrorEvent extends Event {
  error: string;
}

interface SpeechRecognition extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  onresult: (event: SpeechRecognitionEvent) => void;
  onerror: (event: SpeechRecognitionErrorEvent) => void;
  onstart: () => void;
  onend: () => void;
  start: () => void;
  stop: () => void;
}

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

const SELECTED_MODEL_STORAGE_KEY = "selectedModel";

export default function Chat() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [isMicInitializing, setIsMicInitializing] = useState(false);
  const [speakingMessageId, setSpeakingMessageId] = useState<string | null>(
    null,
  );
  const [isGeneratingSpeech, setIsGeneratingSpeech] = useState<string | null>(
    null,
  );
  const [selectedModel, setSelectedModel] = useState("gemini-3-pro-preview");
  const [isModelDropdownOpen, setIsModelDropdownOpen] = useState(false);
  const [isRichText, setIsRichText] = useState(false);
  const [richTextContent, setRichTextContent] = useState("");
  const [isPromptAssistantOpen, setIsPromptAssistantOpen] = useState(false);
  const richTextRef = useRef<RichTextEditorRef>(null);
  const modelDropdownRef = useRef<HTMLDivElement>(null);

  const [selectedImage, setSelectedImage] = useState<{
    url: string;
    mimeType: string;
    data: string;
  } | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const models = useMemo(
    () => [
      // Gemini
      {
        id: "gemini-3-pro-preview",
        name: "Gemini 3 Pro",
        description: "Most intelligent Gemini model",
        provider: "gemini",
      },
      {
        id: "gemini-3-flash-preview",
        name: "Gemini 3 Flash",
        description: "Fast and versatile",
        provider: "gemini",
      },
      {
        id: "gemini-2.0-flash",
        name: "Gemini 2.0 Flash",
        description: "Fastest Gemini model",
        provider: "gemini",
      },
      // OpenAI
      {
        id: "gpt-5.2-codex",
        name: "GPT-5.2 Codex",
        description: "Best coding model, agentic tasks",
        provider: "openai",
      },
      {
        id: "gpt-5.2",
        name: "GPT-5.2",
        description: "Best for coding and agentic tasks",
        provider: "openai",
      },
      {
        id: "gpt-5-mini",
        name: "GPT-5 mini",
        description: "Faster, cost-efficient",
        provider: "openai",
      },
      {
        id: "gpt-5-nano",
        name: "GPT-5 nano",
        description: "Fastest, most cost-efficient",
        provider: "openai",
      },
      // Anthropic
      {
        id: "claude-opus-4-6",
        name: "Claude Opus 4.6",
        description: "Most intelligent Claude model",
        provider: "anthropic",
      },
      {
        id: "claude-sonnet-4-5",
        name: "Claude Sonnet 4.5",
        description: "Speed and intelligence balance",
        provider: "anthropic",
      },
      {
        id: "claude-haiku-4-5",
        name: "Claude Haiku 4.5",
        description: "Fastest Claude model",
        provider: "anthropic",
      },
    ],
    [],
  );

  const providerLabels: Record<string, string> = {
    gemini: "Gemini",
    openai: "OpenAI",
    anthropic: "Anthropic",
  };

  const groupedModels = models.reduce(
    (acc, model) => {
      if (!acc[model.provider]) acc[model.provider] = [];
      acc[model.provider].push(model);
      return acc;
    },
    {} as Record<string, typeof models>,
  );

  useEffect(() => {
    if (typeof window === "undefined") return;

    try {
      const storedModel = window.localStorage.getItem(
        SELECTED_MODEL_STORAGE_KEY,
      );
      if (storedModel && models.some((model) => model.id === storedModel)) {
        setSelectedModel(storedModel);
      }
    } catch (error) {
      console.warn("Failed to read selected model from localStorage:", error);
    }
  }, [models]);

  useEffect(() => {
    if (typeof window === "undefined") return;

    try {
      window.localStorage.setItem(SELECTED_MODEL_STORAGE_KEY, selectedModel);
    } catch (error) {
      console.warn("Failed to save selected model to localStorage:", error);
    }
  }, [selectedModel]);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        modelDropdownRef.current &&
        !modelDropdownRef.current.contains(event.target as Node)
      ) {
        setIsModelDropdownOpen(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, []);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const codeFileInputRef = useRef<HTMLInputElement>(null);
  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const nextStartTimeRef = useRef<number>(0);
  const useRefState = useRef<{ speakingMessageId: string | null }>({
    speakingMessageId: null,
  });

  // Ref to track input without triggering re-renders in callbacks
  const inputRef = useRef(input);
  useEffect(() => {
    inputRef.current = input;
  }, [input]);

  // Keep ref in sync for async loops
  useEffect(() => {
    useRefState.current.speakingMessageId = speakingMessageId;
  }, [speakingMessageId]);

  useEffect(() => {
    if (
      typeof window !== "undefined" &&
      ("SpeechRecognition" in window || "webkitSpeechRecognition" in window)
    ) {
      const SpeechRecognitionConstructor =
        (window as any).SpeechRecognition ||
        (window as any).webkitSpeechRecognition;
      const recognition = new (SpeechRecognitionConstructor as {
        new (): SpeechRecognition;
      })() as SpeechRecognition;
      recognition.continuous = true;
      recognition.interimResults = true;

      recognition.onresult = (event: SpeechRecognitionEvent) => {
        let transcript = "";
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const result = event.results[i];
          if (result) transcript += result[0].transcript;
        }
        setInput(transcript);
      };

      recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
        console.error("Speech recognition error:", event.error);
        setIsListening(false);
        setIsMicInitializing(false);
      };

      recognition.onstart = () => {
        console.log("Mic started listening");
        setTimeout(() => {
          setIsListening(true);
          setIsMicInitializing(false);
        }, 200);
      };

      recognition.onend = () => {
        setIsListening(false);
        setIsMicInitializing(false);
      };

      recognitionRef.current = recognition;
    }

    return () => {
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current = null;
      }
      if (audioContextRef.current) {
        audioContextRef.current.close();
        audioContextRef.current = null;
      }
      if (typeof window !== "undefined" && window.speechSynthesis) {
        window.speechSynthesis.cancel();
      }
    };
  }, []);

  const playAudioChunk = useCallback(
    async (base64Data: string, mimeType: string) => {
      try {
        if (
          !audioContextRef.current ||
          audioContextRef.current.state === "closed"
        ) {
          audioContextRef.current = new (
            window.AudioContext || (window as any).webkitAudioContext
          )();
          nextStartTimeRef.current = audioContextRef.current.currentTime;
        }

        const ctx = audioContextRef.current;

        if (ctx.state === "suspended") {
          await ctx.resume();
        }

        // Extract sample rate if available in mimeType (e.g., "audio/L16;rate=24000")
        let sampleRate = 24000;
        const rateMatch = mimeType.match(/rate=(\d+)/);
        if (rateMatch) {
          sampleRate = parseInt(rateMatch[1], 10);
        }

        const binaryString = window.atob(base64Data);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
          bytes[i] = binaryString.charCodeAt(i);
        }

        if (mimeType.includes("audio/L16")) {
          // Convert Int16 PCM to Float32
          const int16Array = new Int16Array(bytes.buffer);
          const float32Array = new Float32Array(int16Array.length);
          for (let i = 0; i < int16Array.length; i++) {
            float32Array[i] = int16Array[i] / 32768;
          }

          const audioBuffer = ctx.createBuffer(
            1,
            float32Array.length,
            sampleRate,
          );
          audioBuffer.getChannelData(0).set(float32Array);

          const source = ctx.createBufferSource();
          source.buffer = audioBuffer;
          source.connect(ctx.destination);

          const startTime = Math.max(
            nextStartTimeRef.current,
            ctx.currentTime + 0.1,
          );
          source.start(startTime);
          nextStartTimeRef.current = startTime + audioBuffer.duration;
        } else {
          console.warn("Unsupported streaming mimeType:", mimeType);
        }
      } catch (e) {
        console.error("Error playing audio chunk:", e);
      }
    },
    [],
  );

  const processSentence = useCallback(
    async (sentence: string, messageId: string) => {
      try {
        const response = await fetch("/api/generate-speech", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: sentence }),
        });

        if (!response.ok) return;
        if (!response.body) return;
        if (useRefState.current.speakingMessageId !== messageId) return;

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (useRefState.current.speakingMessageId !== messageId) {
            reader.cancel();
            break;
          }

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const data = JSON.parse(line);
              if (data.audio) {
                await playAudioChunk(data.audio, data.mimeType);
              }
            } catch (e) {
              console.error("Error parsing audio chunk:", e);
            }
          }
        }
      } catch (e) {
        console.error("Error in processSentence:", e);
      }
    },
    [playAudioChunk],
  );

  const handleSpeakError = useCallback(
    (err: any, text: string, messageId: string) => {
      if (err.message === "GEMINI_MODALITY_UNSUPPORTED") {
        console.warn(
          "Gemini native audio not supported. Using browser fallback.",
        );
      } else {
        console.error("Gemini Speech Error:", err);
      }

      setIsGeneratingSpeech(null);

      if (typeof window !== "undefined" && window.speechSynthesis) {
        const utterance = new SpeechSynthesisUtterance(text);
        utterance.onend = () => setSpeakingMessageId(null);
        setSpeakingMessageId(messageId);
        window.speechSynthesis.speak(utterance);
      }
    },
    [],
  );

  const stopSpeaking = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
    if (audioContextRef.current) {
      audioContextRef.current.close().catch(() => {});
      audioContextRef.current = null;
    }
    if (typeof window !== "undefined" && window.speechSynthesis) {
      window.speechSynthesis.cancel();
    }
    setSpeakingMessageId(null);
    useRefState.current.speakingMessageId = null;
    setIsGeneratingSpeech(null);
  }, []);

  const speak = useCallback(
    async (text: string, messageId: string) => {
      if (speakingMessageId === messageId || isGeneratingSpeech === messageId) {
        stopSpeaking();
        return;
      }

      stopSpeaking();
      setIsGeneratingSpeech(messageId);

      try {
        const cleanText = text
          .replace(/```[\s\S]*?```/g, "Code block omitted.")
          .replace(/[*#_~`]/g, "")
          .replace(/\$[^$]+\$/g, "formula");

        // Better sentence splitting
        const sentences = cleanText
          .match(/[^.!?]+[.!?]+|[^.!?]+/g)
          ?.map((s) => s.trim()) || [cleanText];

        setSpeakingMessageId(messageId);
        useRefState.current.speakingMessageId = messageId;
        setIsGeneratingSpeech(null);

        // Pre-fetch sentences in parallel to eliminate network delay between them
        const sentenceTasks = sentences
          .filter((s) => s && s.length > 0)
          .map((sentence) => ({
            promise: processSentence(sentence, messageId),
          }));

        // Await all tasks to ensure full playback in sequence
        for (const task of sentenceTasks) {
          if (useRefState.current.speakingMessageId !== messageId) break;
          await task.promise;
        }
      } catch (err: any) {
        handleSpeakError(err, text, messageId);
      }
    },
    [
      speakingMessageId,
      isGeneratingSpeech,
      stopSpeaking,
      processSentence,
      handleSpeakError,
    ],
  );

  const toggleListening = () => {
    if (!recognitionRef.current) {
      alert("Speech recognition is not supported in this browser.");
      return;
    }

    if (isListening) {
      try {
        recognitionRef.current.stop();
      } catch (err) {
        console.error("Error stopping recognition:", err);
        setIsListening(false);
      }
    } else {
      try {
        console.log("Starting mic initialization...");
        setIsMicInitializing(true);
        recognitionRef.current.start();
        setTimeout(() => {
          setIsMicInitializing((current) => {
            if (current) {
              console.warn("Mic initialization timed out");
              return false;
            }
            return current;
          });
        }, 3000);
      } catch (err) {
        console.error("Error starting recognition:", err);
        setIsMicInitializing(false);
        alert(
          "Could not start speech recognition. It might already be running or blocked.",
        );
      }
    }
  };

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  const isPromptAssistantOpenRef = useRef(false);
  useEffect(() => {
    isPromptAssistantOpenRef.current = isPromptAssistantOpen;
  }, [isPromptAssistantOpen]);

  useEffect(() => {
    if (!isPromptAssistantOpenRef.current) {
      scrollToBottom();
    }
  }, [messages]);

  const handleImageSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!file.type.startsWith("image/")) {
      alert("Please select an image file.");
      return;
    }

    const reader = new FileReader();
    reader.onload = (event) => {
      const base64String = (event.target?.result as string).split(",")[1];
      setSelectedImage({
        url: URL.createObjectURL(file),
        mimeType: file.type,
        data: base64String,
      });
    };
    reader.readAsDataURL(file);
  };

  const handleCodeUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      const content = event.target?.result as string;

      // Create a user message saying we uploaded a file
      const userMessage: Message = {
        id: Date.now().toString(),
        role: "user",
        content: `Uploaded ${file.name} for preview.`,
        type: "text",
      };

      // Create an assistant message with the code block to trigger preview
      const assistantMessage: Message = {
        id: (Date.now() + 1).toString(),
        role: "assistant",
        content: `Here is the preview for \`${file.name}\`:\n\n\`\`\`tsx\n${content}\n\`\`\``,
        type: "text",
      };

      setMessages((prev) => [...prev, userMessage, assistantMessage]);
    };
    reader.readAsText(file);
    // Reset input so same file can be selected again
    e.target.value = "";
  };

  const handleSubmit = useCallback(
    async (e?: React.FormEvent, isImage = false, overrideInput?: string) => {
      if (e) e.preventDefault();
      const richContent = isRichText
        ? richTextRef.current?.getMarkdown() || ""
        : "";
      const messageInput =
        overrideInput || (isRichText ? richContent : inputRef.current);
      if ((!messageInput.trim() && !selectedImage) || isLoading) return;

      const userMessage: Message = {
        id: Date.now().toString(),
        role: "user",
        content: messageInput,
        type: "text",
        attachments: selectedImage ? [selectedImage] : undefined,
      };

      setMessages((prev) => [...prev, userMessage]);
      if (!overrideInput) {
        setInput("");
        if (isRichText) richTextRef.current?.clear();
      }
      setSelectedImage(null);
      setIsLoading(true);

      try {
        if (isImage || messageInput.toLowerCase().startsWith("/image ")) {
          const prompt = messageInput.toLowerCase().startsWith("/image ")
            ? messageInput.slice(7)
            : messageInput;

          const response = await fetch("/api/generate-image", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ prompt }),
          });

          const data = await response.json();
          if (data.error) throw new Error(data.error);

          const assistantMessage: Message = {
            id: (Date.now() + 1).toString(),
            role: "assistant",
            content: `Generated image for: ${prompt}`,
            type: "image",
            imageUrl:
              data.imageUrl || data.url || (data.images && data.images[0]),
          };
          setMessages((prev) => [...prev, assistantMessage]);
        } else {
          const response = await fetch("/api/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              model: selectedModel,
              messages: [...messages, userMessage].map((m) => ({
                role: m.role,
                content: m.content,
                attachments: m.attachments,
              })),
            }),
          });

          if (!response.ok) throw new Error("Failed to get response");
          if (!response.body) throw new Error("No response body");

          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let assistantContent = "";

          const assistantMessageId = (Date.now() + 1).toString();
          const assistantMessage: Message = {
            id: assistantMessageId,
            role: "assistant",
            content: "",
            type: "text",
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
                  : msg,
              ),
            );
          }
        }
      } catch (error: unknown) {
        console.error(error);
        const errorMessage =
          error instanceof Error ? error.message : "An unknown error occurred";
        setMessages((prev) => [
          ...prev,
          {
            id: (Date.now() + 1).toString(),
            role: "assistant",
            content: `Error: ${errorMessage}`,
            type: "text",
          },
        ]);
      } finally {
        setIsLoading(false);
      }
    },
    [selectedImage, isLoading, messages, selectedModel, isRichText],
  );

  const handleDebug = useCallback(
    (error: string, code: string, language: string) => {
      const debugPrompt = `I'm getting a runtime error in the following code:\n\n\`\`\`${language}\n${code}\n\`\`\`\n\nError:\n\`\`\`\n${error}\n\`\`\`\n\nPlease fix the code and provide the corrected version.`;
      handleSubmit(undefined, false, debugPrompt);
    },
    [handleSubmit],
  );

  const handleKeepDraft = useCallback(
    (draft: string) => {
      if (isRichText) {
        richTextRef.current?.setContent(draft);
        setRichTextContent(draft);
      } else {
        // Switch to rich text mode and set content after editor mounts
        setIsRichText(true);
        setInput(draft); // initialContent will pick this up on mount
        // Also set via ref after a short delay to ensure the editor is ready
        setTimeout(() => {
          richTextRef.current?.setContent(draft);
          setRichTextContent(draft);
        }, 100);
      }
      setIsPromptAssistantOpen(false);
    },
    [isRichText],
  );

  return (
    <div className="flex h-[100dvh] w-full max-w-5xl flex-col overflow-hidden border border-zinc-200 bg-white shadow-xl dark:border-zinc-800 dark:bg-zinc-900 sm:h-[90vh] sm:rounded-2xl">
      {/* Header */}
      <div className="flex flex-col gap-3 border-b border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-900/50 sm:flex-row sm:items-center sm:justify-between sm:p-4">
        <div className="flex min-w-0 items-center gap-2">
          <div className="p-2 bg-blue-500 rounded-lg">
            <Sparkles className="w-5 h-5 text-white" />
          </div>
          <div className="min-w-0">
            <h2 className="truncate font-bold text-zinc-900 dark:text-zinc-100">
              AI Chat & NanoBanana
            </h2>
            <p className="truncate text-xs text-zinc-500 dark:text-zinc-400">
              Chat, Code, and Generate Images
            </p>
          </div>
        </div>

        <div className="relative w-full sm:w-auto" ref={modelDropdownRef}>
          <button
            onClick={() => setIsModelDropdownOpen(!isModelDropdownOpen)}
            className="flex w-full items-center justify-between gap-2 rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm font-medium transition-colors hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-800 dark:hover:bg-zinc-700/50 sm:w-auto sm:justify-start sm:py-1.5"
          >
            <span className="truncate">
              {models.find((m) => m.id === selectedModel)?.name}
            </span>
            <ChevronDown
              className={`w-4 h-4 transition-transform ${isModelDropdownOpen ? "rotate-180" : ""}`}
            />
          </button>

          <AnimatePresence>
            {isModelDropdownOpen && (
              <motion.div
                initial={{ opacity: 0, y: -10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                className="absolute left-0 right-0 top-full z-50 mt-2 max-h-[70vh] overflow-y-auto overflow-x-hidden rounded-xl border border-zinc-200 bg-white shadow-xl dark:border-zinc-700 dark:bg-zinc-800 sm:left-auto sm:right-0 sm:w-72"
              >
                {Object.entries(groupedModels).map(
                  ([provider, providerModels], groupIndex) => (
                    <div key={provider}>
                      {groupIndex > 0 && (
                        <div className="border-t border-zinc-200 dark:border-zinc-700" />
                      )}
                      <div className="px-4 py-2 text-xs font-semibold text-zinc-400 dark:text-zinc-500 uppercase tracking-wider bg-zinc-50/50 dark:bg-zinc-900/50">
                        {providerLabels[provider] || provider}
                      </div>
                      {providerModels.map((model) => (
                        <button
                          key={model.id}
                          onClick={() => {
                            setSelectedModel(model.id);
                            setIsModelDropdownOpen(false);
                          }}
                          className={cn(
                            "w-full text-left px-4 py-3 hover:bg-zinc-50 dark:hover:bg-zinc-700/50 transition-colors flex flex-col gap-0.5",
                            selectedModel === model.id &&
                              "bg-blue-50 dark:bg-blue-900/20",
                          )}
                        >
                          <span
                            className={cn(
                              "text-sm font-medium",
                              selectedModel === model.id
                                ? "text-blue-600 dark:text-blue-400"
                                : "text-zinc-900 dark:text-zinc-100",
                            )}
                          >
                            {model.name}
                          </span>
                          <span className="text-xs text-zinc-500 dark:text-zinc-400">
                            {model.description}
                          </span>
                        </button>
                      ))}
                    </div>
                  ),
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 space-y-6 overflow-y-auto p-3 sm:p-4">
        {messages.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center space-y-2 px-3 text-center text-sm text-zinc-400 sm:text-base">
            <Bot className="w-12 h-12 opacity-20" />
            <p>Start a conversation, write some code, or generate an image</p>
            <div className="flex flex-wrap justify-center gap-2 mt-4">
              <button
                onClick={() => setInput("Build a simple calculator in React")}
                className="px-3 py-1.5 rounded-full bg-zinc-100 dark:bg-zinc-800 text-xs hover:bg-zinc-200 dark:hover:bg-zinc-700 transition-colors"
              >
                &quot;Build a simple calculator in React&quot;
              </button>
              <button
                onClick={() =>
                  setInput(
                    "Create a beautiful landing page header in HTML/Tailwind",
                  )
                }
                className="px-3 py-1.5 rounded-full bg-zinc-100 dark:bg-zinc-800 text-xs hover:bg-zinc-200 dark:hover:bg-zinc-700 transition-colors"
              >
                &quot;Create a landing page header&quot;
              </button>
              <button
                onClick={() =>
                  setInput("/image a futuristic neon city skyline")
                }
                className="px-3 py-1.5 rounded-full bg-zinc-100 dark:bg-zinc-800 text-xs hover:bg-zinc-200 dark:hover:bg-zinc-700 transition-colors"
              >
                &quot;/image futuristic city&quot;
              </button>
            </div>
          </div>
        )}
        <AnimatePresence initial={false}>
          {messages.map((m) => (
            <MessageItem
              key={m.id}
              m={m}
              isSpeaking={speakingMessageId === m.id}
              isGeneratingSpeech={isGeneratingSpeech === m.id}
              onSpeak={speak}
              onDebug={handleDebug}
            />
          ))}
        </AnimatePresence>
        {isLoading && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="flex gap-4"
          >
            <div className="w-8 h-8 rounded-full bg-blue-100 dark:bg-blue-900/30 flex items-center justify-center">
              <Bot className="w-5 h-5 text-blue-600 dark:text-blue-400" />
            </div>
            <div className="bg-zinc-100 dark:bg-zinc-800 rounded-2xl p-5 rounded-tl-none">
              <div className="flex gap-1.5">
                <motion.div
                  animate={{ scale: [1, 1.2, 1] }}
                  transition={{ repeat: Infinity, duration: 1, delay: 0 }}
                  className="w-2 h-2 bg-blue-500 rounded-full"
                />
                <motion.div
                  animate={{ scale: [1, 1.2, 1] }}
                  transition={{ repeat: Infinity, duration: 1, delay: 0.2 }}
                  className="w-2 h-2 bg-blue-500 rounded-full"
                />
                <motion.div
                  animate={{ scale: [1, 1.2, 1] }}
                  transition={{ repeat: Infinity, duration: 1, delay: 0.4 }}
                  className="w-2 h-2 bg-blue-500 rounded-full"
                />
              </div>
            </div>
          </motion.div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <form
        onSubmit={(e) => handleSubmit(e)}
        className="border-t border-zinc-200 bg-zinc-50 p-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] dark:border-zinc-800 dark:bg-zinc-900/50 sm:p-4"
      >
        {selectedImage && (
          <div className="mb-4 relative inline-block">
            <img
              src={selectedImage.url}
              alt="Selected image for analysis"
              className="h-20 w-auto rounded-lg border border-zinc-200 dark:border-zinc-700 shadow-sm"
              loading="lazy"
            />
            <button
              type="button"
              onClick={() => setSelectedImage(null)}
              className="absolute -top-2 -right-2 bg-red-500 text-white rounded-full p-1 shadow-md hover:bg-red-600 transition-colors"
            >
              <X className="w-3 h-3" />
            </button>
          </div>
        )}
        <div className="relative flex flex-col gap-3">
          <input
            type="file"
            ref={fileInputRef}
            onChange={handleImageSelect}
            accept="image/*"
            className="hidden"
          />
          <input
            type="file"
            ref={codeFileInputRef}
            onChange={handleCodeUpload}
            accept=".tsx,.jsx,.js,.ts,.html"
            className="hidden"
          />
          <div className="flex flex-wrap items-center gap-1.5 sm:gap-2">
            <button
              type="button"
              onClick={toggleListening}
              className={cn(
                "flex h-11 w-11 items-center justify-center rounded-xl transition-all sm:h-10 sm:w-10",
                isListening
                  ? "bg-red-50 text-red-500 dark:bg-red-900/20"
                  : isMicInitializing
                    ? "bg-amber-50 text-amber-500 dark:bg-amber-900/20"
                    : "text-zinc-500 hover:bg-blue-50 hover:text-blue-600 dark:hover:bg-blue-900/20",
              )}
              title={
                isListening
                  ? "Stop Listening"
                  : isMicInitializing
                    ? "Initializing Mic..."
                    : "Start Voice Input"
              }
            >
              {isMicInitializing ? (
                <Loader2 className="h-5 w-5 animate-spin" />
              ) : isListening ? (
                <Mic className="h-5 w-5 animate-pulse" />
              ) : (
                <Mic className="h-5 w-5" />
              )}
            </button>
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="flex h-11 w-11 items-center justify-center rounded-xl text-zinc-500 transition-all hover:bg-blue-50 hover:text-blue-600 dark:hover:bg-blue-900/20 sm:h-10 sm:w-10"
              title="Upload Image"
            >
              <Paperclip className="h-5 w-5" />
            </button>
            <button
              type="button"
              onClick={() => codeFileInputRef.current?.click()}
              className="flex h-11 w-11 items-center justify-center rounded-xl text-zinc-500 transition-all hover:bg-blue-50 hover:text-blue-600 dark:hover:bg-blue-900/20 sm:h-10 sm:w-10"
              title="Upload Code for Preview"
            >
              <Upload className="h-5 w-5" />
            </button>
            <button
              type="button"
              onClick={(e) => handleSubmit(e as unknown as React.FormEvent, true)}
              className="flex h-11 w-11 items-center justify-center rounded-xl text-zinc-500 transition-all hover:bg-blue-50 hover:text-blue-600 dark:hover:bg-blue-900/20 sm:h-10 sm:w-10"
              title="Generate Image"
            >
              <ImageIcon className="h-5 w-5" />
            </button>
            <button
              type="button"
              onClick={() => {
                setIsRichText((prev) => {
                  if (prev) {
                    // Switching from rich to plain: pull content as markdown
                    const md = richTextRef.current?.getMarkdown() || "";
                    setInput(md);
                  }
                  return !prev;
                });
              }}
              className={cn(
                "flex h-11 w-11 items-center justify-center rounded-xl transition-all sm:h-10 sm:w-10",
                isRichText
                  ? "bg-blue-50 text-blue-600 dark:bg-blue-900/20"
                  : "text-zinc-500 hover:bg-blue-50 hover:text-blue-600 dark:hover:bg-blue-900/20",
              )}
              title={
                isRichText ? "Switch to plain text" : "Switch to rich text editor"
              }
            >
              <Type className="h-5 w-5" />
            </button>
            <button
              type="button"
              onClick={() => setIsPromptAssistantOpen(true)}
              className="flex h-11 w-11 items-center justify-center rounded-xl text-zinc-500 transition-all hover:bg-purple-50 hover:text-purple-600 dark:hover:bg-purple-900/20 sm:h-10 sm:w-10"
              title="Prompt Assistant"
            >
              <Wand2 className="h-5 w-5" />
            </button>
          </div>
          <div className="flex min-w-0 items-end gap-2">
            {isRichText ? (
              <RichTextEditor
                ref={richTextRef}
                placeholder="Type a message with rich formatting..."
                onSubmit={() => handleSubmit()}
                onChange={(md) => setRichTextContent(md)}
                initialContent={input}
              />
            ) : (
              <input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="Type a message, ask for code, or use /image..."
                className="min-w-0 flex-1 rounded-xl border border-zinc-200 bg-white px-4 py-3 text-sm outline-none transition-all focus:border-transparent focus:ring-2 focus:ring-blue-500 dark:border-zinc-700 dark:bg-zinc-800"
              />
            )}
            <button
              type="submit"
              disabled={
                (!(isRichText ? richTextContent.trim() : input.trim()) &&
                  !selectedImage) ||
                isLoading
              }
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-blue-600 text-white shadow-lg shadow-blue-500/20 transition-all hover:bg-blue-700 disabled:opacity-50 disabled:hover:bg-blue-600 sm:h-12 sm:w-12"
            >
              <Send className="h-5 w-5" />
            </button>
          </div>
        </div>
      </form>

      {/* Prompt Assistant Modal */}
      <PromptAssistant
        isOpen={isPromptAssistantOpen}
        onClose={() => setIsPromptAssistantOpen(false)}
        onKeep={handleKeepDraft}
        selectedModel={selectedModel}
      />
    </div>
  );
}
