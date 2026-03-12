import { NextResponse } from "next/server";
import { editRasterAsset, type RasterBackgroundMode } from "@/lib/server/asset-generation";

export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { error: "Configuration Error", details: "GEMINI_API_KEY is not defined." },
        { status: 500 },
      );
    }

    const {
      prompt,
      rolePrompt,
      displayName,
      mimeType,
      outputMimeType,
      backgroundMode,
      backgroundColor,
      data,
      pro = false,
    } = (await req.json()) as {
      prompt?: string;
      rolePrompt?: string;
      displayName?: string;
      mimeType?: string;
      outputMimeType?: string;
      backgroundMode?: RasterBackgroundMode;
      backgroundColor?: string;
      data?: string;
      pro?: boolean;
    };

    if (!prompt?.trim()) {
      return NextResponse.json({ error: "Prompt is required." }, { status: 400 });
    }
    if (!mimeType?.trim() || !data?.trim()) {
      return NextResponse.json(
        { error: "Image mimeType and data are required." },
        { status: 400 },
      );
    }

    const generated = await editRasterAsset({
      apiKey,
      mimeType: mimeType.trim(),
      data: data.trim(),
      prompt: prompt.trim(),
      rolePrompt: rolePrompt?.trim(),
      displayName: displayName?.trim(),
      outputMimeType: outputMimeType?.trim() || mimeType.trim(),
      backgroundMode,
      backgroundColor,
      pro,
    });

    return NextResponse.json({
      asset: {
        mimeType: generated.mimeType,
        data: generated.data,
        url: generated.imageUrl,
      },
      model: generated.model,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json(
      { error: "Asset edit failed", details: message },
      { status: 500 },
    );
  }
}
