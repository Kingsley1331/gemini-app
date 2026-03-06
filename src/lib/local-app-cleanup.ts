"use client";

import { deletePreviewFromIDB } from "@/lib/preview-idb";
import { purgePwaPreviewLocalArtifacts } from "@/lib/pwa-preview";
import { deleteSavedApp } from "@/lib/saved-apps-idb";

export async function purgeLocalAppData(id: string): Promise<void> {
  await Promise.allSettled([
    deleteSavedApp(id),
    deletePreviewFromIDB(id),
    purgePwaPreviewLocalArtifacts(id),
  ]);
}
