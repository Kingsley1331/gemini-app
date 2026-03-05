"use client";

import type { Message } from "@/components/MessageItem";

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

export function getChatSessionState(): ChatSessionState {
  return chatSessionState;
}

export function setChatSessionState(nextState: ChatSessionState) {
  chatSessionState = nextState;
}

export function resetChatSessionState() {
  chatSessionState = createEmptyChatSessionState();
  return chatSessionState;
}
