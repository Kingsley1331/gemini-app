import { NextRequest, NextResponse } from "next/server";
import { constants } from "fs";
import { access } from "fs/promises";
import path from "path";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const { searchParams } = new URL(request.url);
  const name = searchParams.get("name") || "My App";

  const generatedDir = path.join(process.cwd(), "public", "generated-icons", id);
  const icon192File = path.join(generatedDir, "icon-192.png");
  const icon512File = path.join(generatedDir, "icon-512.png");

  const generatedIconsExist = await Promise.all([
    access(icon192File, constants.F_OK).then(
      () => true,
      () => false
    ),
    access(icon512File, constants.F_OK).then(
      () => true,
      () => false
    ),
  ]).then(([has192, has512]) => has192 && has512);

  const icons = generatedIconsExist
    ? [
        {
          src: `/generated-icons/${id}/icon-192.png`,
          sizes: "192x192",
          type: "image/png",
          purpose: "any maskable",
        },
        {
          src: `/generated-icons/${id}/icon-512.png`,
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
