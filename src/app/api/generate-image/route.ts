import { NextResponse } from "next/server";
import { generateRasterAsset, type RasterBackgroundMode } from "@/lib/server/asset-generation";

export const runtime = "nodejs";

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

    const {
      prompt,
      pro = false,
      removeBackground = false,
      outputMimeType,
      backgroundMode,
      backgroundColor,
    } = (await req.json()) as {
      prompt?: string;
      pro?: boolean;
      removeBackground?: boolean;
      outputMimeType?: string;
      backgroundMode?: RasterBackgroundMode;
      backgroundColor?: string;
    };

    if (!prompt) {
      return NextResponse.json(
        { error: "Prompt is required" },
        { status: 400 }
      );
    }

    const resolvedBackgroundMode =
      backgroundMode || (removeBackground ? "transparent" : "original");
    const generated = await generateRasterAsset({
      apiKey,
      prompt: prompt.trim(),
      pro,
      outputMimeType,
      backgroundMode: resolvedBackgroundMode,
      backgroundColor,
    });

    return NextResponse.json({
      imageUrl: generated.imageUrl,
      images: [generated.imageUrl],
      mimeType: generated.mimeType,
      model: generated.model,
      backgroundMode: resolvedBackgroundMode,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json(
      { error: "Nano Banana Generation Failed", details: message },
      { status: 500 }
    );
  }
}
