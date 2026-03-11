import { GoogleGenerativeAI } from "@google/generative-ai";
import sharp from "sharp";

type InlineDataResponse = {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        inlineData?: {
          data?: string;
          mimeType?: string;
        };
      }>;
    };
  }>;
};

const PRESERVABLE_RASTER_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
]);

function supportsTransparency(mimeType: string | null | undefined): boolean {
  return mimeType === "image/png" || mimeType === "image/webp";
}

function extractInlineData(response: InlineDataResponse): { data: string; mimeType: string } | null {
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

async function generateImageWithParts(
  genAI: GoogleGenerativeAI,
  modelName: string,
  parts: Array<
    | { text: string }
    | {
        inlineData: {
          data: string;
          mimeType: string;
        };
      }
  >,
) {
  const model = genAI.getGenerativeModel({ model: modelName });
  const result = await model.generateContent({
    contents: [{ role: "user", parts }],
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

  return {
    data: inlineData.data,
    mimeType: inlineData.mimeType,
    imageUrl: `data:${inlineData.mimeType};base64,${inlineData.data}`,
    model: modelName,
  };
}

function normalizeRasterMimeType(mimeType: string | undefined): string | null {
  const normalized = (mimeType || "").trim().toLowerCase();
  if (normalized === "image/jpg") return "image/jpeg";
  return PRESERVABLE_RASTER_MIME_TYPES.has(normalized) ? normalized : null;
}

async function encodeRasterToTargetMimeType(
  base64Data: string,
  targetMimeType: string,
): Promise<{ data: string; mimeType: string; imageUrl: string }> {
  const normalizedTargetMimeType = normalizeRasterMimeType(targetMimeType);
  if (!normalizedTargetMimeType) {
    throw new Error(`Unsupported raster output mime type: ${targetMimeType}`);
  }

  const input = Buffer.from(base64Data, "base64");
  let pipeline = sharp(input, { failOn: "none" }).rotate();

  switch (normalizedTargetMimeType) {
    case "image/png":
      pipeline = pipeline.png();
      break;
    case "image/webp":
      pipeline = pipeline.webp();
      break;
    case "image/jpeg":
      pipeline = pipeline.flatten({ background: "#ffffff" }).jpeg({ quality: 92 });
      break;
    default:
      throw new Error(`Unsupported raster output mime type: ${targetMimeType}`);
  }

  const output = await pipeline.toBuffer();
  const data = output.toString("base64");
  return {
    data,
    mimeType: normalizedTargetMimeType,
    imageUrl: `data:${normalizedTargetMimeType};base64,${data}`,
  };
}

function estimateSaturation(r: number, g: number, b: number): number {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max === 0) return 0;
  return (max - min) / max;
}

async function imageHasTransparentPixels(base64Data: string): Promise<boolean> {
  const input = Buffer.from(base64Data, "base64");
  const { data, info } = await sharp(input)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  for (let index = 3; index < data.length; index += info.channels) {
    if ((data[index] ?? 255) < 250) {
      return true;
    }
  }

  return false;
}

async function restoreTransparentBackground(base64Data: string): Promise<string> {
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
    .png()
    .toBuffer();

  return normalized.toString("base64");
}

function getImageModelOrder(pro: boolean): string[] {
  return pro
    ? ["gemini-3-pro-image-preview", "gemini-2.5-flash-image"]
    : ["gemini-2.5-flash-image", "gemini-3-pro-image-preview"];
}

function getGenAI(apiKey: string): GoogleGenerativeAI {
  return new GoogleGenerativeAI(apiKey);
}

export async function generateRasterAsset(options: {
  apiKey: string;
  prompt: string;
  rolePrompt?: string;
  pro?: boolean;
  outputMimeType?: string;
}) {
  const genAI = getGenAI(options.apiKey);
  const prompt = [
    "Create a polished application asset.",
    options.rolePrompt ? `Asset role in the app: ${options.rolePrompt}` : "",
    options.prompt,
  ]
    .filter(Boolean)
    .join("\n\n");

  let lastError: string | null = null;
  for (const modelName of getImageModelOrder(Boolean(options.pro))) {
    try {
      const generated = await generateImageWithParts(genAI, modelName, [{ text: prompt }]);
      const targetMimeType =
        normalizeRasterMimeType(options.outputMimeType) ||
        normalizeRasterMimeType(generated.mimeType);
      if (!targetMimeType) {
        return generated;
      }

      const normalized = await encodeRasterToTargetMimeType(generated.data, targetMimeType);
      return {
        ...normalized,
        model: generated.model,
      };
    } catch (error: unknown) {
      lastError = error instanceof Error ? error.message : "Unknown error";
    }
  }

  throw new Error(lastError || "Unable to generate image asset.");
}

export async function editRasterAsset(options: {
  apiKey: string;
  mimeType: string;
  data: string;
  prompt: string;
  rolePrompt?: string;
  displayName?: string;
  pro?: boolean;
  outputMimeType?: string;
}) {
  const genAI = getGenAI(options.apiKey);
  const requestedOutputMimeType =
    normalizeRasterMimeType(options.outputMimeType || options.mimeType) ||
    normalizeRasterMimeType(options.mimeType);
  const preserveTransparency =
    supportsTransparency(requestedOutputMimeType) &&
    (await imageHasTransparentPixels(options.data));
  const instruction = [
    "Edit this existing application asset based on the requested changes.",
    options.displayName ? `Asset name: ${options.displayName}` : "",
    options.rolePrompt ? `Asset role in the app: ${options.rolePrompt}` : "",
    `Requested changes: ${options.prompt}`,
    requestedOutputMimeType
      ? `Preserve the original file type and return the final asset as ${requestedOutputMimeType}.`
      : "",
    preserveTransparency
      ? "Preserve the transparent background. Keep previously transparent regions transparent, and do not replace them with white or any solid-color matte."
      : "",
    "Return only the updated image.",
  ]
    .filter(Boolean)
    .join("\n\n");

  let lastError: string | null = null;
  for (const modelName of getImageModelOrder(Boolean(options.pro))) {
    try {
      const generated = await generateImageWithParts(genAI, modelName, [
        { text: instruction },
        {
          inlineData: {
            mimeType: options.mimeType,
            data: options.data,
          },
        },
      ]);
      const targetMimeType =
        requestedOutputMimeType ||
        normalizeRasterMimeType(generated.mimeType);
      if (!targetMimeType) {
        return generated;
      }

      let normalizedSourceData = generated.data;
      if (preserveTransparency && !(await imageHasTransparentPixels(generated.data))) {
        normalizedSourceData = await restoreTransparentBackground(generated.data);
      }

      const normalized = await encodeRasterToTargetMimeType(normalizedSourceData, targetMimeType);
      return {
        ...normalized,
        model: generated.model,
      };
    } catch (error: unknown) {
      lastError = error instanceof Error ? error.message : "Unknown error";
    }
  }

  throw new Error(lastError || "Unable to edit image asset.");
}

function stripCodeFences(text: string): string {
  return text
    .replace(/^```(?:svg|xml)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

function extractSvgMarkup(text: string): string {
  const cleaned = stripCodeFences(text);
  const match = cleaned.match(/<svg[\s\S]*<\/svg>/i);
  return (match?.[0] || cleaned).trim();
}

function validateSvgMarkup(svg: string): string {
  const normalized = svg.trim();
  if (!/^<svg[\s>]/i.test(normalized) || !/<\/svg>\s*$/i.test(normalized)) {
    throw new Error("Generated response did not contain valid SVG markup.");
  }
  if (/<script[\s>]/i.test(normalized)) {
    throw new Error("Generated SVG contained a script tag.");
  }
  if (/\son\w+\s*=/i.test(normalized)) {
    throw new Error("Generated SVG contained inline event handlers.");
  }
  return normalized;
}

async function generateSvgText(prompt: string, apiKey: string): Promise<string> {
  const genAI = getGenAI(apiKey);
  const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
  const result = await model.generateContent({
    contents: [{ role: "user", parts: [{ text: prompt }] }],
  });
  const response = await result.response;
  return validateSvgMarkup(extractSvgMarkup(response.text()));
}

export async function createSvgAsset(options: {
  apiKey: string;
  prompt: string;
  rolePrompt?: string;
}) {
  const svgText = await generateSvgText(
    [
      "Create an SVG asset for an application UI.",
      options.rolePrompt ? `Asset role in the app: ${options.rolePrompt}` : "",
      `Visual request: ${options.prompt}`,
      "Return only valid SVG markup with a root <svg> element.",
      "Do not wrap the SVG in markdown fences.",
    ]
      .filter(Boolean)
      .join("\n\n"),
    options.apiKey,
  );

  return {
    svgText,
    mimeType: "image/svg+xml",
    data: Buffer.from(svgText, "utf8").toString("base64"),
    imageUrl: `data:image/svg+xml;base64,${Buffer.from(svgText, "utf8").toString("base64")}`,
    model: "gemini-2.5-flash",
  };
}

export async function editSvgAsset(options: {
  apiKey: string;
  svgText: string;
  prompt: string;
  rolePrompt?: string;
  displayName?: string;
}) {
  const nextSvgText = await generateSvgText(
    [
      "Edit the following SVG asset while preserving it as valid SVG markup.",
      options.displayName ? `Asset name: ${options.displayName}` : "",
      options.rolePrompt ? `Asset role in the app: ${options.rolePrompt}` : "",
      `Requested changes: ${options.prompt}`,
      "Return only the updated SVG markup.",
      "<svg_source>",
      options.svgText,
      "</svg_source>",
    ]
      .filter(Boolean)
      .join("\n\n"),
    options.apiKey,
  );

  return {
    svgText: nextSvgText,
    mimeType: "image/svg+xml",
    data: Buffer.from(nextSvgText, "utf8").toString("base64"),
    imageUrl: `data:image/svg+xml;base64,${Buffer.from(nextSvgText, "utf8").toString("base64")}`,
    model: "gemini-2.5-flash",
  };
}
