import {
  GoogleGenerativeAI,
  Part,
  HarmCategory,
  HarmBlockThreshold,
} from "@google/generative-ai";
import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { NextResponse } from "next/server";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Provider = "gemini" | "openai" | "anthropic";

function getProvider(modelId: string): Provider {
  if (modelId.startsWith("gemini-")) return "gemini";
  if (modelId.startsWith("gpt-")) return "openai";
  if (modelId.startsWith("claude-")) return "anthropic";
  return "gemini"; // fallback
}

interface ChatMessage {
  role: string;
  content: string;
  attachments?: { mimeType: string; data: string }[];
}

// Default system instruction for the main chat
const defaultSystemInstruction = `You are a helpful assistant that can write code and explain complex topics including mathematics. To generate images, the user must start their message with "/image".

CRITICAL CODE PREVIEW RULES:
Your code blocks tagged as html, jsx, or tsx are rendered as LIVE PREVIEWS inside a sandboxed iframe. Follow these rules strictly to avoid runtime errors:

1. ENVIRONMENT: The preview sandbox has these pre-loaded and globally available:
   - React 18 (all hooks: useState, useEffect, useRef, useMemo, useCallback, useReducer, useContext, createContext, useLayoutEffect, useTransition, useId, useDeferredValue, useImperativeHandle, useDebugValue)
   - ReactDOM 18
   - Tailwind CSS (use utility classes freely)
   - Lucide icons as React components (e.g. <Heart className="w-5 h-5" />, <Search size={20} />)
   - Babel with TypeScript support

2. IMPORTS:
   - You may write normal imports for React and Lucide (e.g. import { useState } from 'react'; import { Heart } from 'lucide-react';). They are mapped to globals.
   - You may also import browser-compatible npm packages with bare specifiers (e.g. import Matter from 'matter-js'; import { format } from 'date-fns';). The preview runtime resolves them from an ESM CDN at runtime.
   - Use exact package names and versions when possible (e.g. import confetti from 'canvas-confetti@1.9.3').
   - Do NOT use Node-only packages (fs, path, net, child_process, etc.) or Next.js-only imports.

3. COMPONENT STRUCTURE: Always export a single default function component named App:
   export default function App() { ... }

4. ICONS: Use Lucide icon names in PascalCase as React components. They accept props: size, color, strokeWidth, className, and any SVG prop. Common icons: Heart, Star, Search, Menu, X, ChevronDown, ChevronRight, ArrowLeft, ArrowRight, Plus, Minus, Check, Copy, Trash, Edit, Settings, User, Home, Mail, Phone, Calendar, Clock, MapPin, Image, Camera, Upload, Download, Share, Send, Bell, Lock, Unlock, Eye, EyeOff, Sun, Moon, Github, ExternalLink, Loader2, AlertCircle, Info, CheckCircle, XCircle.

5. RESTRICTIONS — avoid these (they WILL cause errors):
   - Do NOT use Node-only or server-only libraries/APIs (fs, path, net, child_process, process, Buffer, etc.)
   - Do NOT use fetch() to external APIs (the iframe is sandboxed)
   - Do NOT use Next.js features (no next/link, next/image, next/router, useRouter, etc.)
   - Do NOT use CSS modules or styled-components
   - Do NOT use complex TypeScript features like enums, decorators, or namespaces
   - Do NOT use window.location or navigation APIs
   - Do NOT reference files or images via relative paths

6. STYLING: Use Tailwind CSS classes exclusively. For animations, use Tailwind's built-in animation utilities or inline CSS keyframes in a <style> tag.

7. STATE & DATA: All data must be hardcoded or generated within the component. Use useState for interactivity. You may use simple setTimeout/setInterval for timers.

8. SELF-CONTAINED: The entire app must be in a single file with a single App component. Helper components and functions should be defined in the same scope above the App component.

9. QUALITY — you MUST verify these before outputting ANY code:
   - Every opening JSX tag MUST have a matching closing tag with the SAME name. For example, <Card> must close with </Card>, NOT </div>. <MyComponent> must close with </MyComponent>, NOT </div> or any other tag.
   - No undefined variables or functions.
   - All curly braces, parentheses, and brackets are balanced.
   - All functions and arrow functions are properly closed.
   - All ternary expressions have both branches.
   - All array .map() calls return JSX.
   - The component returns valid JSX with a single root element (or Fragment).

   UI/UX REQUIREMENTS (CRITICAL — follow strictly):
   - Every <button> MUST have visible text content, a visible icon, or BOTH. NEVER create empty buttons or buttons with only invisible/hidden content.
   - Buttons must have sufficient contrast against their background. Do NOT use light gray text on white backgrounds or dark gray text on dark backgrounds. Use distinct colors like blue-600, zinc-900, or white on colored backgrounds.
   - All interactive elements (buttons, links, inputs) must be clearly visible and distinguishable from the background at all times.
   - Icon-only buttons MUST include a Lucide icon component (e.g. <Plus className="w-5 h-5" />) and should have aria-label for accessibility.
   - Always use readable font sizes (minimum text-sm / 14px for body text, minimum text-xs / 12px for secondary text).
   - Never set opacity-0, visibility:hidden, or display:none on buttons unless it is a deliberate toggle with a visible alternative state.
   - Form inputs must have visible placeholder text or a label.
   - Give buttons meaningful labels that describe their action (e.g. "Add Item", "Submit", "Delete") instead of generic labels like "Click" or "Button".

10. MODIFYING EXISTING CODE:
    - When the user asks to change a specific part of the code, ONLY change that part.
    - Do NOT refactor, optimize, or rewrite other parts of the code unless explicitly asked.
    - Preserve existing variable names, logic, and structure in unchanged areas.
    - If you must make changes to make the code work, explain why.

11. LATEX IN CODE: If you need to display LaTeX/math formulas inside JSX code blocks, NEVER put raw LaTeX directly in JSX text because curly braces and backslashes will break Babel parsing. Instead, store the formula in a JavaScript string variable first, then render it:
   const formula = "$$E = mc^2$$";
   return <p>{formula}</p>;
   For backslashes, use double backslashes in the string: "\\\\frac{a}{b}" or String.raw literals.

When writing mathematical formulas in regular chat (not code), use LaTeX notation with single dollar signs for inline math (e.g. $E=mc^2$) and double dollar signs for block math (e.g. $$a^2 + b^2 = c^2$$). You may receive input transcribed from voice; if so, maintain a helpful and conversational tone.`;

// ---------------------------------------------------------------------------
// Provider-specific streaming handlers
// ---------------------------------------------------------------------------

async function streamGemini(
  modelId: string,
  messages: ChatMessage[],
  systemInstructionText: string,
): Promise<ReadableStream<Uint8Array>> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "GEMINI_API_KEY is not defined in environment variables. Check your .env.local file and restart your server.",
    );
  }

  const genAI = new GoogleGenerativeAI(apiKey);

  const model = genAI.getGenerativeModel({
    model: modelId,
    safetySettings: [
      {
        category: HarmCategory.HARM_CATEGORY_HARASSMENT,
        threshold: HarmBlockThreshold.BLOCK_NONE,
      },
      {
        category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,
        threshold: HarmBlockThreshold.BLOCK_NONE,
      },
      {
        category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
        threshold: HarmBlockThreshold.BLOCK_NONE,
      },
      {
        category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
        threshold: HarmBlockThreshold.BLOCK_NONE,
      },
    ],
    systemInstruction: {
      role: "system",
      parts: [{ text: systemInstructionText }],
    },
  });

  const chat = model.startChat({
    history: messages.slice(0, -1).map((msg) => {
      const parts: Part[] = [{ text: msg.content }];
      if (msg.attachments && msg.attachments.length > 0) {
        msg.attachments.forEach((attachment) => {
          parts.push({
            inlineData: {
              mimeType: attachment.mimeType,
              data: attachment.data,
            },
          });
        });
      }
      return {
        role: msg.role === "user" ? "user" : "model",
        parts,
      };
    }),
  });

  const lastMessage = messages[messages.length - 1];
  const lastMessageParts: Part[] = [{ text: lastMessage.content || "" }];

  if (lastMessage.attachments && lastMessage.attachments.length > 0) {
    lastMessage.attachments.forEach((attachment) => {
      lastMessageParts.push({
        inlineData: {
          mimeType: attachment.mimeType,
          data: attachment.data,
        },
      });
    });
  }

  const result = await chat.sendMessageStream(lastMessageParts);

  const encoder = new TextEncoder();
  return new ReadableStream({
    async start(controller) {
      try {
        let hasText = false;
        for await (const chunk of result.stream) {
          const text = chunk.text();
          if (text) {
            hasText = true;
            controller.enqueue(encoder.encode(text));
          }
        }
        if (!hasText) {
          controller.enqueue(
            encoder.encode(
              "I'm sorry, I couldn't generate a response. Please try again.",
            ),
          );
        }
      } catch (error) {
        const errMsg =
          error instanceof Error ? error.message : "Unknown Gemini error";
        controller.enqueue(encoder.encode(`\n\n**Error (Gemini):** ${errMsg}`));
      } finally {
        controller.close();
      }
    },
  });
}

async function streamOpenAI(
  modelId: string,
  messages: ChatMessage[],
  systemInstructionText: string,
): Promise<ReadableStream<Uint8Array>> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "OPENAI_API_KEY is not defined in environment variables. Check your .env.local file and restart your server.",
    );
  }

  const openai = new OpenAI({ apiKey });

  // Build OpenAI Responses API input
  const openaiInput: unknown[] = [
    { type: "message", role: "system", content: systemInstructionText },
  ];

  for (const msg of messages) {
    const role: "user" | "assistant" =
      msg.role === "user" ? "user" : "assistant";

    // If there are image attachments, use multimodal content parts for user messages
    if (role === "user" && msg.attachments && msg.attachments.length > 0) {
      const contentParts: Array<
        | { type: "input_text"; text: string }
        | { type: "input_image"; image_url: string }
      > = [{ type: "input_text", text: msg.content }];
      for (const attachment of msg.attachments) {
        contentParts.push({
          type: "input_image",
          image_url: `data:${attachment.mimeType};base64,${attachment.data}`,
        });
      }
      openaiInput.push({
        type: "message",
        role: "user",
        content: contentParts,
      });
    } else {
      openaiInput.push({ type: "message", role, content: msg.content });
    }
  }

  const stream = await openai.responses.create({
    model: modelId,
    input: openaiInput as never,
    stream: true,
  });

  const encoder = new TextEncoder();
  return new ReadableStream({
    async start(controller) {
      try {
        let hasText = false;
        for await (const event of stream) {
          const text =
            event.type === "response.output_text.delta"
              ? event.delta
              : undefined;
          if (text) {
            hasText = true;
            controller.enqueue(encoder.encode(text));
          }
        }
        if (!hasText) {
          controller.enqueue(
            encoder.encode(
              "I'm sorry, I couldn't generate a response. Please try again.",
            ),
          );
        }
      } catch (error) {
        const errMsg =
          error instanceof Error ? error.message : "Unknown OpenAI error";
        controller.enqueue(encoder.encode(`\n\n**Error (OpenAI):** ${errMsg}`));
      } finally {
        controller.close();
      }
    },
  });
}

async function streamAnthropic(
  modelId: string,
  messages: ChatMessage[],
  systemInstructionText: string,
): Promise<ReadableStream<Uint8Array>> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      "ANTHROPIC_API_KEY is not defined in environment variables. Check your .env.local file and restart your server.",
    );
  }

  const anthropic = new Anthropic({ apiKey });

  // Build Anthropic message array
  const anthropicMessages: Anthropic.MessageParam[] = [];

  for (const msg of messages) {
    const role: "user" | "assistant" =
      msg.role === "user" ? "user" : "assistant";

    if (role === "user" && msg.attachments && msg.attachments.length > 0) {
      const contentBlocks: Anthropic.ContentBlockParam[] = [
        { type: "text", text: msg.content },
      ];
      for (const attachment of msg.attachments) {
        contentBlocks.push({
          type: "image",
          source: {
            type: "base64",
            media_type: attachment.mimeType as
              | "image/jpeg"
              | "image/png"
              | "image/gif"
              | "image/webp",
            data: attachment.data,
          },
        });
      }
      anthropicMessages.push({ role: "user", content: contentBlocks });
    } else {
      anthropicMessages.push({ role, content: msg.content });
    }
  }

  const encoder = new TextEncoder();
  return new ReadableStream({
    async start(controller) {
      try {
        let hasText = false;

        const response = await anthropic.messages.create({
          model: modelId,
          max_tokens: 8192,
          system: systemInstructionText,
          messages: anthropicMessages,
          stream: true,
        });

        for await (const event of response) {
          if (
            event.type === "content_block_delta" &&
            event.delta.type === "text_delta"
          ) {
            const text = event.delta.text;
            if (text) {
              hasText = true;
              controller.enqueue(encoder.encode(text));
            }
          }
        }

        if (!hasText) {
          controller.enqueue(
            encoder.encode(
              "I'm sorry, I couldn't generate a response. Please try again.",
            ),
          );
        }
      } catch (error) {
        const errMsg =
          error instanceof Error ? error.message : "Unknown Anthropic error";
        controller.enqueue(
          encoder.encode(`\n\n**Error (Anthropic):** ${errMsg}`),
        );
      } finally {
        controller.close();
      }
    },
  });
}

// ---------------------------------------------------------------------------
// Main route handler
// ---------------------------------------------------------------------------

export async function POST(req: Request) {
  try {
    const {
      messages,
      model: userModel,
      systemInstruction: customSystemInstruction,
    } = await req.json();

    const modelId = userModel || "gemini-3-pro-preview";
    const provider = getProvider(modelId);
    const systemInstructionText =
      customSystemInstruction || defaultSystemInstruction;

    let stream: ReadableStream<Uint8Array>;

    switch (provider) {
      case "openai":
        stream = await streamOpenAI(modelId, messages, systemInstructionText);
        break;
      case "anthropic":
        stream = await streamAnthropic(
          modelId,
          messages,
          systemInstructionText,
        );
        break;
      case "gemini":
      default:
        stream = await streamGemini(modelId, messages, systemInstructionText);
        break;
    }

    return new Response(stream, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Transfer-Encoding": "chunked",
      },
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json(
      { error: "Chat Error", details: message },
      { status: 500 },
    );
  }
}
