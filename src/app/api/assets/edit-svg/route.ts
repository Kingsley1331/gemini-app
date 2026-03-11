import { NextResponse } from "next/server";
import { editSvgAsset } from "@/lib/server/asset-generation";

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
      svgText,
    } = (await req.json()) as {
      prompt?: string;
      rolePrompt?: string;
      displayName?: string;
      svgText?: string;
    };

    if (!prompt?.trim()) {
      return NextResponse.json({ error: "Prompt is required." }, { status: 400 });
    }
    if (!svgText?.trim()) {
      return NextResponse.json({ error: "svgText is required." }, { status: 400 });
    }

    const generated = await editSvgAsset({
      apiKey,
      svgText: svgText.trim(),
      prompt: prompt.trim(),
      rolePrompt: rolePrompt?.trim(),
      displayName: displayName?.trim(),
    });

    return NextResponse.json({
      asset: {
        mimeType: generated.mimeType,
        data: generated.data,
        url: generated.imageUrl,
        svgText: generated.svgText,
      },
      model: generated.model,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json(
      { error: "SVG edit failed", details: message },
      { status: 500 },
    );
  }
}
