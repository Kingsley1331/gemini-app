# Developer Setup Guide

This guide is a complete reference for the external services and tools that
`gemini-app` integrates, and how to configure them for local development and for
deployment on Vercel. If you just want to get running fast, jump to
[Quick start](#quick-start) and [Environment variables](#environment-variables).

---

## Table of contents

1. [Overview and tech stack](#overview-and-tech-stack)
2. [Prerequisites](#prerequisites)
3. [Quick start](#quick-start)
4. [Environment variables](#environment-variables)
5. [AI providers (Gemini / OpenAI / Anthropic)](#ai-providers-gemini--openai--anthropic)
6. [Nano Banana (image generation)](#nano-banana-image-generation)
7. [remove.bg (background removal)](#removebg-background-removal)
8. [Firebase (Firestore + Storage)](#firebase-firestore--storage)
9. [Vercel Blob (icon storage)](#vercel-blob-icon-storage)
10. [Text-to-speech](#text-to-speech)
11. [Feature flags (shareable installs)](#feature-flags-shareable-installs)
12. [Running locally](#running-locally)
13. [Deploying to Vercel](#deploying-to-vercel)
14. [Troubleshooting](#troubleshooting)

---

## Overview and tech stack

`gemini-app` is a Next.js application for generating, previewing, and sharing
small web apps with AI assistance. It supports multiple AI providers, generates
images and icons, converts text to speech, and can publish installable PWAs.

Core stack:

- **Next.js 16** (App Router) + **React 19** + **TypeScript 5**
- **Tailwind CSS 4** (via `@tailwindcss/postcss`)
- **`sharp`** for server-side image processing (resize, format conversion,
  transparency handling)
- **Monaco editor** (`@monaco-editor/react`) for the code editor
- **TipTap** for rich-text editing
- **framer-motion** for animation
- **jszip** for exporting projects as ZIP archives
- **katex** + `rehype-katex` / `remark-math` for math rendering
- **react-markdown** + `remark-gfm` for chat markdown

External services (each detailed below): Google Gemini, OpenAI, Anthropic,
remove.bg, Firebase (Firestore + Storage), and Vercel Blob.

> **Live preview note:** The in-app live preview compiles TSX in the browser
> using `@babel/standalone`, pinned to **version 7** on the unpkg CDN. This pin
> is intentional (Babel 8 removed options the current preset relies on). See
> [`TODO.md`](../TODO.md) for the migration plan before changing it.

---

## Prerequisites

- **Node.js 20+** (the project types target `@types/node@20`; Next.js 16 requires
  a modern Node LTS).
- A package manager: **npm** (default), or yarn/pnpm/bun if you prefer.
- Accounts/keys for the services you intend to use (see below). Only
  `GEMINI_API_KEY` is strictly required to run the app.

---

## Quick start

```bash
# 1. Install dependencies
npm install

# 2. Create your local env file from the template
cp .env.example .env.local
#   (Windows PowerShell: Copy-Item .env.example .env.local)

# 3. Fill in at least GEMINI_API_KEY in .env.local

# 4. Start the dev server
npm run dev
```

Then open [http://localhost:3000](http://localhost:3000).

---

## Environment variables

Every variable the app reads is listed below, along with **what reads it** and
whether it is **required**. A copy/paste template lives in
[`.env.example`](../.env.example). For local dev, put values in `.env.local`
(gitignored); for production, set them in the Vercel dashboard.

| Variable | Required | Used by | Purpose |
| --- | --- | --- | --- |
| `GEMINI_API_KEY` | **Yes** | `src/app/api/chat/route.ts`, `src/lib/server/asset-generation.ts`, `src/app/api/generate-image/route.ts`, `src/app/api/preview/[id]/generate-icon/route.ts`, `src/app/api/generate-speech/route.ts` | Core provider: chat/codegen, image generation ("Nano Banana"), SVG assets, PWA icons, TTS |
| `OPENAI_API_KEY` | No | `src/app/api/chat/route.ts` | Enables GPT models in chat |
| `ANTHROPIC_API_KEY` | No | `src/app/api/chat/route.ts` | Enables Claude models in chat |
| `REMOVE_BG_API_KEY` | No | `src/lib/server/asset-generation.ts` | Background removal for transparent assets (falls back to heuristic) |
| `FIREBASE_PROJECT_ID` | Yes* | `src/lib/firebase-admin.ts` | Firebase service account project ID |
| `FIREBASE_CLIENT_EMAIL` | Yes* | `src/lib/firebase-admin.ts` | Firebase service account client email |
| `FIREBASE_PRIVATE_KEY` | Yes* | `src/lib/firebase-admin.ts` | Firebase service account private key (with escaped `\n`) |
| `FIREBASE_STORAGE_BUCKET` | Yes* | `src/lib/firebase-admin.ts` | Cloud Storage bucket name |
| `BLOB_READ_WRITE_TOKEN` | No | `src/lib/generated-icon-blob.ts` | Vercel Blob storage for generated icons |
| `ENABLE_SHAREABLE_INSTALLS` | No | `src/lib/shared-apps.ts` | Server flag: enable publish/share API |
| `NEXT_PUBLIC_ENABLE_SHAREABLE_INSTALLS` | No | `src/components/CodePreview.tsx` | Client flag: show share/install UI |

\* The four `FIREBASE_*` variables are required **together** only if you want
publishing/sharing. If any is missing, Firebase is treated as unconfigured
(`hasFirebaseAdminConfig()` returns `false`) and shared-install features are
disabled gracefully.

**How features degrade when a variable is missing:**

- No `GEMINI_API_KEY` -> chat, image, icon, and TTS routes return a
  `Configuration Error` (HTTP 500) telling you to set the key.
- No `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` -> those models simply error if you
  pick them; Gemini models keep working.
- No `REMOVE_BG_API_KEY` -> transparent-background requests use the built-in
  flood-fill heuristic instead of the dedicated service.
- No Firebase config -> publish/share endpoints return errors and shareable
  installs stay off.
- No `BLOB_READ_WRITE_TOKEN` -> generated icons use in-memory + OS tmp storage
  (fine locally; not durable across serverless invocations in production).

---

## AI providers (Gemini / OpenAI / Anthropic)

The chat endpoint (`src/app/api/chat/route.ts`) supports three providers. The
provider is chosen automatically from the **model ID prefix**:

```ts
function getProvider(modelId: string): Provider {
  if (modelId.startsWith("gemini-")) return "gemini";
  if (modelId.startsWith("gpt-")) return "openai";
  if (modelId.startsWith("claude-")) return "anthropic";
  return "gemini"; // fallback
}
```

The models offered in the picker are defined in `src/components/Chat.tsx` and
`src/components/StudioClient.tsx`:

- **Gemini** (`GEMINI_API_KEY`): `gemini-3.1-pro-preview` (default),
  `gemini-3-pro-preview`, `gemini-3-flash-preview`, `gemini-2.0-flash`
- **OpenAI** (`OPENAI_API_KEY`): `gpt-5.4-thinking`, `gpt-5.2-codex`, `gpt-5.2`,
  `gpt-5-mini`, `gpt-5-nano`
- **Anthropic** (`ANTHROPIC_API_KEY`): `claude-opus-4-6`, `claude-sonnet-4-5`,
  `claude-haiku-4-5`

**Automatic fallback:** For Gemini, `getGeminiModelOrder()` defines a fallback
chain so requests degrade to a still-available model on transient upstream
errors (e.g. `gemini-3.1-pro-preview` -> `gemini-3-pro-preview` ->
`gemini-2.0-flash`). Transient errors (HTTP 429/500/502/503, "high demand",
rate limits) are retried before falling through.

### Getting the keys

- **Gemini:** [Google AI Studio -> API keys](https://aistudio.google.com/apikey)
- **OpenAI:** [platform.openai.com/api-keys](https://platform.openai.com/api-keys)
- **Anthropic:** [console.anthropic.com](https://console.anthropic.com/settings/keys)

---

## Nano Banana (image generation)

"Nano Banana" is the in-app branding for **Gemini image generation**. There is no
separate Nano Banana API or key - it uses your `GEMINI_API_KEY` and Gemini image
models under the hood. You'll see the name in the UI label ("AI Chat &
NanoBanana") and in error messages like `Nano Banana Generation Failed`.

Relevant code:

- `src/lib/server/asset-generation.ts` - core generate/edit logic
- `src/app/api/generate-image/route.ts` - raster image generation endpoint
- `src/app/api/assets/generate/route.ts`, `.../assets/edit-image/route.ts`,
  `.../assets/edit-svg/route.ts` - asset generation/editing endpoints

**Models used** (with fallback ordering controlled by a `pro` flag):

- Raster images: `gemini-3-pro-image-preview` and `gemini-2.5-flash-image`
  (order swaps depending on `pro`).
- SVG assets: `gemini-2.5-flash` (returns validated SVG markup; scripts and
  inline event handlers are rejected).

**Background modes** (`RasterBackgroundMode`):

- `transparent` - isolate the subject on a transparent PNG. Uses remove.bg if
  configured, otherwise a heuristic flood-fill (see next section).
- `solid` - flatten onto a solid `backgroundColor` (defaults to `#ffffff`).
- `original` - keep whatever background the model produced.

Output can be normalized to PNG/JPEG/WebP via `sharp`.

> `next.config.ts` allows remote images from `nanobnana.com` via
> `images.remotePatterns`. This is only relevant if the UI references icons hosted
> there; generated images are returned inline as data URLs or served by the API.

---

## remove.bg (background removal)

When a transparent asset is requested, the app first checks whether the generated
image already has transparent pixels. If not, it calls **remove.bg**:

- Endpoint: `POST https://api.remove.bg/v1.0/removebg`
- Auth header: `X-Api-Key: $REMOVE_BG_API_KEY`
- Form fields: `size=auto`, `format=png`, and the image as `image_file`

If `REMOVE_BG_API_KEY` is not set, or the request fails, the app logs a warning
and falls back to `restoreTransparentBackground()` - a heuristic flood-fill from
the image edges that removes near-uniform, low-saturation background regions.
This keeps the feature working without a key, at lower quality.

Get a key at [remove.bg/api](https://www.remove.bg/api).

---

## Firebase (Firestore + Storage)

Firebase powers persistence for **shared apps**, **draft apps**, their **assets**,
and **generated icons**. It is accessed server-side only via the Admin SDK
(`firebase-admin`), configured in `src/lib/firebase-admin.ts`.

### 1. Create the project and enable services

1. Create a project at the [Firebase console](https://console.firebase.google.com/).
2. Enable **Cloud Firestore** (Native mode).
3. Enable **Cloud Storage** and note the bucket name (usually
   `your-project.appspot.com`).

### 2. Create a service account

1. In the Firebase console: **Project settings -> Service accounts**.
2. Click **Generate new private key** to download a JSON key file.
3. Map the JSON fields to environment variables:
   - `project_id` -> `FIREBASE_PROJECT_ID`
   - `client_email` -> `FIREBASE_CLIENT_EMAIL`
   - `private_key` -> `FIREBASE_PRIVATE_KEY`
   - Storage bucket -> `FIREBASE_STORAGE_BUCKET`

### 3. Private key formatting

`private_key` contains newlines. Store it as a **single line with escaped `\n`**
(and wrap it in quotes). At runtime the app converts them back:

```ts
const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n");
```

Example `.env.local` entry:

```
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nMIIEv...==\n-----END PRIVATE KEY-----\n"
```

### 4. Data layout

The app reads/writes these paths (see `src/lib/shared-apps.ts` and
`src/lib/shared-apps-store.ts`):

- Firestore docs: `apps/{id}` (published apps), `draft-apps/{id}` (drafts)
- Storage: `shared-apps/{id}/assets/{key}`, `shared-apps/{id}/icons/icon-{192|512}.png`,
  and `draft-apps/{id}/assets/{key}`

If all four variables are present, `hasFirebaseAdminConfig()` returns `true` and
the SDK is initialized lazily on first use.

---

## Vercel Blob (icon storage)

Generated PWA icons can be cached in **Vercel Blob** so they persist across
serverless invocations (local tmp storage is ephemeral in production).

- Configured via `BLOB_READ_WRITE_TOKEN` (`src/lib/generated-icon-blob.ts`).
- When present, icons are stored at `generated-icons/{id}/icon-{192|512}.png`
  with public access, and the public Blob URLs are returned.
- When absent, the app falls back to in-memory + OS tmp storage and serves icons
  through the `GET /api/preview/[id]/generate-icon?size=...` route.

To create a store and token: in the Vercel dashboard go to **Storage -> Create ->
Blob**, then connect it to the project (this provisions `BLOB_READ_WRITE_TOKEN`
automatically for deployments). For local dev, copy the token into `.env.local`.

---

## Text-to-speech

The `POST /api/generate-speech` route (`src/app/api/generate-speech/route.ts`)
streams audio using Gemini native TTS:

- Model: `gemini-2.5-pro-preview-tts`
- Voice: `Zephyr` (prebuilt voice config)
- Response is streamed as newline-delimited JSON (`application/x-ndjson`) with
  base64 audio chunks.

**Regional/availability caveat:** If native audio isn't available for your API
key or region, the route returns `GEMINI_MODALITY_UNSUPPORTED` (HTTP 200) so the
client can degrade gracefully rather than hard-fail.

Requires `GEMINI_API_KEY`.

---

## Feature flags (shareable installs)

Publishing and installing shared PWAs is gated behind a two-part flag:

- `ENABLE_SHAREABLE_INSTALLS` - **server** flag, read by
  `isShareableInstallsEnabled()` in `src/lib/shared-apps.ts`. Gates the
  publish/share API (`src/app/api/apps/publish/route.ts`).
- `NEXT_PUBLIC_ENABLE_SHAREABLE_INSTALLS` - **client** flag, read in
  `src/components/CodePreview.tsx`. Gates the share/install UI.

Both accept `"1"` or `"true"`. Set **both** to enable the feature end-to-end,
and make sure **Firebase is configured** - `publish` returns HTTP 503 if the flag
is off and HTTP 500 if Firebase is missing.

---

## Running locally

```bash
npm run dev     # start the dev server on http://localhost:3000
npm run build   # production build
npm run start   # run the production build locally
npm run lint    # ESLint
```

Reminder: after editing `.env.local`, **restart** `npm run dev` - Next.js reads
env files at startup.

---

## Deploying to Vercel

1. Import the repository into Vercel (it auto-detects Next.js).
2. Add every environment variable under **Project Settings -> Environment
   Variables**, choosing the correct scope (**Production**, **Preview**, and/or
   **Development**) for each. At minimum set `GEMINI_API_KEY`.
3. For `FIREBASE_PRIVATE_KEY`, paste the key with the escaped `\n` sequences (the
   same single-line format used in `.env.example`). Keep the surrounding quotes if
   your value includes them locally; in the Vercel UI you can paste the multi-line
   value directly and the `\n`-replace at runtime still works as long as newlines
   are represented consistently with how the code expects them.
4. If you use Vercel Blob, create the Blob store under **Storage** and connect it
   to the project; `BLOB_READ_WRITE_TOKEN` is injected automatically.
5. **Redeploy after changing env vars** - Vercel only applies env changes to new
   deployments, not existing ones.

---

## Troubleshooting

- **"GEMINI_API_KEY is not defined"** - set it in `.env.local` (local) or Vercel
  env vars (deployed), then restart/redeploy.
- **"Missing Firebase configuration"** - one of the four `FIREBASE_*` vars is
  unset. Publishing/sharing needs all four.
- **Private key errors from Firebase** - the `\n` sequences aren't formatted
  correctly. Ensure literal `\n` in the stored value; the app converts them at
  runtime.
- **Transparent images look rough** - `REMOVE_BG_API_KEY` is unset, so the
  heuristic fallback is being used. Add a key for higher quality.
- **Icons disappear between requests in production** - set
  `BLOB_READ_WRITE_TOKEN` so icons persist beyond a single serverless invocation.
- **Live preview breaks after a Babel change** - the preview relies on
  `@babel/standalone@7`; see [`TODO.md`](../TODO.md).
