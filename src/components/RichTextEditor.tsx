"use client";

import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import {
  Bold,
  Italic,
  Strikethrough,
  Code,
  List,
  ListOrdered,
  Quote,
  Undo,
  Redo,
  Heading2,
  CodeSquare,
  Maximize2,
  Minimize2,
  Send,
} from "lucide-react";
import { useEffect, useImperativeHandle, forwardRef, useState, useCallback } from "react";

export interface RichTextEditorRef {
  getMarkdown: () => string;
  clear: () => void;
  focus: () => void;
  setContent: (content: string) => void;
}

interface RichTextEditorProps {
  placeholder?: string;
  onSubmit?: () => void;
  onChange?: (markdown: string) => void;
  initialContent?: string;
}

interface ToolbarButtonProps {
  onClick: () => void;
  isActive?: boolean;
  children: React.ReactNode;
  title: string;
}

function ToolbarButton({
  onClick,
  isActive,
  children,
  title,
}: ToolbarButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={`flex h-10 w-10 items-center justify-center rounded-md transition-colors sm:h-8 sm:w-8 ${
        isActive
          ? "bg-blue-100 dark:bg-blue-900/40 text-blue-600 dark:text-blue-400"
          : "text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-700/50"
      }`}
    >
      {children}
    </button>
  );
}

// Convert Markdown to HTML for TipTap consumption
function markdownToHtml(md: string): string {
  // Process the markdown line by line, building HTML
  const lines = md.split("\n");
  let html = "";
  let inCodeBlock = false;
  let inList: "ul" | "ol" | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Code blocks (```)
    if (line.trimStart().startsWith("```")) {
      if (inCodeBlock) {
        html += "</code></pre>";
        inCodeBlock = false;
      } else {
        if (inList) {
          html += inList === "ul" ? "</ul>" : "</ol>";
          inList = null;
        }
        inCodeBlock = true;
        html += "<pre><code>";
      }
      continue;
    }
    if (inCodeBlock) {
      html += escapeHtml(line) + "\n";
      continue;
    }

    // Empty line: close list if open, skip
    if (line.trim() === "") {
      if (inList) {
        html += inList === "ul" ? "</ul>" : "</ol>";
        inList = null;
      }
      continue;
    }

    // Apply inline formatting to a string
    const inline = (text: string): string => {
      let result = escapeHtml(text);
      // Bold: **text** or __text__
      result = result.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
      result = result.replace(/__(.+?)__/g, "<strong>$1</strong>");
      // Italic: *text* or _text_ (but not inside strong markers)
      result = result.replace(/\*(.+?)\*/g, "<em>$1</em>");
      result = result.replace(/(?<!\w)_(.+?)_(?!\w)/g, "<em>$1</em>");
      // Strikethrough: ~~text~~
      result = result.replace(/~~(.+?)~~/g, "<s>$1</s>");
      // Inline code: `text`
      result = result.replace(/`([^`]+)`/g, "<code>$1</code>");
      return result;
    };

    // Headings
    const h3Match = line.match(/^###\s+(.+)/);
    if (h3Match) {
      if (inList) {
        html += inList === "ul" ? "</ul>" : "</ol>";
        inList = null;
      }
      html += `<h3>${inline(h3Match[1])}</h3>`;
      continue;
    }
    const h2Match = line.match(/^##\s+(.+)/);
    if (h2Match) {
      if (inList) {
        html += inList === "ul" ? "</ul>" : "</ol>";
        inList = null;
      }
      html += `<h2>${inline(h2Match[1])}</h2>`;
      continue;
    }

    // Blockquote
    const bqMatch = line.match(/^>\s?(.*)/);
    if (bqMatch) {
      if (inList) {
        html += inList === "ul" ? "</ul>" : "</ol>";
        inList = null;
      }
      html += `<blockquote><p>${inline(bqMatch[1])}</p></blockquote>`;
      continue;
    }

    // Unordered list item
    const ulMatch = line.match(/^[\-\*]\s+(.+)/);
    if (ulMatch) {
      if (inList !== "ul") {
        if (inList) html += "</ol>";
        html += "<ul>";
        inList = "ul";
      }
      html += `<li>${inline(ulMatch[1])}</li>`;
      continue;
    }

    // Ordered list item
    const olMatch = line.match(/^\d+\.\s+(.+)/);
    if (olMatch) {
      if (inList !== "ol") {
        if (inList) html += "</ul>";
        html += "<ol>";
        inList = "ol";
      }
      html += `<li>${inline(olMatch[1])}</li>`;
      continue;
    }

    // Regular paragraph
    if (inList) {
      html += inList === "ul" ? "</ul>" : "</ol>";
      inList = null;
    }
    html += `<p>${inline(line)}</p>`;
  }

  // Close any open tags
  if (inCodeBlock) html += "</code></pre>";
  if (inList) html += inList === "ul" ? "</ul>" : "</ol>";

  return html;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Convert TipTap HTML to Markdown
function htmlToMarkdown(html: string): string {
  const tempDiv = document.createElement("div");
  tempDiv.innerHTML = html;

  function processNode(node: Node): string {
    if (node.nodeType === Node.TEXT_NODE) {
      return node.textContent || "";
    }

    if (node.nodeType !== Node.ELEMENT_NODE) return "";

    const el = node as HTMLElement;
    const tag = el.tagName.toLowerCase();
    const children = Array.from(el.childNodes).map(processNode).join("");

    switch (tag) {
      case "p":
        return children + "\n\n";
      case "br":
        return "\n";
      case "strong":
      case "b":
        return `**${children}**`;
      case "em":
      case "i":
        return `*${children}*`;
      case "s":
      case "del":
        return `~~${children}~~`;
      case "code":
        return `\`${children}\``;
      case "pre": {
        const codeEl = el.querySelector("code");
        const codeContent = codeEl ? codeEl.textContent || "" : children;
        return `\n\`\`\`\n${codeContent}\n\`\`\`\n\n`;
      }
      case "h1":
        return `# ${children}\n\n`;
      case "h2":
        return `## ${children}\n\n`;
      case "h3":
        return `### ${children}\n\n`;
      case "blockquote":
        return (
          children
            .trim()
            .split("\n")
            .map((line) => `> ${line}`)
            .join("\n") + "\n\n"
        );
      case "ul":
        return children + "\n";
      case "ol":
        return children + "\n";
      case "li": {
        const parent = el.parentElement;
        if (parent?.tagName.toLowerCase() === "ol") {
          const index =
            Array.from(parent.children).indexOf(el as HTMLLIElement) + 1;
          return `${index}. ${children.trim()}\n`;
        }
        return `- ${children.trim()}\n`;
      }
      default:
        return children;
    }
  }

  return processNode(tempDiv).trim();
}

const RichTextEditor = forwardRef<RichTextEditorRef, RichTextEditorProps>(
  ({ placeholder, onSubmit, onChange, initialContent }, ref) => {
    const editor = useEditor({
      immediatelyRender: false,
      extensions: [
        StarterKit.configure({
          heading: { levels: [2, 3] },
        }),
        Placeholder.configure({
          placeholder: placeholder || "Type a message with rich formatting...",
        }),
      ],
      content: initialContent || "",
      editorProps: {
        attributes: {
          class:
            "prose prose-sm dark:prose-invert max-w-none focus:outline-none min-h-[44px] max-h-[180px] sm:max-h-[220px] overflow-y-auto px-4 py-3",
        },
        handleKeyDown: (_view, event) => {
          if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            onSubmit?.();
            return true;
          }
          return false;
        },
      },
      onUpdate: ({ editor }) => {
        const md = htmlToMarkdown(editor.getHTML());
        onChange?.(md);
      },
    });

    useImperativeHandle(ref, () => ({
      getMarkdown: () => {
        if (!editor) return "";
        return htmlToMarkdown(editor.getHTML());
      },
      clear: () => {
        editor?.commands.clearContent();
      },
      focus: () => {
        editor?.commands.focus();
      },
      setContent: (content: string) => {
        const html = markdownToHtml(content);
        editor?.commands.setContent(html);
      },
    }));

    useEffect(() => {
      return () => {
        editor?.destroy();
      };
    }, [editor]);

    const [isFullscreen, setIsFullscreen] = useState(false);

    const toggleFullscreen = useCallback(() => {
      setIsFullscreen((prev) => !prev);
      // Re-focus the editor after toggling
      setTimeout(() => editor?.commands.focus(), 50);
    }, [editor]);

    // Close fullscreen on Escape key
    useEffect(() => {
      const handleKeyDown = (e: KeyboardEvent) => {
        if (e.key === "Escape" && isFullscreen) {
          setIsFullscreen(false);
          setTimeout(() => editor?.commands.focus(), 50);
        }
      };
      if (isFullscreen) {
        document.addEventListener("keydown", handleKeyDown);
        return () => document.removeEventListener("keydown", handleKeyDown);
      }
    }, [isFullscreen, editor]);

    if (!editor) return null;

    const toolbarContent = (
      <>
        <ToolbarButton
          onClick={() => editor.chain().focus().toggleBold().run()}
          isActive={editor.isActive("bold")}
          title="Bold (Ctrl+B)"
        >
          <Bold className="w-3.5 h-3.5" />
        </ToolbarButton>
        <ToolbarButton
          onClick={() => editor.chain().focus().toggleItalic().run()}
          isActive={editor.isActive("italic")}
          title="Italic (Ctrl+I)"
        >
          <Italic className="w-3.5 h-3.5" />
        </ToolbarButton>
        <ToolbarButton
          onClick={() => editor.chain().focus().toggleStrike().run()}
          isActive={editor.isActive("strike")}
          title="Strikethrough"
        >
          <Strikethrough className="w-3.5 h-3.5" />
        </ToolbarButton>
        <ToolbarButton
          onClick={() => editor.chain().focus().toggleCode().run()}
          isActive={editor.isActive("code")}
          title="Inline Code"
        >
          <Code className="w-3.5 h-3.5" />
        </ToolbarButton>

        <div className="mx-1 hidden h-4 w-px bg-zinc-300 dark:bg-zinc-600 sm:block" />

        <ToolbarButton
          onClick={() =>
            editor.chain().focus().toggleHeading({ level: 2 }).run()
          }
          isActive={editor.isActive("heading", { level: 2 })}
          title="Heading"
        >
          <Heading2 className="w-3.5 h-3.5" />
        </ToolbarButton>
        <ToolbarButton
          onClick={() => editor.chain().focus().toggleBulletList().run()}
          isActive={editor.isActive("bulletList")}
          title="Bullet List"
        >
          <List className="w-3.5 h-3.5" />
        </ToolbarButton>
        <ToolbarButton
          onClick={() => editor.chain().focus().toggleOrderedList().run()}
          isActive={editor.isActive("orderedList")}
          title="Numbered List"
        >
          <ListOrdered className="w-3.5 h-3.5" />
        </ToolbarButton>
        <ToolbarButton
          onClick={() => editor.chain().focus().toggleBlockquote().run()}
          isActive={editor.isActive("blockquote")}
          title="Quote"
        >
          <Quote className="w-3.5 h-3.5" />
        </ToolbarButton>
        <ToolbarButton
          onClick={() => editor.chain().focus().toggleCodeBlock().run()}
          isActive={editor.isActive("codeBlock")}
          title="Code Block"
        >
          <CodeSquare className="w-3.5 h-3.5" />
        </ToolbarButton>

        <div className="mx-1 hidden h-4 w-px bg-zinc-300 dark:bg-zinc-600 sm:block" />

        <ToolbarButton
          onClick={() => editor.chain().focus().undo().run()}
          title="Undo (Ctrl+Z)"
        >
          <Undo className="w-3.5 h-3.5" />
        </ToolbarButton>
        <ToolbarButton
          onClick={() => editor.chain().focus().redo().run()}
          title="Redo (Ctrl+Shift+Z)"
        >
          <Redo className="w-3.5 h-3.5" />
        </ToolbarButton>

        <div className="flex-1" />

        <ToolbarButton
          onClick={toggleFullscreen}
          title={isFullscreen ? "Exit fullscreen (Esc)" : "Fullscreen"}
        >
          {isFullscreen ? (
            <Minimize2 className="w-3.5 h-3.5" />
          ) : (
            <Maximize2 className="w-3.5 h-3.5" />
          )}
        </ToolbarButton>
      </>
    );

    // Fullscreen overlay
    if (isFullscreen) {
      return (
        <>
          {/* Inline placeholder so the parent layout doesn't collapse */}
          <div className="flex-1" />
          {/* Fullscreen overlay */}
          <div className="fixed inset-0 z-50 flex flex-col bg-white dark:bg-zinc-900">
            {/* Header */}
            <div className="flex flex-wrap items-center gap-0.5 border-b border-zinc-200 bg-zinc-50 px-2 py-2 dark:border-zinc-700 dark:bg-zinc-800/80 sm:px-4">
              {toolbarContent}
            </div>

            {/* Editor area - fills remaining space */}
            <div className="flex-1 overflow-y-auto">
              <EditorContent
                editor={editor}
                className="richtext-fullscreen h-full"
              />
            </div>

            {/* Bottom bar with send button */}
            <div className="flex flex-col gap-2 border-t border-zinc-200 bg-zinc-50 px-3 py-3 dark:border-zinc-700 dark:bg-zinc-800/80 sm:flex-row sm:items-center sm:justify-between sm:px-4">
              <span className="text-xs text-zinc-400">
                Press Esc to exit fullscreen &middot; Ctrl+Enter to send
              </span>
              <button
                type="button"
                onClick={() => {
                  setIsFullscreen(false);
                  onSubmit?.();
                }}
                className="flex items-center justify-center gap-2 rounded-xl bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow-lg shadow-blue-500/20 transition-all hover:bg-blue-700"
              >
                <Send className="w-4 h-4" />
                Send
              </button>
            </div>
          </div>
        </>
      );
    }

    return (
      <div className="flex-1 overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-sm transition-all focus-within:border-transparent focus-within:ring-2 focus-within:ring-blue-500 dark:border-zinc-700 dark:bg-zinc-800">
        {/* Toolbar */}
        <div className="flex flex-wrap items-center gap-0.5 border-b border-zinc-200 bg-zinc-50 px-2 py-1.5 dark:border-zinc-700 dark:bg-zinc-800/80">
          {toolbarContent}
        </div>

        {/* Editor */}
        <EditorContent editor={editor} />
      </div>
    );
  },
);

RichTextEditor.displayName = "RichTextEditor";

export default RichTextEditor;
