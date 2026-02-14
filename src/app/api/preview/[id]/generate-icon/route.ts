import { GoogleGenerativeAI } from "@google/generative-ai";
import { NextRequest, NextResponse } from "next/server";
import { access, mkdir, readFile, rm, writeFile } from "fs/promises";
import { constants } from "fs";
import { tmpdir } from "os";
import path from "path";
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
    return NextResponse.json(
      { error: "PWA Icon Generation Failed", details: message },
      { status: 500 }
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

  const memoryIcon = getGeneratedIcon(id, size);
  const tmpIcon = memoryIcon ? null : await readTmpGeneratedIcon(id, size);
  const iconBuffer = memoryIcon ?? tmpIcon;
  if (!iconBuffer) {
    const blobUrl = await getGeneratedIconBlobUrl(id, size);
    if (blobUrl) {
      const blobResp = await fetch(blobUrl);
      if (blobResp.ok) {
        const arrayBuffer = await blobResp.arrayBuffer();
        return new NextResponse(new Uint8Array(arrayBuffer), {
          status: 200,
          headers: {
            "Content-Type": "image/png",
            "Cache-Control": "public, max-age=300",
          },
        });
      }
    }

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
  const exists = memoryExists || tmpExists || blobExists;

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
