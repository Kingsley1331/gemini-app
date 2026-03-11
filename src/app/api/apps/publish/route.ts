import { NextRequest, NextResponse } from "next/server";
import sharp from "sharp";
import { hasFirebaseAdminConfig } from "@/lib/firebase-admin";
import {
  buildSharedAppDoc,
  normalizeAssetKey,
  uploadSharedAsset,
  uploadSharedIcon,
  upsertSharedApp,
} from "@/lib/shared-apps-store";
import {
  isShareableInstallsEnabled,
  MAX_SHARED_ASSET_BASE64_LENGTH,
  MAX_SHARED_ASSET_COUNT,
  MAX_SHARED_CODE_LENGTH,
  type SharedAppAssetInput,
  type SharedAppPublishInput,
} from "@/lib/shared-apps";

export const runtime = "nodejs";

function badRequest(message: string) {
  return NextResponse.json({ error: "Invalid publish payload", details: message }, { status: 400 });
}

function stripDataUrlPrefix(value: string): string {
  return value.replace(/^data:[^,]+,/, "").trim();
}

function parsePublishBody(body: unknown, baseOrigin: string): SharedAppPublishInput {
  if (!body || typeof body !== "object") {
    throw new Error("Body must be a JSON object.");
  }

  const raw = body as Partial<SharedAppPublishInput>;
  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  const code = typeof raw.code === "string" ? raw.code : "";
  const language = typeof raw.language === "string" ? raw.language.trim() : "";
  const hasGeneratedIcon = Boolean(raw.hasGeneratedIcon);
  const icon192Base64 =
    typeof raw.icon192Base64 === "string" && raw.icon192Base64.trim()
      ? stripDataUrlPrefix(raw.icon192Base64)
      : undefined;
  const icon512Base64 =
    typeof raw.icon512Base64 === "string" && raw.icon512Base64.trim()
      ? stripDataUrlPrefix(raw.icon512Base64)
      : undefined;
  const assets = Array.isArray(raw.assets) ? raw.assets : [];

  if (!id || id.length > 120) throw new Error("Missing or invalid id.");
  if (!name || name.length > 120) throw new Error("Missing or invalid name.");
  if (!language || language.length > 40) throw new Error("Missing or invalid language.");
  if (!code || code.length > MAX_SHARED_CODE_LENGTH) {
    throw new Error(`Code is missing or too large (max ${MAX_SHARED_CODE_LENGTH} chars).`);
  }
  if (assets.length > MAX_SHARED_ASSET_COUNT) {
    throw new Error(`Too many assets (max ${MAX_SHARED_ASSET_COUNT}).`);
  }

  const validatedAssets: SharedAppAssetInput[] = assets.map((asset, index) => {
    if (!asset || typeof asset !== "object") {
      throw new Error(`Asset ${index + 1} must be an object.`);
    }
    const rawAsset = asset as SharedAppAssetInput;
    const assetKey = normalizeAssetKey(rawAsset.assetKey || `asset_${index + 1}`);
    const mimeType = (rawAsset.mimeType || "application/octet-stream").trim();
    const data = rawAsset.data?.trim();
    const rawUrl = rawAsset.url?.trim();
    const url =
      rawUrl && rawUrl.startsWith("/")
        ? new URL(rawUrl, baseOrigin).toString()
        : rawUrl;
    const displayName = rawAsset.displayName?.trim();
    const rolePrompt = rawAsset.rolePrompt?.trim();
    const sourceType = rawAsset.sourceType;
    const svgText = rawAsset.svgText?.trim();
    if (data && data.length > MAX_SHARED_ASSET_BASE64_LENGTH) {
      throw new Error(`Asset ${assetKey} is too large for base64 upload.`);
    }
    return { assetKey, mimeType, data, url, displayName, rolePrompt, sourceType, svgText };
  });

  return {
    id,
    name,
    code,
    language,
    hasGeneratedIcon,
    icon192Base64,
    icon512Base64,
    assets: validatedAssets,
  };
}

export async function POST(req: NextRequest) {
  if (!isShareableInstallsEnabled()) {
    return NextResponse.json(
      { error: "Shareable installs are disabled." },
      { status: 503 }
    );
  }
  if (!hasFirebaseAdminConfig()) {
    return NextResponse.json(
      { error: "Firebase is not configured on the server." },
      { status: 500 }
    );
  }

  let payload: SharedAppPublishInput;
  try {
    payload = parsePublishBody(await req.json(), req.nextUrl.origin);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Invalid JSON body.";
    return badRequest(message);
  }

  try {
    const assets = await Promise.all(
      (payload.assets ?? []).map((asset) => uploadSharedAsset(payload.id, asset))
    );
    const savedAssets = assets.filter(
      (asset): asset is NonNullable<typeof asset> => Boolean(asset)
    );

    let icon192Path: string | undefined;
    let icon512Path: string | undefined;

    if (payload.hasGeneratedIcon) {
      let icon192Bytes: Uint8Array | undefined;
      let icon512Bytes: Uint8Array | undefined;

      if (payload.icon192Base64 || payload.icon512Base64) {
        if (payload.icon192Base64) {
          icon192Bytes = new Uint8Array(Buffer.from(payload.icon192Base64, "base64"));
        }
        if (payload.icon512Base64) {
          icon512Bytes = new Uint8Array(Buffer.from(payload.icon512Base64, "base64"));
        }

        if (!icon192Bytes && icon512Bytes) {
          icon192Bytes = new Uint8Array(
            await sharp(Buffer.from(icon512Bytes))
              .resize(192, 192, { fit: "cover" })
              .png()
              .toBuffer()
          );
        }
        if (!icon512Bytes && icon192Bytes) {
          icon512Bytes = new Uint8Array(
            await sharp(Buffer.from(icon192Bytes))
              .resize(512, 512, { fit: "cover" })
              .png()
              .toBuffer()
          );
        }
      } else {
        const iconUrls = [
          `${req.nextUrl.origin}/api/preview/${payload.id}/generate-icon?size=192`,
          `${req.nextUrl.origin}/api/preview/${payload.id}/generate-icon?size=512`,
        ] as const;
        const [icon192Resp, icon512Resp] = await Promise.all(iconUrls.map((url) => fetch(url)));
        if (icon192Resp.ok && icon512Resp.ok) {
          const [icon192Buffer, icon512Buffer] = await Promise.all([
            icon192Resp.arrayBuffer(),
            icon512Resp.arrayBuffer(),
          ]);
          icon192Bytes = new Uint8Array(icon192Buffer);
          icon512Bytes = new Uint8Array(icon512Buffer);
        }
      }

      if (icon192Bytes && icon512Bytes) {
        icon192Path = await uploadSharedIcon(payload.id, 192, icon192Bytes);
        icon512Path = await uploadSharedIcon(payload.id, 512, icon512Bytes);
      }
    }

    const doc = await buildSharedAppDoc(payload, {
      assets: savedAssets,
      icon192Path,
      icon512Path,
    });
    await upsertSharedApp(doc);

    return NextResponse.json({
      success: true,
      id: payload.id,
      shareUrl: `${req.nextUrl.origin}/preview/${payload.id}`,
      updatedAt: doc.updatedAt,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown publish failure";
    return NextResponse.json(
      { error: "Publish failed", details: message },
      { status: 500 }
    );
  }
}
