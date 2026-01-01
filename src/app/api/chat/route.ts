import {
  GoogleGenerativeAI,
  Tool,
  SchemaType,
  Part,
} from "@google/generative-ai";
import { NextResponse } from "next/server";

// Define the tool for image generation using official Nano Banana naming
const tools: Tool[] = [
  {
    functionDeclarations: [
      {
        name: "generate_image",
        description:
          "Generates a high-fidelity image using Google's Nano Banana Pro model.",
        parameters: {
          type: SchemaType.OBJECT,
          properties: {
            prompt: {
              type: SchemaType.STRING,
              description: "The description of the image to generate.",
            },
            quality: {
              type: SchemaType.STRING,
              format: "enum",
              enum: ["speed", "high-fidelity"],
              description:
                "Whether to use standard Nano Banana (speed) or Nano Banana Pro (high-fidelity).",
            },
          },
          required: ["prompt"],
        },
      },
    ],
  },
];

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

    const { messages } = await req.json();

    // Re-initialize to ensure the key is correctly captured from the environment
    const currentGenAI = new GoogleGenerativeAI(apiKey);

    // Gemini handles the conversation and tool orchestration
    const model = currentGenAI.getGenerativeModel({
      model: "gemini-3-pro-preview",
      tools,
      systemInstruction: {
        role: "system",
        parts: [
          {
            text: "You are a helpful assistant that can write code, generate images, and explain complex topics including mathematics. When asked to create a web app, component, or UI, always use code blocks with the appropriate language tag (html, jsx, or tsx). These code blocks will be rendered as live previews for the user. For React apps, provide a single-file component named 'App' that uses Tailwind CSS for styling. For icons, you can use Lucide icons (available via the 'lucide-react' style but rendered as standard icons). Do not use external libraries other than React, Tailwind, and Lucide. Ensure the component is exported as 'export default function App()'. When writing mathematical formulas, use LaTeX notation with single dollar signs for inline math (e.g. $E=mc^2$) and double dollar signs for block math (e.g. $$a^2 + b^2 = c^2$$). You may receive input transcribed from voice; if so, maintain a helpful and conversational tone.",
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
          for await (const chunk of result.stream) {
            const text = chunk.text();
            if (text) {
              controller.enqueue(encoder.encode(text));
            }
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
