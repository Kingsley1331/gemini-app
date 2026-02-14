type IconEntry = {
  icon192: Buffer;
  icon512: Buffer;
  timestamp: number;
};

const globalStore = globalThis as typeof globalThis & {
  __generatedPwaIconStore?: Map<string, IconEntry>;
};

const iconStore =
  globalStore.__generatedPwaIconStore ??
  (globalStore.__generatedPwaIconStore = new Map<string, IconEntry>());

export function setGeneratedIcons(
  id: string,
  entry: { icon192: Buffer; icon512: Buffer; timestamp?: number }
) {
  iconStore.set(id, {
    icon192: entry.icon192,
    icon512: entry.icon512,
    timestamp: entry.timestamp ?? Date.now(),
  });
}

export function getGeneratedIcon(id: string, size: 192 | 512): Buffer | null {
  const entry = iconStore.get(id);
  if (!entry) return null;
  return size === 192 ? entry.icon192 : entry.icon512;
}

export function deleteGeneratedIcons(id: string) {
  iconStore.delete(id);
}
