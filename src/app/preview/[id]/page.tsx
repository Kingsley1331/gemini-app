"use client";

import dynamic from "next/dynamic";

// Dynamically import with SSR disabled — this component reads localStorage
// which is only available on the client. Skipping SSR avoids hydration mismatches.
const PreviewClient = dynamic(() => import("./PreviewClient"), { ssr: false });

export default function PreviewPage() {
  return <PreviewClient />;
}
