import {
  GoogleGenerativeAI,
  Part,
  HarmCategory,
  HarmBlockThreshold,
} from "@google/generative-ai";
import { NextResponse } from "next/server";

export async function POST(req: Request) {
  try {
    const apiKey = process.env.GEMINI_API_KEY;

    if (!apiKey) {
      return NextResponse.json(
        {
          error: "Configuration Error",
          details:
            "GEMINI_API_KEY is not defined in environment variables. Check your .env.local file and restart your server.",
        },
        { status: 500 }
      );
    }

    const { messages, model: userModel } = await req.json();

    // Re-initialize to ensure the key is correctly captured from the environment
    const currentGenAI = new GoogleGenerativeAI(apiKey);

    // Gemini handles the conversation
    const model = currentGenAI.getGenerativeModel({
      model: userModel || "gemini-3-pro-preview",
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
        parts: [
          {
            text: `You are a helpful assistant that can write code and explain complex topics including mathematics. To generate images, the user must start their message with "/image".

CRITICAL CODE PREVIEW RULES:
Your code blocks tagged as html, jsx, or tsx are rendered as LIVE PREVIEWS inside a sandboxed iframe. Follow these rules strictly to avoid runtime errors:

1. ENVIRONMENT: The preview sandbox has these pre-loaded and globally available:
   - React 18 (all hooks: useState, useEffect, useRef, useMemo, useCallback, useReducer, useContext, createContext, useLayoutEffect, useTransition, useId, useDeferredValue, useImperativeHandle, useDebugValue)
   - ReactDOM 18
   - Tailwind CSS (use utility classes freely)
   - Lucide icons as React components (e.g. <Heart className="w-5 h-5" />, <Search size={20} />)
   - Babel with TypeScript support

2. IMPORTS: Write import statements normally (e.g. import { useState } from 'react'; import { Heart } from 'lucide-react';). They will be automatically stripped and the globals will be used. Do NOT import from any other packages — they are not available.

3. COMPONENT STRUCTURE: Always export a single default function component named App:
   export default function App() { ... }

4. ICONS: Use Lucide icon names in PascalCase as React components. They accept props: size, color, strokeWidth, className, and any SVG prop. Common icons: Heart, Star, Search, Menu, X, ChevronDown, ChevronRight, ArrowLeft, ArrowRight, Plus, Minus, Check, Copy, Trash, Edit, Settings, User, Home, Mail, Phone, Calendar, Clock, MapPin, Image, Camera, Upload, Download, Share, Send, Bell, Lock, Unlock, Eye, EyeOff, Sun, Moon, Github, ExternalLink, Loader2, AlertCircle, Info, CheckCircle, XCircle.

5. RESTRICTIONS — avoid these (they WILL cause errors):
   - Do NOT use external libraries (no axios, date-fns, framer-motion, recharts, etc.)
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

10. MODIFYING EXISTING CODE:
    - When the user asks to change a specific part of the code, ONLY change that part.
    - Do NOT refactor, optimize, or rewrite other parts of the code unless explicitly asked.
    - Preserve existing variable names, logic, and structure in unchanged areas.
    - If you must make changes to make the code work, explain why.

11. LATEX IN CODE: If you need to display LaTeX/math formulas inside JSX code blocks, NEVER put raw LaTeX directly in JSX text because curly braces and backslashes will break Babel parsing. Instead, store the formula in a JavaScript string variable first, then render it:
   const formula = "$$E = mc^2$$";
   return <p>{formula}</p>;
   For backslashes, use double backslashes in the string: "\\\\frac{a}{b}" or String.raw literals.

When writing mathematical formulas in regular chat (not code), use LaTeX notation with single dollar signs for inline math (e.g. $E=mc^2$) and double dollar signs for block math (e.g. $$a^2 + b^2 = c^2$$). You may receive input transcribed from voice; if so, maintain a helpful and conversational tone.`,
          },
        ],
      },
    });

    const chat = model.startChat({
      history: messages
        .slice(0, -1)
        .map(
          (msg: {
            role: string;
            content: string;
            attachments?: { mimeType: string; data: string }[];
          }) => {
            const parts: Part[] = [{ text: msg.content }];

            if (msg.attachments && msg.attachments.length > 0) {
              msg.attachments.forEach(
                (attachment: { mimeType: string; data: string }) => {
                  parts.push({
                    inlineData: {
                      mimeType: attachment.mimeType,
                      data: attachment.data,
                    },
                  });
                }
              );
            }

            return {
              role: msg.role === "user" ? "user" : "model",
              parts,
            };
          }
        ),
    });

    const lastMessage = messages[messages.length - 1];
    const lastMessageParts: Part[] = [{ text: lastMessage.content || "" }];

    if (lastMessage.attachments && lastMessage.attachments.length > 0) {
      lastMessage.attachments.forEach(
        (attachment: { mimeType: string; data: string }) => {
          lastMessageParts.push({
            inlineData: {
              mimeType: attachment.mimeType,
              data: attachment.data,
            },
          });
        }
      );
    }

    const result = await chat.sendMessageStream(lastMessageParts);

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
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
                "I'm sorry, I couldn't generate a response. Please try again."
              )
            );
          }
          controller.close();
        } catch (error) {
          controller.error(error);
        }
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Transfer-Encoding": "chunked",
      },
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json(
      { error: "Gemini Error", details: message },
      { status: 500 }
    );
  }
}
