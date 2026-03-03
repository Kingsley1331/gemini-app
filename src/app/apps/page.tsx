"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { getAllSavedApps, deleteSavedApp, type SavedApp } from "@/lib/saved-apps-idb";
import AppNav from "@/components/AppNav";

type RemoteApp = {
  id: string;
  name: string;
  hasIcon: boolean;
  iconUrl?: string;
  updatedAt: number;
};

type MergedApp = {
  id: string;
  name: string;
  timestamp: number;
  local?: SavedApp;
  remote?: RemoteApp;
};

export default function AppsPage() {
  const router = useRouter();
  const [localApps, setLocalApps] = useState<SavedApp[]>([]);
  const [remoteApps, setRemoteApps] = useState<RemoteApp[]>([]);
  const [loadedLocal, setLoadedLocal] = useState(false);
  const [loadedRemote, setLoadedRemote] = useState(false);
  const [brokenRemoteIcons, setBrokenRemoteIcons] = useState<Record<string, boolean>>({});

  useEffect(() => {
    getAllSavedApps()
      .then((result) => {
        setLocalApps(result);
      })
      .finally(() => setLoadedLocal(true));

    fetch("/api/apps", { cache: "no-store" })
      .then(async (resp) => {
        if (!resp.ok) return;
        const data = (await resp.json()) as { apps?: RemoteApp[] };
        setRemoteApps(Array.isArray(data.apps) ? data.apps : []);
      })
      .catch(() => {
        setRemoteApps([]);
      })
      .finally(() => setLoadedRemote(true));
  }, []);

  const apps = useMemo<MergedApp[]>(() => {
    const merged = new Map<string, MergedApp>();

    for (const remote of remoteApps) {
      merged.set(remote.id, {
        id: remote.id,
        name: remote.name,
        timestamp: remote.updatedAt || 0,
        remote,
      });
    }

    for (const local of localApps) {
      const existing = merged.get(local.id);
      if (existing) {
        merged.set(local.id, {
          ...existing,
          name: local.name || existing.name,
          timestamp: Math.max(existing.timestamp, local.timestamp || 0),
          local,
        });
      } else {
        merged.set(local.id, {
          id: local.id,
          name: local.name,
          timestamp: local.timestamp || 0,
          local,
        });
      }
    }

    return Array.from(merged.values()).sort((a, b) => b.timestamp - a.timestamp);
  }, [localApps, remoteApps]);

  const handleDelete = async (e: React.MouseEvent, appId: string) => {
    e.stopPropagation();
    await deleteSavedApp(appId);
    setLocalApps((prev) => prev.filter((a) => a.id !== appId));
  };

  const loaded = loadedLocal && loadedRemote;

  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-zinc-950">
      <header className="border-b border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 py-4 flex items-center justify-between">
          <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">
            My Apps
          </h1>
          <AppNav current="apps" />
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-4 sm:px-6 py-8">
        {!loaded ? (
          <p className="text-center text-zinc-400 py-20">Loading...</p>
        ) : apps.length === 0 ? (
          <div className="text-center py-20">
            <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-zinc-100 dark:bg-zinc-800 mb-4">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-zinc-400">
                <rect x="3" y="3" width="7" height="7" />
                <rect x="14" y="3" width="7" height="7" />
                <rect x="14" y="14" width="7" height="7" />
                <rect x="3" y="14" width="7" height="7" />
              </svg>
            </div>
            <h2 className="text-lg font-medium text-zinc-700 dark:text-zinc-300 mb-1">
              No apps yet
            </h2>
            <p className="text-sm text-zinc-400">
              Save or publish an app to see it here.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
            {apps.map((app) => (
              <div
                key={app.id}
                onClick={() => router.push(`/preview/${app.id}`)}
                className="group relative flex flex-col items-center gap-3 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-4 cursor-pointer hover:border-zinc-400 dark:hover:border-zinc-600 hover:shadow-md transition-all"
              >
                {app.local ? (
                  <button
                    onClick={(e) => handleDelete(e, app.id)}
                    className="absolute top-2 right-2 w-6 h-6 flex items-center justify-center rounded-full text-zinc-300 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-950/30 opacity-0 group-hover:opacity-100 transition-all"
                    title="Remove local copy"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="18" y1="6" x2="6" y2="18" />
                      <line x1="6" y1="6" x2="18" y2="18" />
                    </svg>
                  </button>
                ) : null}

                {/* Icon */}
                <div className="w-16 h-16 rounded-2xl bg-zinc-100 dark:bg-zinc-800 flex items-center justify-center overflow-hidden shrink-0">
                  {app.local?.hasIcon && app.local.iconBase64 ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={`data:image/png;base64,${app.local.iconBase64}`}
                      alt={app.name}
                      className="w-full h-full object-cover"
                    />
                  ) : app.remote?.iconUrl && !brokenRemoteIcons[app.id] ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={app.remote.iconUrl}
                      alt={app.name}
                      className="w-full h-full object-cover"
                      onError={() =>
                        setBrokenRemoteIcons((prev) => ({ ...prev, [app.id]: true }))
                      }
                    />
                  ) : (
                    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-zinc-400">
                      <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                      <line x1="3" y1="9" x2="21" y2="9" />
                      <line x1="9" y1="21" x2="9" y2="9" />
                    </svg>
                  )}
                </div>

                {/* Name */}
                <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300 text-center truncate w-full">
                  {app.name}
                </span>
                <span className="text-[10px] uppercase tracking-wide text-zinc-400 dark:text-zinc-500">
                  {app.local && app.remote ? "Local + Remote" : app.local ? "Local" : "Remote"}
                </span>
              </div>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
