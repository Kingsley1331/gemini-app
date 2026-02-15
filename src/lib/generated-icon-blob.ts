import { del, head, put } from "@vercel/blob";

const hasBlobStorage = Boolean(process.env.BLOB_READ_WRITE_TOKEN);

function getIconPath(id: string, size: 192 | 512) {
  return `generated-icons/${id}/icon-${size}.png`;
}

export async function storeGeneratedIconsInBlob(
  id: string,
  icon192: Uint8Array,
  icon512: Uint8Array
) {
  if (!hasBlobStorage) return null;

  const [blob192, blob512] = await Promise.all([
    put(getIconPath(id, 192), Buffer.from(icon192), {
      access: "public",
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType: "image/png",
    }),
    put(getIconPath(id, 512), Buffer.from(icon512), {
      access: "public",
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType: "image/png",
    }),
  ]);

  return { url192: blob192.url, url512: blob512.url };
}

export async function getGeneratedIconBlobUrl(id: string, size: 192 | 512) {
  if (!hasBlobStorage) return null;
  try {
    const blob = await head(getIconPath(id, size));
    return blob.url;
  } catch {
    return null;
  }
}

export async function deleteGeneratedIconBlobs(id: string) {
  if (!hasBlobStorage) return;
  await Promise.allSettled([
    del(getIconPath(id, 192)),
    del(getIconPath(id, 512)),
  ]);
}
