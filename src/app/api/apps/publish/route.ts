import { NextRequest, NextResponse } from "next/server";
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

function parsePublishBody(body: unknown): SharedAppPublishInput {
  if (!body || typeof body !== "object") {
    throw new Error("Body must be a JSON object.");
  }

  const raw = body as Partial<SharedAppPublishInput>;
  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  const code = typeof raw.code === "string" ? raw.code : "";
  const language = typeof raw.language === "string" ? raw.language.trim() : "";
  const hasGeneratedIcon = Boolean(raw.hasGeneratedIcon);
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
    const url = rawAsset.url?.trim();
    if (data && data.length > MAX_SHARED_ASSET_BASE64_LENGTH) {
      throw new Error(`Asset ${assetKey} is too large for base64 upload.`);
    }
    return { assetKey, mimeType, data, url };
  });

  return {
    id,
    name,
    code,
    language,
    hasGeneratedIcon,
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
    payload = parsePublishBody(await req.json());
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
      const iconUrls = [
        `${req.nextUrl.origin}/api/preview/${payload.id}/generate-icon?size=192`,
        `${req.nextUrl.origin}/api/preview/${payload.id}/generate-icon?size=512`,
      ] as const;
      const [icon192Resp, icon512Resp] = await Promise.all(iconUrls.map((url) => fetch(url)));
      if (icon192Resp.ok && icon512Resp.ok) {
        const [icon192Bytes, icon512Bytes] = await Promise.all([
          icon192Resp.arrayBuffer(),
          icon512Resp.arrayBuffer(),
        ]);
        icon192Path = await uploadSharedIcon(payload.id, 192, new Uint8Array(icon192Bytes));
        icon512Path = await uploadSharedIcon(payload.id, 512, new Uint8Array(icon512Bytes));
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
