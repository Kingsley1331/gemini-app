"use client";

import type { Message } from "@/components/MessageItem";

const CHAT_SESSION_STORAGE_KEY = "chat-session-state";

export type ChatSessionImage = {
  url: string;
  mimeType: string;
  data: string;
};

export type ChatSessionAsset = ChatSessionImage & {
  assetKey?: string;
};

export type ChatSessionState = {
  messages: Message[];
  input: string;
  isRichText: boolean;
  richTextContent: string;
  assetLibrary: Record<string, ChatSessionAsset>;
  selectedImage: ChatSessionImage | null;
};

function createEmptyChatSessionState(): ChatSessionState {
  return {
    messages: [],
    input: "",
    isRichText: false,
    richTextContent: "",
    assetLibrary: {},
    selectedImage: null,
  };
}

let chatSessionState = createEmptyChatSessionState();
let hasHydratedChatSessionState = false;

function toDataUrl(mimeType: string, data: string): string {
  return `data:${mimeType};base64,${data}`;
}

function normalizeSessionImage(
  image: ChatSessionImage | null | undefined,
): ChatSessionImage | null {
  if (!image?.mimeType || !image.data) return null;

  const fallbackUrl = toDataUrl(image.mimeType, image.data);
  return {
    url: image.url?.startsWith("blob:") ? fallbackUrl : image.url || fallbackUrl,
    mimeType: image.mimeType,
    data: image.data,
  };
}

function normalizeChatSessionState(state: ChatSessionState): ChatSessionState {
  const assetLibrary = Object.fromEntries(
    Object.entries(state.assetLibrary || {}).flatMap(([key, asset]) => {
      const normalizedAsset = normalizeSessionImage(asset);
      return normalizedAsset ? [[key, { ...normalizedAsset, assetKey: asset.assetKey }]] : [];
    }),
  );

  return {
    messages: Array.isArray(state.messages) ? state.messages : [],
    input: typeof state.input === "string" ? state.input : "",
    isRichText: state.isRichText === true,
    richTextContent:
      typeof state.richTextContent === "string" ? state.richTextContent : "",
    assetLibrary,
    selectedImage: normalizeSessionImage(state.selectedImage),
  };
}

function hydrateChatSessionState() {
  if (hasHydratedChatSessionState || typeof window === "undefined") return;
  hasHydratedChatSessionState = true;

  try {
    const rawState = window.sessionStorage.getItem(CHAT_SESSION_STORAGE_KEY);
    if (!rawState) return;

    chatSessionState = normalizeChatSessionState(
      JSON.parse(rawState) as ChatSessionState,
    );
  } catch (error) {
    console.warn("Failed to restore chat session state:", error);
  }
}

export function getChatSessionState(): ChatSessionState {
  hydrateChatSessionState();
  return chatSessionState;
}

export function setChatSessionState(nextState: ChatSessionState) {
  chatSessionState = normalizeChatSessionState(nextState);

  if (typeof window === "undefined") return;

  try {
    window.sessionStorage.setItem(
      CHAT_SESSION_STORAGE_KEY,
      JSON.stringify(chatSessionState),
    );
  } catch (error) {
    console.warn("Failed to persist chat session state:", error);
  }
}

export function resetChatSessionState() {
  chatSessionState = createEmptyChatSessionState();

  if (typeof window !== "undefined") {
    try {
      window.sessionStorage.removeItem(CHAT_SESSION_STORAGE_KEY);
    } catch (error) {
      console.warn("Failed to clear chat session state:", error);
    }
  }

  return chatSessionState;
}
