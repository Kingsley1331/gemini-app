import { NextResponse } from "next/server";
import { createSvgAsset, generateRasterAsset } from "@/lib/server/asset-generation";

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
      outputType = "raster",
      pro = false,
    } = (await req.json()) as {
      prompt?: string;
      rolePrompt?: string;
      outputType?: "raster" | "svg";
      pro?: boolean;
    };

    if (!prompt?.trim()) {
      return NextResponse.json({ error: "Prompt is required." }, { status: 400 });
    }

    const generated =
      outputType === "svg"
        ? await createSvgAsset({
            apiKey,
            prompt: prompt.trim(),
            rolePrompt: rolePrompt?.trim(),
          })
        : await generateRasterAsset({
            apiKey,
            prompt: prompt.trim(),
            rolePrompt: rolePrompt?.trim(),
            pro,
          });

    return NextResponse.json({
      asset: {
        mimeType: generated.mimeType,
        data: generated.data,
        url: generated.imageUrl,
        svgText: "svgText" in generated ? generated.svgText : undefined,
      },
      model: generated.model,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json(
      { error: "Asset generation failed", details: message },
      { status: 500 },
    );
  }
}
