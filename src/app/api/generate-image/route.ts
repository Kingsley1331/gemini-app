import { GoogleGenerativeAI } from "@google/generative-ai";
import { NextResponse } from "next/server";
import sharp from "sharp";

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

async function generateWithModel(
  genAI: GoogleGenerativeAI,
  modelName: string,
  prompt: string,
) {
  const model = genAI.getGenerativeModel({ model: modelName });
  const result = await model.generateContent({
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: {
      // @ts-expect-error - Official multimodal generation modality
      responseModalities: ["IMAGE"],
    },
  });

  const response = await result.response;
  const inlineData = extractInlineData(response);
  if (!inlineData) {
    throw new Error(`No image data returned from model ${modelName}`);
  }

  const imageUrl = `data:${inlineData.mimeType};base64,${inlineData.data}`;
  return {
    imageUrl,
    inlineData,
    mimeType: inlineData.mimeType,
    model: modelName,
  };
}

function estimateSaturation(r: number, g: number, b: number): number {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max === 0) return 0;
  return (max - min) / max;
}

async function isolateSpriteFromBackground(
  base64Data: string,
): Promise<{ data: string; mimeType: string }> {
  const input = Buffer.from(base64Data, "base64");
  const { data, info } = await sharp(input)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const width = info.width;
  const height = info.height;
  const channels = info.channels;
  const pixelCount = width * height;
  const visited = new Uint8Array(pixelCount);
  const queue = new Uint32Array(pixelCount);
  let head = 0;
  let tail = 0;

  const samplePoints: Array<[number, number]> = [
    [0, 0],
    [width - 1, 0],
    [0, height - 1],
    [width - 1, height - 1],
    [Math.floor(width / 2), 0],
    [Math.floor(width / 2), height - 1],
    [0, Math.floor(height / 2)],
    [width - 1, Math.floor(height / 2)],
  ];

  let bgR = 0;
  let bgG = 0;
  let bgB = 0;
  let sampleCount = 0;
  for (const [x, y] of samplePoints) {
    const idx = (y * width + x) * channels;
    bgR += data[idx] ?? 0;
    bgG += data[idx + 1] ?? 0;
    bgB += data[idx + 2] ?? 0;
    sampleCount += 1;
  }
  bgR /= sampleCount;
  bgG /= sampleCount;
  bgB /= sampleCount;

  const isBackgroundPixel = (x: number, y: number) => {
    const idx = (y * width + x) * channels;
    const r = data[idx] ?? 0;
    const g = data[idx + 1] ?? 0;
    const b = data[idx + 2] ?? 0;
    const a = data[idx + 3] ?? 255;
    if (a <= 8) return true;

    const saturation = estimateSaturation(r, g, b);
    const dr = Math.abs(r - bgR);
    const dg = Math.abs(g - bgG);
    const db = Math.abs(b - bgB);
    const closeToBg = dr < 36 && dg < 36 && db < 36;
    const nearNeutral = saturation < 0.2;
    return closeToBg && nearNeutral;
  };

  const push = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const p = y * width + x;
    if (visited[p]) return;
    visited[p] = 1;
    queue[tail++] = p;
  };

  for (let x = 0; x < width; x += 1) {
    push(x, 0);
    push(x, height - 1);
  }
  for (let y = 1; y < height - 1; y += 1) {
    push(0, y);
    push(width - 1, y);
  }

  while (head < tail) {
    const p = queue[head++];
    const x = p % width;
    const y = Math.floor(p / width);
    if (!isBackgroundPixel(x, y)) continue;

    const idx = p * channels + 3;
    data[idx] = 0;

    push(x + 1, y);
    push(x - 1, y);
    push(x, y + 1);
    push(x, y - 1);
  }

  const normalized = await sharp(data, {
    raw: { width, height, channels },
  })
    .trim({ threshold: 8 })
    .resize(512, 512, {
      fit: "contain",
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png()
    .toBuffer();

  return {
    data: normalized.toString("base64"),
    mimeType: "image/png",
  };
}

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

    const { prompt, pro = false, removeBackground = false } = await req.json();

    if (!prompt) {
      return NextResponse.json(
        { error: "Prompt is required" },
        { status: 400 }
      );
    }

    const currentGenAI = new GoogleGenerativeAI(apiKey);

    // Nano Banana models with robust fallback:
    // - default path uses flash for better availability
    // - pro requests fall back to flash if unavailable
    const modelOrder = pro
      ? ["gemini-3-pro-image-preview", "gemini-2.5-flash-image"]
      : ["gemini-2.5-flash-image", "gemini-3-pro-image-preview"];

    let lastError: string | null = null;
    for (const modelName of modelOrder) {
      try {
        const generated = await generateWithModel(currentGenAI, modelName, prompt);
        const finalImage = removeBackground
          ? await isolateSpriteFromBackground(generated.inlineData.data)
          : {
              data: generated.inlineData.data,
              mimeType: generated.inlineData.mimeType,
            };
        const imageUrl = `data:${finalImage.mimeType};base64,${finalImage.data}`;
        return NextResponse.json({
          imageUrl,
          images: [imageUrl],
          mimeType: finalImage.mimeType,
          model: generated.model,
          attemptedModels: modelOrder,
        });
      } catch (error: unknown) {
        lastError = error instanceof Error ? error.message : "Unknown error";
        console.error(`[generate-image] ${modelName} failed:`, lastError);
      }
    }

    console.error("[generate-image] all models failed", {
      attemptedModels: modelOrder,
      lastError,
    });
    return NextResponse.json(
      {
        error: "No image data returned from Nano Banana",
        details: lastError || "All configured image models failed.",
      },
      { status: 500 }
    );
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json(
      { error: "Nano Banana Generation Failed", details: message },
      { status: 500 }
    );
  }
}
