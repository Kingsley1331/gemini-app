import { NextRequest, NextResponse } from "next/server";
import { hasFirebaseAdminConfig } from "@/lib/firebase-admin";
import { isShareableInstallsEnabled } from "@/lib/shared-apps";
import { uploadDraftAsset } from "@/lib/shared-apps-store";

export const runtime = "nodejs";

function buildPreviewAssetUrl(id: string, assetKey: string): string {
  return `/preview/${encodeURIComponent(id)}/assets/${encodeURIComponent(assetKey)}`;
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!isShareableInstallsEnabled()) {
    return NextResponse.json({ error: "Shareable installs are disabled." }, { status: 503 });
  }
  if (!hasFirebaseAdminConfig()) {
    return NextResponse.json({ error: "Firebase is not configured on the server." }, { status: 500 });
  }

  const { id } = await params;
  if (!id) {
    return NextResponse.json({ error: "Missing app id." }, { status: 400 });
  }

  try {
    const formData = await req.formData();
    const file = formData.get("file");
    if (!file || typeof file === "string" || typeof file.arrayBuffer !== "function") {
      return NextResponse.json({ error: "Asset file is required." }, { status: 400 });
    }

    const assetKey = typeof formData.get("assetKey") === "string" ? String(formData.get("assetKey")) : "";
    const mimeType =
      typeof formData.get("mimeType") === "string" && String(formData.get("mimeType")).trim()
        ? String(formData.get("mimeType")).trim()
        : file.type || "application/octet-stream";
    const displayName =
      typeof formData.get("displayName") === "string" ? String(formData.get("displayName")) : undefined;
    const rolePrompt =
      typeof formData.get("rolePrompt") === "string" ? String(formData.get("rolePrompt")) : undefined;
    const sourceType =
      typeof formData.get("sourceType") === "string"
        ? (String(formData.get("sourceType")) as "upload" | "generated" | "edited")
        : undefined;
    const svgText =
      typeof formData.get("svgText") === "string" ? String(formData.get("svgText")) : undefined;
    const bytes = new Uint8Array(await file.arrayBuffer());

    const asset = await uploadDraftAsset(
      id,
      {
        assetKey,
        mimeType,
        displayName,
        rolePrompt,
        sourceType,
        svgText,
      },
      bytes
    );

    return NextResponse.json({
      success: true,
      asset: {
        assetKey: asset.assetKey,
        mimeType: asset.mimeType,
        storagePath: asset.storagePath,
        url: buildPreviewAssetUrl(id, asset.assetKey),
        displayName: asset.displayName,
        rolePrompt: asset.rolePrompt,
        sourceType: asset.sourceType,
        svgText: asset.svgText,
        updatedAt: asset.updatedAt,
      },
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown draft upload error";
    return NextResponse.json(
      { error: "Unable to upload draft asset", details: message },
      { status: 500 }
    );
  }
}
