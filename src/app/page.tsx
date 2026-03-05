import { Suspense } from "react";
import Chat from "@/components/Chat";

export default function Home() {
  return (
    <main className="flex min-h-screen items-stretch justify-center bg-zinc-50 p-0 dark:bg-black sm:items-center sm:p-4 md:p-8">
      <Suspense
        fallback={
          <div className="flex h-[90vh] w-full max-w-5xl items-center justify-center rounded-2xl border border-zinc-200 bg-white text-sm text-zinc-500 shadow-xl dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400">
            Loading chat...
          </div>
        }
      >
        <Chat />
      </Suspense>
    </main>
  );
}
