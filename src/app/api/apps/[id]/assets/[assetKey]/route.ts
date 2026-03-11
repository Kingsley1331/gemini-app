import { NextResponse } from "next/server";
import { hasFirebaseAdminConfig } from "@/lib/firebase-admin";
import { isShareableInstallsEnabled } from "@/lib/shared-apps";
import { deleteDraftAsset } from "@/lib/shared-apps-store";

export const runtime = "nodejs";

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string; assetKey: string }> }
) {
  if (!isShareableInstallsEnabled()) {
    return NextResponse.json({ error: "Shareable installs are disabled." }, { status: 503 });
  }
  if (!hasFirebaseAdminConfig()) {
    return NextResponse.json({ error: "Firebase is not configured on the server." }, { status: 500 });
  }

  const { id, assetKey } = await params;
  if (!id || !assetKey) {
    return NextResponse.json({ error: "Missing asset parameters." }, { status: 400 });
  }

  try {
    const removed = await deleteDraftAsset(id, decodeURIComponent(assetKey));
    return NextResponse.json({
      success: true,
      id,
      assetKey: decodeURIComponent(assetKey),
      removed,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown draft delete error";
    return NextResponse.json(
      { error: "Unable to delete draft asset", details: message },
      { status: 500 }
    );
  }
}
