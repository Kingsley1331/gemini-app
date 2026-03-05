import { NextResponse } from "next/server";
import { hasFirebaseAdminConfig } from "@/lib/firebase-admin";
import { getSharedAppDoc, toSharedAppReadPayload } from "@/lib/shared-apps-store";
import { isShareableInstallsEnabled } from "@/lib/shared-apps";

export const runtime = "nodejs";

export async function GET(
  _req: Request,
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
    const doc = await getSharedAppDoc(id);
    if (!doc) {
      return NextResponse.json({ error: "Shared app not found." }, { status: 404 });
    }
    return NextResponse.json(toSharedAppReadPayload(doc), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown read failure";
    return NextResponse.json({ error: "Unable to load shared app", details: message }, { status: 500 });
  }
}
