import { NextRequest, NextResponse } from "next/server";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const { searchParams } = new URL(request.url);
  const name = searchParams.get("name") || "My App";

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
    icons: [
      {
        src: "/icons/icon-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "any maskable",
      },
      {
        src: "/icons/icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "any maskable",
      },
    ],
  };

  return NextResponse.json(manifest, {
    headers: {
      "Content-Type": "application/manifest+json",
      "Cache-Control": "no-cache, no-store, must-revalidate",
    },
  });
}
