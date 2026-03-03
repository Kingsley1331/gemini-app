import { getFirebaseBucket, getFirebaseDb } from "@/lib/firebase-admin";
import {
  getSharedAppDocPath,
  getSharedAssetStoragePath,
  getSharedIconStoragePath,
  type SharedAppAssetInput,
  type SharedAppDoc,
  type SharedAppPublishInput,
  type SharedAppReadPayload,
} from "@/lib/shared-apps";

const ALLOWED_ASSET_KEY = /^[a-zA-Z0-9_-]{1,120}$/;
const ALLOWED_MIME_TYPE = /^[a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+$/;

function normalizeBase64(input: string): string {
  const marker = "base64,";
  const markerIndex = input.indexOf(marker);
  if (markerIndex === -1) return input;
  return input.slice(markerIndex + marker.length);
}

export function normalizeAssetKey(raw: string): string {
  const trimmed = raw.trim();
  if (ALLOWED_ASSET_KEY.test(trimmed)) return trimmed;
  return trimmed
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 120);
}

export function validateAssetInput(asset: SharedAppAssetInput): SharedAppAssetInput {
  const assetKey = normalizeAssetKey(asset.assetKey || "");
  if (!assetKey || !ALLOWED_ASSET_KEY.test(assetKey)) {
    throw new Error(`Invalid asset key: "${asset.assetKey}"`);
  }
  const mimeType = asset.mimeType?.trim() || "application/octet-stream";
  if (!ALLOWED_MIME_TYPE.test(mimeType)) {
    throw new Error(`Invalid asset mime type for key "${assetKey}"`);
  }
  return {
    assetKey,
    mimeType,
    data: asset.data?.trim(),
    url: asset.url?.trim(),
  };
}

export async function uploadSharedAsset(
  id: string,
  asset: SharedAppAssetInput
): Promise<{ assetKey: string; mimeType: string; storagePath: string } | null> {
  const validated = validateAssetInput(asset);
  const storagePath = getSharedAssetStoragePath(id, validated.assetKey);
  const file = getFirebaseBucket().file(storagePath);

  let bytes: Buffer | null = null;
  if (validated.data) {
    bytes = Buffer.from(normalizeBase64(validated.data), "base64");
  } else if (validated.url) {
    const fetched = await fetch(validated.url);
    if (fetched.ok) {
      bytes = Buffer.from(await fetched.arrayBuffer());
    }
  }

  if (!bytes || !bytes.byteLength) return null;

  await file.save(bytes, {
    contentType: validated.mimeType,
    resumable: false,
    metadata: {
      cacheControl: "public, max-age=31536000, immutable",
    },
  });

  return {
    assetKey: validated.assetKey,
    mimeType: validated.mimeType,
    storagePath,
  };
}

export async function uploadSharedIcon(
  id: string,
  size: 192 | 512,
  bytes: Uint8Array
): Promise<string> {
  const storagePath = getSharedIconStoragePath(id, size);
  const file = getFirebaseBucket().file(storagePath);
  await file.save(Buffer.from(bytes), {
    contentType: "image/png",
    resumable: false,
    metadata: {
      cacheControl: "public, max-age=31536000, immutable",
    },
  });
  return storagePath;
}

export async function upsertSharedApp(doc: SharedAppDoc): Promise<void> {
  const ref = getFirebaseDb().doc(getSharedAppDocPath(doc.id));
  await ref.set(doc, { merge: true });
  const verify = await ref.get();
  if (!verify.exists) {
    throw new Error(`Shared app write verification failed for id "${doc.id}".`);
  }
}

export async function getSharedAppDoc(id: string): Promise<SharedAppDoc | null> {
  const db = getFirebaseDb();
  const candidatePaths = Array.from(
    new Set([getSharedAppDocPath(id), `shared-apps/${id}`, `sharedApps/${id}`])
  );

  for (const path of candidatePaths) {
    const snap = await db.doc(path).get();
    if (!snap.exists) continue;
    const data = snap.data() as SharedAppDoc | undefined;
    // Backward compatibility: older shared docs may not have isPublic set.
    // Only treat docs as private when explicitly marked false.
    if (!data || data.isPublic === false) continue;
    return data;
  }

  return null;
}

export function toSharedAppReadPayload(doc: SharedAppDoc): SharedAppReadPayload {
  return {
    id: doc.id,
    name: doc.name,
    code: doc.code,
    language: doc.language,
    hasGeneratedIcon: doc.hasGeneratedIcon,
    assets: (doc.assets || []).map((asset) => ({
      assetKey: asset.assetKey,
      mimeType: asset.mimeType,
    })),
    updatedAt: doc.updatedAt,
  };
}

export async function getSharedAssetBytes(
  doc: SharedAppDoc,
  assetKey: string
): Promise<{ bytes: Uint8Array; mimeType: string } | null> {
  const normalizedKey = normalizeAssetKey(assetKey);
  const matched = doc.assets?.find((asset) => asset.assetKey === normalizedKey);
  if (!matched?.storagePath) return null;
  const file = getFirebaseBucket().file(matched.storagePath);
  const [exists] = await file.exists();
  if (!exists) return null;
  const [buffer] = await file.download();
  return {
    bytes: new Uint8Array(buffer),
    mimeType: matched.mimeType || "application/octet-stream",
  };
}

export async function getSharedIconBytes(
  doc: SharedAppDoc,
  size: 192 | 512
): Promise<Uint8Array | null> {
  const path = size === 192 ? doc.icon192Path : doc.icon512Path;
  if (!path) return null;
  const file = getFirebaseBucket().file(path);
  const [exists] = await file.exists();
  if (!exists) return null;
  const [buffer] = await file.download();
  return new Uint8Array(buffer);
}

export async function buildSharedAppDoc(
  input: SharedAppPublishInput,
  opts?: {
    assets?: Array<{ assetKey: string; mimeType: string; storagePath: string }>;
    icon192Path?: string;
    icon512Path?: string;
  }
): Promise<SharedAppDoc> {
  const now = Date.now();
  const existing = await getFirebaseDb().doc(getSharedAppDocPath(input.id)).get();
  const prev = existing.exists ? (existing.data() as SharedAppDoc | undefined) : undefined;
  return {
    id: input.id,
    name: input.name,
    code: input.code,
    language: input.language,
    hasGeneratedIcon: input.hasGeneratedIcon,
    isPublic: true,
    assets: opts?.assets ?? prev?.assets ?? [],
    icon192Path: opts?.icon192Path ?? prev?.icon192Path,
    icon512Path: opts?.icon512Path ?? prev?.icon512Path,
    createdAt: prev?.createdAt ?? now,
    updatedAt: now,
  };
}
