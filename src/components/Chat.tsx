"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import {
  Send,
  Image as ImageIcon,
  Loader2,
  User,
  Bot,
  Sparkles,
  Paperclip,
  X,
  Mic,
  Volume2,
  Square,
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { vscDarkPlus } from "react-syntax-highlighter/dist/esm/styles/prism";
import CodePreview from "./CodePreview";

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

type Message = {
  id: string;
  role: "user" | "assistant";
  content: string;
  type: "text" | "image";
  imageUrl?: string;
  attachments?: {
    url: string;
    mimeType: string;
    data: string; // base64
  }[];
};

export default function Chat() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [isMicInitializing, setIsMicInitializing] = useState(false);
  const [speakingMessageId, setSpeakingMessageId] = useState<string | null>(
    null
  );
  const [isGeneratingSpeech, setIsGeneratingSpeech] = useState<string | null>(
    null
  );
  const [selectedImage, setSelectedImage] = useState<{
    url: string;
    mimeType: string;
    data: string;
  } | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

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
      if (typeof window !== "undefined" && window.speechSynthesis) {
        window.speechSynthesis.cancel();
      }
    };
  }, []);

  const speak = async (text: string, messageId: string) => {
    if (speakingMessageId === messageId || isGeneratingSpeech === messageId) {
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current = null;
      }
      if (typeof window !== "undefined" && window.speechSynthesis) {
        window.speechSynthesis.cancel();
      }
      setSpeakingMessageId(null);
      setIsGeneratingSpeech(null);
      return;
    }

    // Stop current audio
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
    if (typeof window !== "undefined" && window.speechSynthesis) {
      window.speechSynthesis.cancel();
    }
    setSpeakingMessageId(null);

    setIsGeneratingSpeech(messageId);

    try {
      const cleanText = text
        .replace(/```[\s\S]*?```/g, "Code block omitted.")
        .replace(/[*#_~`]/g, "")
        .replace(/\$[^$]+\$/g, "formula");

      const response = await fetch("/api/generate-speech", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: cleanText }),
      });

      const data = await response.json();

      if (data.error === "GEMINI_MODALITY_UNSUPPORTED") {
        console.warn(
          "Gemini native audio not supported. Using browser fallback."
        );
        const utterance = new SpeechSynthesisUtterance(text);
        utterance.onend = () => setSpeakingMessageId(null);
        setSpeakingMessageId(messageId);
        window.speechSynthesis.speak(utterance);
        setIsGeneratingSpeech(null);
        return;
      }

      if (data.error) {
        throw new Error(data.error);
      }

      if (!data.audioContent) {
        throw new Error("No audio content received from Gemini");
      }

      console.log("Gemini audio type:", data.mimeType);

      // Robust base64 to blob conversion
      const binaryString = window.atob(data.audioContent);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }
      const audioBlob = new Blob([bytes], { type: data.mimeType });
      const audioUrl = URL.createObjectURL(audioBlob);

      const audio = new Audio(audioUrl);
      audioRef.current = audio;

      audio.onended = () => {
        setSpeakingMessageId(null);
        audioRef.current = null;
      };

      audio.onerror = () => {
        setSpeakingMessageId(null);
        audioRef.current = null;
      };

      setIsGeneratingSpeech(null);
      setSpeakingMessageId(messageId);
      audio.play();
    } catch (err: any) {
      if (err.message !== "GEMINI_MODALITY_UNSUPPORTED") {
        console.error("Gemini Speech Error:", err);
      }
      setIsGeneratingSpeech(null);

      // Fallback logic
      if (
        typeof window !== "undefined" &&
        window.speechSynthesis &&
        err.message !== "GEMINI_MODALITY_UNSUPPORTED"
      ) {
        const utterance = new SpeechSynthesisUtterance(text);
        utterance.onend = () => setSpeakingMessageId(null);
        setSpeakingMessageId(messageId);
        window.speechSynthesis.speak(utterance);
      }
    }
  };

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
          "Could not start speech recognition. It might already be running or blocked."
        );
      }
    }
  };

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
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

  const handleSubmit = useCallback(
    async (e?: React.FormEvent, isImage = false, overrideInput?: string) => {
      if (e) e.preventDefault();
      const messageInput = overrideInput || input;
      if ((!messageInput.trim() && !selectedImage) || isLoading) return;

      const userMessage: Message = {
        id: Date.now().toString(),
        role: "user",
        content: messageInput,
        type: "text",
        attachments: selectedImage ? [selectedImage] : undefined,
      };

      setMessages((prev) => [...prev, userMessage]);
      if (!overrideInput) setInput("");
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
              messages: [...messages, userMessage].map((m) => ({
                role: m.role,
                content: m.content,
                attachments: m.attachments,
              })),
            }),
          });

          const data = await response.json();
          if (data.error) throw new Error(data.error);

          const assistantMessage: Message = {
            id: (Date.now() + 1).toString(),
            role: "assistant",
            content: data.content,
            type: data.type || "text",
            imageUrl: data.imageUrl,
          };
          setMessages((prev) => [...prev, assistantMessage]);
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
    [input, selectedImage, isLoading, messages]
  );

  const handleDebug = useCallback(
    (error: string) => {
      const debugPrompt = `I'm getting a runtime error in the code you provided:\n\n\`\`\`\n${error}\n\`\`\`\n\nPlease fix the code and provide the corrected version.`;
      handleSubmit(undefined, false, debugPrompt);
    },
    [handleSubmit]
  );

  return (
    <div className="flex flex-col h-[90vh] w-full max-w-5xl mx-auto bg-white dark:bg-zinc-900 rounded-2xl shadow-xl overflow-hidden border border-zinc-200 dark:border-zinc-800">
      {/* Header */}
      <div className="p-4 border-b border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900/50 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="p-2 bg-blue-500 rounded-lg">
            <Sparkles className="w-5 h-5 text-white" />
          </div>
          <div>
            <h2 className="font-bold text-zinc-900 dark:text-zinc-100">
              Gemini & NanoBanana
            </h2>
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              Chat, Code, and Generate Images
            </p>
          </div>
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-4 space-y-6">
        {messages.length === 0 && (
          <div className="h-full flex flex-col items-center justify-center text-zinc-400 space-y-2">
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
                    "Create a beautiful landing page header in HTML/Tailwind"
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
            <motion.div
              key={m.id}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              className={cn(
                "flex gap-4",
                m.role === "user" ? "flex-row-reverse" : "flex-row"
              )}
            >
              <div
                className={cn(
                  "w-8 h-8 rounded-full flex items-center justify-center shrink-0 mt-1",
                  m.role === "user"
                    ? "bg-zinc-200 dark:bg-zinc-700"
                    : "bg-blue-100 dark:bg-blue-900/30"
                )}
              >
                {m.role === "user" ? (
                  <User className="w-5 h-5" />
                ) : (
                  <Bot className="w-5 h-5 text-blue-600 dark:text-blue-400" />
                )}
              </div>
              <div
                className={cn(
                  "max-w-[85%] rounded-2xl p-4",
                  m.role === "user"
                    ? "bg-blue-600 text-white rounded-tr-none"
                    : "bg-zinc-100 dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 rounded-tl-none"
                )}
              >
                {m.role === "user" &&
                  m.attachments &&
                  m.attachments.length > 0 && (
                    <div className="flex flex-wrap gap-2 mb-2">
                      {m.attachments.map((attachment, idx) => (
                        <img
                          key={idx}
                          src={attachment.url}
                          alt="User uploaded content"
                          className="max-w-50 h-auto rounded-lg border border-white/20"
                          loading="lazy"
                        />
                      ))}
                    </div>
                  )}
                {m.type === "text" ? (
                  <div className="prose prose-sm dark:prose-invert max-w-none">
                    <ReactMarkdown
                      remarkPlugins={[remarkGfm, remarkMath]}
                      rehypePlugins={[rehypeKatex]}
                      components={{
                        code({
                          inline,
                          className,
                          children,
                          ...props
                        }: {
                          inline?: boolean;
                          className?: string;
                          children?: React.ReactNode;
                        }) {
                          const match = /language-(\w+)/.exec(className || "");
                          const language = match ? match[1] : "";
                          const code = String(children).replace(/\n$/, "");

                          const isPreviewable = [
                            "html",
                            "jsx",
                            "tsx",
                            "javascript",
                            "typescript",
                          ].includes(language);

                          if (!inline && isPreviewable) {
                            return (
                              <CodePreview
                                code={code}
                                language={language}
                                title={`${language.toUpperCase()} Artifact`}
                                onDebug={handleDebug}
                              />
                            );
                          }

                          if (!inline && language) {
                            return (
                              <div className="rounded-lg overflow-hidden my-4">
                                <SyntaxHighlighter
                                  style={vscDarkPlus}
                                  language={language}
                                  PreTag="div"
                                  {...props}
                                >
                                  {code}
                                </SyntaxHighlighter>
                              </div>
                            );
                          }

                          return (
                            <code
                              className={cn(
                                "bg-zinc-200 dark:bg-zinc-700 px-1 rounded",
                                className
                              )}
                              {...props}
                            >
                              {children}
                            </code>
                          );
                        },
                        // Fix list rendering in markdown
                        ul: ({ children }) => (
                          <ul className="list-disc ml-4 space-y-1">
                            {children}
                          </ul>
                        ),
                        ol: ({ children }) => (
                          <ol className="list-decimal ml-4 space-y-1">
                            {children}
                          </ol>
                        ),
                        p: ({ children }) => (
                          <p className="mb-2 last:mb-0">{children}</p>
                        ),
                      }}
                    >
                      {m.content}
                    </ReactMarkdown>
                  </div>
                ) : (
                  <div className="space-y-3">
                    <p className="text-sm opacity-80">{m.content}</p>
                    {m.imageUrl ? (
                      <div className="relative group">
                        <img
                          src={m.imageUrl}
                          alt="Generated AI artwork"
                          className="rounded-xl w-full h-auto shadow-md transition-transform group-hover:scale-[1.01]"
                          loading="lazy"
                        />
                        <a
                          href={m.imageUrl}
                          download="generated-image.png"
                          className="absolute bottom-2 right-2 p-2 bg-black/50 text-white rounded-lg opacity-0 group-hover:opacity-100 transition-opacity"
                        >
                          Download
                        </a>
                      </div>
                    ) : (
                      <div className="flex items-center gap-3 p-6 bg-zinc-200 dark:bg-zinc-700 rounded-xl">
                        <Loader2 className="w-5 h-5 animate-spin text-blue-500" />
                        <span className="text-sm font-medium">
                          Brewing your image...
                        </span>
                      </div>
                    )}
                  </div>
                )}
                {m.role === "assistant" && m.type === "text" && (
                  <div className="mt-3 pt-3 border-t border-zinc-200 dark:border-zinc-700/50 flex justify-end">
                    <button
                      onClick={() => speak(m.content, m.id)}
                      disabled={isGeneratingSpeech === m.id}
                      className={cn(
                        "flex items-center gap-1.5 px-2 py-1 rounded-md text-[10px] font-medium transition-all",
                        speakingMessageId === m.id
                          ? "bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400"
                          : "text-zinc-500 hover:bg-zinc-200 dark:hover:bg-zinc-700"
                      )}
                      title={
                        isGeneratingSpeech === m.id
                          ? "Generating Gemini voice..."
                          : speakingMessageId === m.id
                          ? "Stop reading"
                          : "Read aloud with Gemini"
                      }
                    >
                      {isGeneratingSpeech === m.id ? (
                        <>
                          <Loader2 className="w-3 h-3 animate-spin" />
                          LOADING...
                        </>
                      ) : speakingMessageId === m.id ? (
                        <>
                          <Square className="w-3 h-3 fill-current" />
                          STOP
                        </>
                      ) : (
                        <>
                          <Volume2 className="w-3 h-3" />
                          GEMINI SPEAK
                        </>
                      )}
                    </button>
                  </div>
                )}
              </div>
            </motion.div>
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
        className="p-4 bg-zinc-50 dark:bg-zinc-900/50 border-t border-zinc-200 dark:border-zinc-800"
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
        <div className="relative flex items-center gap-3">
          <input
            type="file"
            ref={fileInputRef}
            onChange={handleImageSelect}
            accept="image/*"
            className="hidden"
          />
          <button
            type="button"
            onClick={toggleListening}
            className={cn(
              "p-2.5 rounded-xl transition-all",
              isListening
                ? "text-red-500 bg-red-50 dark:bg-red-900/20"
                : isMicInitializing
                ? "text-amber-500 bg-amber-50 dark:bg-amber-900/20"
                : "text-zinc-500 hover:text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-900/20"
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
              <Loader2 className="w-5 h-5 animate-spin" />
            ) : isListening ? (
              <Mic className="w-5 h-5 animate-pulse" />
            ) : (
              <Mic className="w-5 h-5" />
            )}
          </button>
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="p-2.5 text-zinc-500 hover:text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-900/20 rounded-xl transition-all"
            title="Upload Image"
          >
            <Paperclip className="w-5 h-5" />
          </button>
          <button
            type="button"
            onClick={(e) => handleSubmit(e as unknown as React.FormEvent, true)}
            className="p-2.5 text-zinc-500 hover:text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-900/20 rounded-xl transition-all"
            title="Generate Image"
          >
            <ImageIcon className="w-5 h-5" />
          </button>
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Type a message, ask for code, or use /image..."
            className="flex-1 bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-xl px-4 py-3 text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none shadow-sm transition-all"
          />
          <button
            type="submit"
            disabled={(!input.trim() && !selectedImage) || isLoading}
            className="p-3 bg-blue-600 text-white rounded-xl hover:bg-blue-700 disabled:opacity-50 disabled:hover:bg-blue-600 shadow-lg shadow-blue-500/20 transition-all"
          >
            <Send className="w-5 h-5" />
          </button>
        </div>
      </form>
    </div>
  );
}
