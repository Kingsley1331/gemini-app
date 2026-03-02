import { NextRequest, NextResponse } from "next/server";
import { getGeneratedIcon } from "@/lib/generated-icon-store";
import { getGeneratedIconBlobUrl } from "@/lib/generated-icon-blob";
import { hasFirebaseAdminConfig } from "@/lib/firebase-admin";
import { getSharedAppDoc } from "@/lib/shared-apps-store";
import { isShareableInstallsEnabled } from "@/lib/shared-apps";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const { searchParams } = new URL(request.url);
  const name = searchParams.get("name") || "My App";

  // Auto-detect generated icons server-side so we don't depend on the client
  // passing a query flag.  Check in-memory store first (fast), then blob.
  const clientHint = searchParams.get("generated") === "1";
  const memoryHit = Boolean(getGeneratedIcon(id, 192));
  const blobHit = !memoryHit ? Boolean(await getGeneratedIconBlobUrl(id, 192)) : false;
  let sharedHit = false;
  if (!memoryHit && !blobHit && isShareableInstallsEnabled() && hasFirebaseAdminConfig()) {
    const sharedDoc = await getSharedAppDoc(id);
    sharedHit = Boolean(sharedDoc?.hasGeneratedIcon);
  }
  const hasGeneratedIcons = clientHint || memoryHit || blobHit || sharedHit;

  const icons = hasGeneratedIcons
    ? [
        {
          src: `/api/preview/${id}/generate-icon?size=192`,
          sizes: "192x192",
          type: "image/png",
          purpose: "any maskable",
        },
        {
          src: `/api/preview/${id}/generate-icon?size=512`,
          sizes: "512x512",
          type: "image/png",
          purpose: "any maskable",
        },
      ]
    : [
        {
          src: "/icons/icon.svg",
          sizes: "any",
          type: "image/svg+xml",
          purpose: "any maskable",
        },
      ];
  const manifest = {
    id: `/preview/${id}`,
    name,
    short_name: name.length > 12 ? name.slice(0, 12) : name,
    description: `${name} — built with Gemini`,
    start_url: `/preview/${id}`,
    scope: `/preview/${id}`,
    display: "standalone" as const,
    background_color: "#ffffff",
    theme_color: "#18181b",
    orientation: "any",
    icons,
  };

  return NextResponse.json(manifest, {
    headers: {
      "Content-Type": "application/manifest+json",
      "Cache-Control": "no-cache, no-store, must-revalidate",
    },
  });
}
