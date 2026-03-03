import { NextResponse } from "next/server";
import { hasFirebaseAdminConfig, getFirebaseDb } from "@/lib/firebase-admin";
import { isShareableInstallsEnabled } from "@/lib/shared-apps";

export const runtime = "nodejs";

type RemoteAppSummary = {
  id: string;
  name: string;
  hasIcon: boolean;
  iconUrl?: string;
  updatedAt: number;
};

function toSummary(raw: unknown): RemoteAppSummary | null {
  if (!raw || typeof raw !== "object") return null;
  const doc = raw as Record<string, unknown>;
  const id = typeof doc.id === "string" ? doc.id.trim() : "";
  if (!id) return null;
  if (doc.isPublic === false) return null;
  const updatedAt =
    typeof doc.updatedAt === "number" && Number.isFinite(doc.updatedAt) ? doc.updatedAt : 0;
  const hasIcon = Boolean(doc.hasGeneratedIcon) || typeof doc.icon192Path === "string";
  return {
    id,
    name: typeof doc.name === "string" && doc.name.trim() ? doc.name.trim() : "Untitled App",
    hasIcon,
    iconUrl: `/api/preview/${encodeURIComponent(id)}/generate-icon?size=192${
      updatedAt ? `&v=${updatedAt}` : ""
    }`,
    updatedAt,
  };
}

async function readCollectionSummaries(name: string, limit = 120): Promise<RemoteAppSummary[]> {
  try {
    const snap = await getFirebaseDb()
      .collection(name)
      .orderBy("updatedAt", "desc")
      .limit(limit)
      .get();
    return snap.docs
      .map((doc) => toSummary(doc.data()))
      .filter((item): item is RemoteAppSummary => Boolean(item));
  } catch {
    return [];
  }
}

export async function GET() {
  if (!isShareableInstallsEnabled() || !hasFirebaseAdminConfig()) {
    return NextResponse.json({ apps: [] as RemoteAppSummary[] }, {
      headers: { "Cache-Control": "no-store" },
    });
  }

  try {
    const [apps, legacyDash, legacyCamel] = await Promise.all([
      readCollectionSummaries("apps"),
      readCollectionSummaries("shared-apps"),
      readCollectionSummaries("sharedApps"),
    ]);

    const merged = new Map<string, RemoteAppSummary>();
    for (const app of [...apps, ...legacyDash, ...legacyCamel]) {
      const existing = merged.get(app.id);
      if (!existing || app.updatedAt > existing.updatedAt) {
        merged.set(app.id, app);
      }
    }

    const sorted = Array.from(merged.values()).sort((a, b) => b.updatedAt - a.updatedAt);
    return NextResponse.json({ apps: sorted }, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown list failure";
    return NextResponse.json(
      { error: "Unable to list shared apps", details: message },
      { status: 500 }
    );
  }
}
