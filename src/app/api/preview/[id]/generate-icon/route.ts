import { GoogleGenerativeAI } from "@google/generative-ai";
import { NextRequest, NextResponse } from "next/server";
import { access, mkdir, readFile, rm, writeFile } from "fs/promises";
import { constants } from "fs";
import { tmpdir } from "os";
import path from "path";
import sharp from "sharp";
import {
  deleteGeneratedIcons,
  getGeneratedIcon,
  setGeneratedIcons,
} from "@/lib/generated-icon-store";
import {
  deleteGeneratedIconBlobs,
  getGeneratedIconBlobUrl,
  storeGeneratedIconsInBlob,
} from "@/lib/generated-icon-blob";
import { hasFirebaseAdminConfig } from "@/lib/firebase-admin";
import { getSharedAppDoc, getSharedIconBytes } from "@/lib/shared-apps-store";
import { isShareableInstallsEnabled } from "@/lib/shared-apps";

export const runtime = "nodejs";

function getTmpIconDir(id: string) {
  return path.join(tmpdir(), "gemini-app-generated-icons", id);
}

async function writeTmpGeneratedIcons(id: string, icon192: Buffer, icon512: Buffer) {
  const dir = getTmpIconDir(id);
  await mkdir(dir, { recursive: true });
  await Promise.all([
    writeFile(path.join(dir, "icon-192.png"), icon192),
    writeFile(path.join(dir, "icon-512.png"), icon512),
  ]);
}

async function readTmpGeneratedIcon(
  id: string,
  size: 192 | 512
): Promise<Buffer | null> {
  const filePath = path.join(getTmpIconDir(id), `icon-${size}.png`);
  try {
    await access(filePath, constants.F_OK);
    return await readFile(filePath);
  } catch {
    return null;
  }
}

async function deleteTmpGeneratedIcons(id: string) {
  await rm(getTmpIconDir(id), { recursive: true, force: true });
}

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

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getUpstreamStatusCode(error: unknown): number | null {
  if (!(error instanceof Error)) return null;
  const match = error.message.match(/\[(\d{3})\s+[^\]]+\]/);
  if (!match) return null;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : null;
}

function isTransientModelError(error: unknown): boolean {
  const statusCode = getUpstreamStatusCode(error);
  if (statusCode === 429 || statusCode === 500 || statusCode === 502 || statusCode === 503) {
    return true;
  }
  if (!(error instanceof Error)) return false;
  return /high demand|try again later|temporar/i.test(error.message);
}

async function generateIconWithModel(
  genAI: GoogleGenerativeAI,
  modelName: string,
  prompt: string
): Promise<{ icon512Buffer: Buffer; icon192Buffer: Buffer }> {
  const model = genAI.getGenerativeModel({ model: modelName });
  const result = await model.generateContent({
    contents: [
      {
        role: "user",
        parts: [
          {
            text: `${prompt}\n\nOutput requirements:\n- PNG only\n- Square 512x512\n- Keep composition centered and readable at small sizes`,
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
    throw new Error(`No image data returned from model ${modelName}`);
  }

  const icon512Buffer = Buffer.from(inlineData.data, "base64");
  const icon192Buffer = await sharp(icon512Buffer)
    .resize(192, 192, { fit: "cover" })
    .png()
    .toBuffer();

  return { icon512Buffer, icon192Buffer };
}

async function loadStoredIconBuffer(
  id: string,
  size: 192 | 512
): Promise<Buffer | null> {
  const memoryIcon = getGeneratedIcon(id, size);
  const tmpIcon = memoryIcon ? null : await readTmpGeneratedIcon(id, size);
  const iconBuffer = memoryIcon ?? tmpIcon;
  if (iconBuffer) return iconBuffer;

  const blobUrl = await getGeneratedIconBlobUrl(id, size);
  if (blobUrl) {
    const blobResp = await fetch(blobUrl);
    if (blobResp.ok) {
      const arrayBuffer = await blobResp.arrayBuffer();
      return Buffer.from(arrayBuffer);
    }
  }

  if (isShareableInstallsEnabled() && hasFirebaseAdminConfig()) {
    const sharedDoc = await getSharedAppDoc(id);
    if (sharedDoc) {
      let sharedIcon = await getSharedIconBytes(sharedDoc, size);
      if (!sharedIcon) {
        const alternateSize: 192 | 512 = size === 192 ? 512 : 192;
        const alternate = await getSharedIconBytes(sharedDoc, alternateSize);
        if (alternate) {
          try {
            sharedIcon = await sharp(Buffer.from(alternate))
              .resize(size, size, { fit: "cover" })
              .png()
              .toBuffer();
          } catch {
            sharedIcon = null;
          }
        }
      }
      if (sharedIcon) {
        return Buffer.from(sharedIcon);
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
    const { id } = await params;
    const { copyFromId, prompt, pro = true, name } = await req.json();

    const appName = typeof name === "string" && name.trim() ? name.trim() : "My App";
    let icon512Buffer: Buffer | null = null;
    let icon192Buffer: Buffer | null = null;
    let lastError: unknown = null;

    if (typeof copyFromId === "string" && copyFromId.trim()) {
      const sourceId = copyFromId.trim();
      [icon192Buffer, icon512Buffer] = await Promise.all([
        loadStoredIconBuffer(sourceId, 192),
        loadStoredIconBuffer(sourceId, 512),
      ]);
      if (!icon192Buffer || !icon512Buffer) {
        return NextResponse.json(
          {
            error: "PWA Icon Copy Failed",
            details: "Source icon could not be found.",
          },
          { status: 404 }
        );
      }
    } else {
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

      const basePrompt =
        typeof prompt === "string" && prompt.trim()
          ? prompt.trim()
          : `Create a clean, high-contrast, minimal mobile app icon for "${appName}". Centered symbol, bold shape, no text, no watermark, simple background, suitable for Android and iOS PWA install icon.`;

      const genAI = new GoogleGenerativeAI(apiKey);
      const modelOrder = pro
        ? ["gemini-3-pro-image-preview", "gemini-2.5-flash-image"]
        : ["gemini-2.5-flash-image", "gemini-3-pro-image-preview"];

      // Generate a single 512x512 icon and resize to 192x192 so both sizes
      // show the same image (two separate API calls would produce different icons).
      for (const modelName of modelOrder) {
        try {
          const generated = await generateIconWithModel(genAI, modelName, basePrompt);
          icon512Buffer = generated.icon512Buffer;
          icon192Buffer = generated.icon192Buffer;
          break;
        } catch (error: unknown) {
          lastError = error;
          if (isTransientModelError(error)) {
            try {
              const generated = await generateIconWithModel(genAI, modelName, basePrompt);
              icon512Buffer = generated.icon512Buffer;
              icon192Buffer = generated.icon192Buffer;
              break;
            } catch (retryError: unknown) {
              lastError = retryError;
              if (isTransientModelError(retryError)) {
                await sleep(1200);
              }
            }
          }
        }
      }
    }

    if (!icon512Buffer || !icon192Buffer) {
      throw lastError instanceof Error
        ? lastError
        : new Error("No image data returned for icon generation");
    }

    const timestamp = Date.now();
    const icon192DataUrl = `data:image/png;base64,${icon192Buffer.toString("base64")}`;
    const icon512DataUrl = `data:image/png;base64,${icon512Buffer.toString("base64")}`;
    const blobUrls = await storeGeneratedIconsInBlob(
      id,
      new Uint8Array(icon192Buffer),
      new Uint8Array(icon512Buffer)
    );

    setGeneratedIcons(id, {
      icon192: icon192Buffer,
      icon512: icon512Buffer,
      timestamp,
    });
    await writeTmpGeneratedIcons(id, icon192Buffer, icon512Buffer);

    return NextResponse.json({
      success: true,
      id,
      icons: {
        icon192:
          blobUrls?.url192 ?? `/api/preview/${id}/generate-icon?size=192&v=${timestamp}`,
        icon512:
          blobUrls?.url512 ?? `/api/preview/${id}/generate-icon?size=512&v=${timestamp}`,
      },
      iconDataUrls: {
        icon192: icon192DataUrl,
        icon512: icon512DataUrl,
      },
      timestamp,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    const upstreamStatus = getUpstreamStatusCode(error);
    const status = isTransientModelError(error) ? 503 : upstreamStatus ?? 500;
    return NextResponse.json(
      { error: "PWA Icon Generation Failed", details: message },
      { status }
    );
  }
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const sizeParam = req.nextUrl.searchParams.get("size");
  const size = sizeParam === "512" ? 512 : sizeParam === "192" ? 192 : null;

  if (!size) {
    return NextResponse.json(
      { error: "Query parameter 'size' must be 192 or 512" },
      { status: 400 }
    );
  }

  const iconBuffer = await loadStoredIconBuffer(id, size);
  if (!iconBuffer) {
    return NextResponse.json({ error: "Generated icon not found" }, { status: 404 });
  }

  const iconBytes = new Uint8Array(iconBuffer);
  return new NextResponse(iconBytes, {
    status: 200,
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": "public, max-age=300",
    },
  });
}

export async function HEAD(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const sizeParam = req.nextUrl.searchParams.get("size");
  const size = sizeParam === "512" ? 512 : sizeParam === "192" ? 192 : null;
  const memoryExists = size ? Boolean(getGeneratedIcon(id, size)) : false;
  const tmpExists = size ? Boolean(await readTmpGeneratedIcon(id, size)) : false;
  const blobExists = size ? Boolean(await getGeneratedIconBlobUrl(id, size)) : false;
  let sharedExists = false;
  if (!memoryExists && !tmpExists && !blobExists && size && isShareableInstallsEnabled() && hasFirebaseAdminConfig()) {
    const sharedDoc = await getSharedAppDoc(id);
    if (sharedDoc) {
      const sharedIcon = await getSharedIconBytes(sharedDoc, size);
      sharedExists = Boolean(sharedIcon);
    }
  }
  const exists = memoryExists || tmpExists || blobExists || sharedExists;

  return new NextResponse(null, {
    status: exists ? 200 : 404,
    headers: { "Cache-Control": "no-store" },
  });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    deleteGeneratedIcons(id);
    await deleteTmpGeneratedIcons(id);
    await deleteGeneratedIconBlobs(id);

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
