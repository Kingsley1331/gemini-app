import AppNav from "@/components/AppNav";
import StudioClient from "@/components/StudioClient";

const defaultStudioCode = `export default function App() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-zinc-950 px-6 text-white">
      <div className="text-center">
        <p className="mb-3 text-sm uppercase tracking-[0.3em] text-zinc-400">
          Studio
        </p>
        <h1 className="text-4xl font-bold sm:text-5xl">Hello World</h1>
        <p className="mt-4 text-sm text-zinc-300 sm:text-base">
          Start building your app here.
        </p>
      </div>
    </main>
  );
}`;

type StudioPageProps = {
  searchParams?: Promise<{
    appId?: string;
    draft?: string;
  }>;
};

export default async function StudioPage({ searchParams }: StudioPageProps) {
  const resolvedSearchParams = searchParams ? await searchParams : undefined;

  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-zinc-950">
      <header className="border-b border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-4 sm:px-6">
          <div>
            <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">
              Studio
            </h1>
            <p className="text-sm text-zinc-500 dark:text-zinc-400">
              Preview and iterate on a starter app.
            </p>
          </div>
          <AppNav current="studio" />
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
        <StudioClient
          initialCode={defaultStudioCode}
          initialLanguage="tsx"
          initialTitle="Studio Starter"
          appId={resolvedSearchParams?.appId}
          draftId={resolvedSearchParams?.draft}
        />
      </main>
    </div>
  );
}
