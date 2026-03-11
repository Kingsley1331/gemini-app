"use client";

import Link from "next/link";

type AppNavProps = {
  current: "chat" | "apps" | "studio";
};

export default function AppNav({ current }: AppNavProps) {
  const baseClass =
    "rounded-lg px-3 py-1.5 text-sm font-medium transition-colors";

  return (
    <nav className="inline-flex items-center gap-1 rounded-xl border border-zinc-200 bg-white p-1 dark:border-zinc-700 dark:bg-zinc-800">
      <Link
        href="/"
        className={`${baseClass} ${
          current === "chat"
            ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
            : "text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-700 dark:hover:text-zinc-100"
        }`}
      >
        Chat
      </Link>
      <Link
        href="/studio"
        className={`${baseClass} ${
          current === "studio"
            ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
            : "text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-700 dark:hover:text-zinc-100"
        }`}
      >
        Studio
      </Link>
      <Link
        href="/apps"
        className={`${baseClass} ${
          current === "apps"
            ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
            : "text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-700 dark:hover:text-zinc-100"
        }`}
      >
        Apps
      </Link>
    </nav>
  );
}
