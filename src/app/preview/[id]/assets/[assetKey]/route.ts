import { NextResponse } from "next/server";
import { hasFirebaseAdminConfig } from "@/lib/firebase-admin";
import { getDraftAssetBytes, getSharedAppDoc, getSharedAssetBytes } from "@/lib/shared-apps-store";
import { isShareableInstallsEnabled } from "@/lib/shared-apps";

export const runtime = "nodejs";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string; assetKey: string }> }
) {
  if (!isShareableInstallsEnabled() || !hasFirebaseAdminConfig()) {
    return NextResponse.json({ error: "Asset unavailable." }, { status: 404 });
  }

  const { id, assetKey } = await params;
  if (!id || !assetKey) {
    return NextResponse.json({ error: "Missing asset parameters." }, { status: 400 });
  }

  try {
    const draftAsset = await getDraftAssetBytes(id, decodeURIComponent(assetKey));
    if (draftAsset) {
      return new NextResponse(Buffer.from(draftAsset.bytes), {
        status: 200,
        headers: {
          "Content-Type": draftAsset.mimeType,
          "Cache-Control": "public, max-age=300",
        },
      });
    }

    const doc = await getSharedAppDoc(id);
    if (!doc) {
      return NextResponse.json({ error: "Shared app not found." }, { status: 404 });
    }

    const asset = await getSharedAssetBytes(doc, decodeURIComponent(assetKey));
    if (!asset) {
      return NextResponse.json({ error: "Shared asset not found." }, { status: 404 });
    }

    return new NextResponse(Buffer.from(asset.bytes), {
      status: 200,
      headers: {
        "Content-Type": asset.mimeType,
        "Cache-Control": "public, max-age=300",
      },
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown asset error";
    return NextResponse.json({ error: "Unable to load asset", details: message }, { status: 500 });
  }
}
