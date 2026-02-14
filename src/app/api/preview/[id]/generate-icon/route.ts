import { GoogleGenerativeAI } from "@google/generative-ai";
import { mkdir, rm, writeFile } from "fs/promises";
import path from "path";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

function extractInlineData(response: {
  candidates?: Array<{
    content?: { parts?: Array<{ inlineData?: { data?: string; mimeType?: string } }> };
  }>;
}): { data: string; mimeType: string } | null {
  const candidates = response.candidates || [];
  for (const candidate of candidates) {
    const parts = candidate.content?.parts || [];
    for (const part of parts) {
      if (part.inlineData?.data && part.inlineData?.mimeType) {
        return {
          data: part.inlineData.data,
          mimeType: part.inlineData.mimeType,
        };
      }
    }
  }
  return null;
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
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

    const { id } = await params;
    const { prompt, pro = true, name } = await req.json();

    const appName = typeof name === "string" && name.trim() ? name.trim() : "My App";
    const basePrompt =
      typeof prompt === "string" && prompt.trim()
        ? prompt.trim()
        : `Create a clean, high-contrast, minimal mobile app icon for "${appName}". Centered symbol, bold shape, no text, no watermark, simple background, suitable for Android and iOS PWA install icon.`;

    const genAI = new GoogleGenerativeAI(apiKey);
    const modelName = pro ? "gemini-3-pro-image-preview" : "gemini-2.5-flash-image";
    const model = genAI.getGenerativeModel({ model: modelName });

    const generateIconData = async (size: 192 | 512) => {
      const result = await model.generateContent({
        contents: [
          {
            role: "user",
            parts: [
              {
                text: `${basePrompt}\n\nOutput requirements:\n- PNG only\n- Square ${size}x${size}\n- Keep composition centered and readable at small sizes`,
              },
            ],
          },
        ],
        generationConfig: {
          // @ts-expect-error - Official multimodal generation modality
          responseModalities: ["IMAGE"],
        },
      });

      const response = await result.response;
      const inlineData = extractInlineData(response);
      if (!inlineData) {
        throw new Error(`No image data returned for ${size}x${size} icon`);
      }

      return Buffer.from(inlineData.data, "base64");
    };

    const [icon512Buffer, icon192Buffer] = await Promise.all([
      generateIconData(512),
      generateIconData(192),
    ]);

    const outputDir = path.join(process.cwd(), "public", "generated-icons", id);
    await mkdir(outputDir, { recursive: true });

    const icon512Path = path.join(outputDir, "icon-512.png");
    const icon192Path = path.join(outputDir, "icon-192.png");
    await Promise.all([
      writeFile(icon512Path, icon512Buffer),
      writeFile(icon192Path, icon192Buffer),
    ]);

    const timestamp = Date.now();
    return NextResponse.json({
      success: true,
      id,
      icons: {
        icon192: `/generated-icons/${id}/icon-192.png?v=${timestamp}`,
        icon512: `/generated-icons/${id}/icon-512.png?v=${timestamp}`,
      },
      timestamp,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json(
      { error: "PWA Icon Generation Failed", details: message },
      { status: 500 }
    );
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const outputDir = path.join(process.cwd(), "public", "generated-icons", id);
    await rm(outputDir, { recursive: true, force: true });

    return NextResponse.json({
      success: true,
      id,
      removed: true,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json(
      { error: "PWA Icon Cleanup Failed", details: message },
      { status: 500 }
    );
  }
}
