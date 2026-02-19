import { memo } from "react";
import { motion } from "framer-motion";
import { User, Bot, Loader2, Volume2, Square } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { vscDarkPlus } from "react-syntax-highlighter/dist/esm/styles/prism";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import CodePreview from "./CodePreview";

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export type Message = {
  id: string;
  role: "user" | "assistant";
  content: string;
  type: "text" | "image";
  imageUrl?: string;
  attachments?: {
    url: string;
    mimeType: string;
    data?: string; // base64 for user uploads
    assetKey?: string;
  }[];
};

interface MessageItemProps {
  m: Message;
  isSpeaking: boolean;
  isGeneratingSpeech: boolean;
  onSpeak: (text: string, id: string) => void;
  onDebug: (error: string, code: string, language: string) => void;
}

const MessageItem = memo(({ m, isSpeaking, isGeneratingSpeech, onSpeak, onDebug }: MessageItemProps) => {
  const assistantHasCodeBlock =
    m.role === "assistant" && m.type === "text" && /```[\s\S]*?```/.test(m.content);

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className={cn(
        "flex gap-2.5 sm:gap-4",
        m.role === "user" ? "flex-row-reverse" : "flex-row",
      )}
    >
      <div
        className={cn(
          "mt-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-full sm:h-8 sm:w-8",
          m.role === "user"
            ? "bg-zinc-200 dark:bg-zinc-700"
            : "bg-blue-100 dark:bg-blue-900/30",
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
          "min-w-0 rounded-2xl p-3 sm:p-4",
          m.role === "user"
            ? "max-w-[92%] rounded-tr-none bg-blue-600 text-white sm:max-w-[85%]"
            : "bg-zinc-100 dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 rounded-tl-none w-full min-w-0",
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
                  className="h-auto w-full max-w-full rounded-lg border border-white/20 sm:w-auto sm:max-w-50"
                  loading="lazy"
                />
              ))}
            </div>
          )}
        {m.type === "text" ? (
          <div className="space-y-3">
            <div className="prose prose-sm max-w-none break-words dark:prose-invert">
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
                        assets={m.role === "assistant" ? m.attachments : undefined}
                        onDebug={onDebug}
                      />
                    );
                  }

                  if (!inline && language) {
                    return (
                      <div className="my-4 overflow-x-auto rounded-lg">
                        <SyntaxHighlighter
                          style={vscDarkPlus}
                          language={language}
                          PreTag="div"
                          showLineNumbers={true}
                          wrapLines={true}
                          className="gemini-code-block"
                          lineNumberStyle={{
                            color: "#6e7681",
                            minWidth: "2em",
                            paddingRight: "1em",
                            userSelect: "none",
                          }}
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
                        className,
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
            {m.role === "assistant" &&
              m.attachments &&
              m.attachments.length > 0 &&
              !assistantHasCodeBlock && (
                <div className="grid gap-3 sm:grid-cols-2">
                  {m.attachments.map((attachment, idx) => (
                    <div key={idx} className="relative group">
                      <img
                        src={attachment.url}
                        alt={`Generated AI asset ${idx + 1}`}
                        className="rounded-xl w-full h-auto shadow-md transition-transform group-hover:scale-[1.01]"
                        loading="lazy"
                      />
                      <a
                        href={attachment.url}
                        download={`generated-asset-${idx + 1}.png`}
                        className="absolute bottom-2 right-2 p-2 bg-black/50 text-white rounded-lg opacity-0 group-hover:opacity-100 transition-opacity"
                      >
                        Download
                      </a>
                    </div>
                  ))}
                </div>
              )}
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
              onClick={() => onSpeak(m.content, m.id)}
              disabled={isGeneratingSpeech}
              className={cn(
                "flex items-center gap-1.5 px-2 py-1 rounded-md text-[10px] font-medium transition-all",
                isSpeaking
                  ? "bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400"
                  : "text-zinc-500 hover:bg-zinc-200 dark:hover:bg-zinc-700",
              )}
              title={
                isGeneratingSpeech
                  ? "Generating Gemini voice..."
                  : isSpeaking
                    ? "Stop reading"
                    : "Read aloud with Gemini"
              }
            >
              {isGeneratingSpeech ? (
                <>
                  <Loader2 className="w-3 h-3 animate-spin" />
                  LOADING...
                </>
              ) : isSpeaking ? (
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
  );
});

MessageItem.displayName = "MessageItem";

export default MessageItem;
