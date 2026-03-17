"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Bot,
  ChevronDown,
  Loader2,
  Mic,
  Paperclip,
  RotateCcw,
  Send,
  Sparkles,
  Type,
  Upload,
  User,
  Wand2,
  X,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { vscDarkPlus } from "react-syntax-highlighter/dist/esm/styles/prism";
import { loadAppBootstrapData } from "@/lib/app-bootstrap";
import type { AppAsset } from "@/lib/app-assets";
import {
  buildPreviewContextRequestMessage,
  type ChatRequestMessage,
} from "@/lib/preview-chat-context";
import {
  extractLatestPreviewableCodeBlock,
  normalizePreviewLanguage,
  parsePreviewEditResponse,
} from "@/lib/preview-edit-response";
import {
  areStudioCodePreviewUiStatesEqual,
  getActiveStudioSessionKey,
  getStudioSessionKey,
  loadStudioSession,
  removeStudioSession,
  saveStudioSession,
  setActiveStudioSessionKey,
  type StudioSessionBaseline,
  type StudioCodePreviewUiState,
  type StudioSessionImage,
  type StudioSessionMessage,
  type StudioSessionState,
} from "@/lib/studio-session-store";
import CodePreview from "@/components/CodePreview";
import RichTextEditor, { RichTextEditorRef } from "./RichTextEditor";
import PromptAssistant from "./PromptAssistant";

const SELECTED_MODEL_STORAGE_KEY = "selectedModel";
const STUDIO_DRAFT_STORAGE_PREFIX = "studio-draft:";
type StudioClientProps = {
  initialCode: string;
  initialLanguage: string;
  initialTitle: string;
  appId?: string;
  draftId?: string;
};

type StudioPreviewAsset = AppAsset;

type StudioModel = {
  id: string;
  name: string;
  description: string;
  provider: "gemini" | "openai" | "anthropic";
};

type SelectedImage = StudioSessionImage;
type StudioMessage = StudioSessionMessage;

type StudioDraftPayload = {
  code: string;
  language: string;
  title?: string;
  assets?: StudioPreviewAsset[];
};

type StudioRouteBaseline = StudioSessionBaseline;

interface SpeechRecognitionEvent extends Event {
  resultIndex: number;
  results: SpeechRecognitionResultList;
}

interface SpeechRecognitionErrorEvent extends Event {
  error: string;
}

interface SpeechRecognition extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  onresult: (event: SpeechRecognitionEvent) => void;
  onerror: (event: SpeechRecognitionErrorEvent) => void;
  onstart: () => void;
  onend: () => void;
  start: () => void;
  stop: () => void;
}

export default function StudioClient({
  initialCode,
  initialLanguage,
  initialTitle,
  appId,
  draftId,
}: StudioClientProps) {
  const hasBootstrapTarget = Boolean(appId || draftId);
  const sessionKey = useMemo(
    () => getStudioSessionKey(appId, draftId),
    [appId, draftId],
  );
  const starterBaseline = useMemo<StudioRouteBaseline>(
    () => ({
      code: initialCode,
      language: initialLanguage,
      title: initialTitle,
      assets: [],
    }),
    [initialCode, initialLanguage, initialTitle],
  );
  const [input, setInput] = useState("");
  const [isRichText, setIsRichText] = useState(false);
  const [richTextContent, setRichTextContent] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [isMicInitializing, setIsMicInitializing] = useState(false);
  const [selectedModel, setSelectedModel] = useState("gemini-3.1-pro-preview");
  const [isModelDropdownOpen, setIsModelDropdownOpen] = useState(false);
  const [isPromptAssistantOpen, setIsPromptAssistantOpen] = useState(false);
  const [selectedImage, setSelectedImage] = useState<SelectedImage | null>(null);
  const [isConversationOpen, setIsConversationOpen] = useState(false);
  const [messages, setMessages] = useState<StudioMessage[]>([]);
  const [previewCode, setPreviewCode] = useState(initialCode);
  const [previewComparisonCode, setPreviewComparisonCode] = useState<string | null>(null);
  const [previewLanguage, setPreviewLanguage] = useState(initialLanguage);
  const [previewTitle, setPreviewTitle] = useState(initialTitle);
  const [previewAssets, setPreviewAssets] = useState<StudioPreviewAsset[]>([]);
  const [isPreviewBootstrapping, setIsPreviewBootstrapping] =
    useState(hasBootstrapTarget);
  const [codePreviewUiState, setCodePreviewUiState] =
    useState<StudioCodePreviewUiState | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [lastPrompt, setLastPrompt] = useState<string | null>(null);
  const [activeSessionKey, setActiveSessionKey] = useState<string | null>(null);
  const [isResetModalOpen, setIsResetModalOpen] = useState(false);
  const [isResettingStudio, setIsResettingStudio] = useState(false);
  const modelDropdownRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const codeFileInputRef = useRef<HTMLInputElement>(null);
  const richTextRef = useRef<RichTextEditorRef>(null);
  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const activeBootstrapRequestRef = useRef(0);
  const resolvedBootstrapKeyRef = useRef<string | null>(null);
  const cachedDraftsRef = useRef<Record<string, StudioDraftPayload>>({});
  const routeBaselineRef = useRef<StudioRouteBaseline>(starterBaseline);

  const models = useMemo<StudioModel[]>(
    () => [
      {
        id: "gemini-3.1-pro-preview",
        name: "Gemini 3.1 Pro",
        description: "Latest, most capable Gemini model",
        provider: "gemini",
      },
      {
        id: "gemini-3-pro-preview",
        name: "Gemini 3 Pro",
        description: "Most intelligent Gemini model",
        provider: "gemini",
      },
      {
        id: "gemini-3-flash-preview",
        name: "Gemini 3 Flash",
        description: "Fast and versatile",
        provider: "gemini",
      },
      {
        id: "gemini-2.0-flash",
        name: "Gemini 2.0 Flash",
        description: "Fastest Gemini model",
        provider: "gemini",
      },
      {
        id: "gpt-5.4-thinking",
        name: "GPT-5.4 Thinking",
        description: "High-reasoning mode for harder tasks",
        provider: "openai",
      },
      {
        id: "gpt-5.2-codex",
        name: "GPT-5.2 Codex",
        description: "Best coding model, agentic tasks",
        provider: "openai",
      },
      {
        id: "gpt-5.2",
        name: "GPT-5.2",
        description: "Best for coding and agentic tasks",
        provider: "openai",
      },
      {
        id: "gpt-5-mini",
        name: "GPT-5 mini",
        description: "Faster, cost-efficient",
        provider: "openai",
      },
      {
        id: "gpt-5-nano",
        name: "GPT-5 nano",
        description: "Fastest, most cost-efficient",
        provider: "openai",
      },
      {
        id: "claude-opus-4-6",
        name: "Claude Opus 4.6",
        description: "Most intelligent Claude model",
        provider: "anthropic",
      },
      {
        id: "claude-sonnet-4-5",
        name: "Claude Sonnet 4.5",
        description: "Speed and intelligence balance",
        provider: "anthropic",
      },
      {
        id: "claude-haiku-4-5",
        name: "Claude Haiku 4.5",
        description: "Fastest Claude model",
        provider: "anthropic",
      },
    ],
    [],
  );

  const providerLabels: Record<StudioModel["provider"], string> = {
    gemini: "Gemini",
    openai: "OpenAI",
    anthropic: "Anthropic",
  };

  const resetTransientStudioState = useCallback(() => {
    setInput("");
    setIsRichText(false);
    setRichTextContent("");
    setSelectedImage(null);
    setIsConversationOpen(false);
    setMessages([]);
    setCodePreviewUiState(null);
    setLastPrompt(null);
  }, []);

  const setRouteBaseline = useCallback((baseline: StudioRouteBaseline) => {
    routeBaselineRef.current = {
      code: baseline.code,
      language: baseline.language,
      title: baseline.title,
      assets: [...baseline.assets],
    };
  }, []);

  const applyPersistedSession = useCallback((session: StudioSessionState) => {
    setRouteBaseline(session.routeBaseline);
    setInput(session.input);
    setIsRichText(session.isRichText);
    setRichTextContent(session.richTextContent);
    setSelectedImage(session.selectedImage);
    setIsConversationOpen(session.isConversationOpen);
    setMessages(session.messages);
    setPreviewCode(session.previewCode);
    setPreviewComparisonCode(session.previewComparisonCode);
    setPreviewLanguage(session.previewLanguage);
    setPreviewTitle(session.previewTitle);
    setPreviewAssets(session.previewAssets);
    setCodePreviewUiState(session.codePreviewUi);
  }, [setRouteBaseline]);

  const applyPreviewBaseline = useCallback((baseline: StudioRouteBaseline) => {
    setPreviewCode(baseline.code);
    setPreviewComparisonCode(null);
    setPreviewLanguage(baseline.language);
    setPreviewTitle(baseline.title);
    setPreviewAssets([...baseline.assets]);
    setCodePreviewUiState(null);
  }, []);

  const restoreRouteBaseline = useCallback(() => {
    applyPreviewBaseline(routeBaselineRef.current);
  }, [applyPreviewBaseline]);

  const handleCodePreviewUiStateChange = useCallback(
    (nextState: StudioCodePreviewUiState) => {
      setCodePreviewUiState((currentState) => {
        if (areStudioCodePreviewUiStatesEqual(currentState, nextState)) {
          return currentState;
        }

        return nextState;
      });
    },
    [],
  );

  const groupedModels = useMemo(
    () =>
      models.reduce(
        (acc, model) => {
          if (!acc[model.provider]) acc[model.provider] = [];
          acc[model.provider].push(model);
          return acc;
        },
        {
          gemini: [],
          openai: [],
          anthropic: [],
        } as Record<StudioModel["provider"], StudioModel[]>,
      ),
    [models],
  );

  useEffect(() => {
    if (typeof window === "undefined") return;

    try {
      const storedModel = window.localStorage.getItem(
        SELECTED_MODEL_STORAGE_KEY,
      );
      if (storedModel && models.some((model) => model.id === storedModel)) {
        setSelectedModel(storedModel);
      }
    } catch (error) {
      console.warn("Failed to read selected model from localStorage:", error);
    }
  }, [models]);

  useEffect(() => {
    if (typeof window === "undefined") return;

    try {
      window.localStorage.setItem(SELECTED_MODEL_STORAGE_KEY, selectedModel);
    } catch (error) {
      console.warn("Failed to save selected model to localStorage:", error);
    }
  }, [selectedModel]);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        modelDropdownRef.current &&
        !modelDropdownRef.current.contains(event.target as Node)
      ) {
        setIsModelDropdownOpen(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, []);

  useEffect(() => {
    if (
      typeof window !== "undefined" &&
      ("SpeechRecognition" in window || "webkitSpeechRecognition" in window)
    ) {
      const SpeechRecognitionConstructor =
        (window as Window & {
          SpeechRecognition?: new () => SpeechRecognition;
          webkitSpeechRecognition?: new () => SpeechRecognition;
        }).SpeechRecognition ||
        (window as Window & {
          SpeechRecognition?: new () => SpeechRecognition;
          webkitSpeechRecognition?: new () => SpeechRecognition;
        }).webkitSpeechRecognition;

      if (!SpeechRecognitionConstructor) return;

      const recognition = new SpeechRecognitionConstructor();
      recognition.continuous = true;
      recognition.interimResults = true;

      recognition.onresult = (event: SpeechRecognitionEvent) => {
        let transcript = "";
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const result = event.results[i];
          if (result) transcript += result[0].transcript;
        }

        if (isRichText) {
          richTextRef.current?.setContent(transcript);
          setRichTextContent(transcript);
        } else {
          setInput(transcript);
        }
      };

      recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
        console.error("Speech recognition error:", event.error);
        setIsListening(false);
        setIsMicInitializing(false);
      };

      recognition.onstart = () => {
        window.setTimeout(() => {
          setIsListening(true);
          setIsMicInitializing(false);
        }, 200);
      };

      recognition.onend = () => {
        setIsListening(false);
        setIsMicInitializing(false);
      };

      recognitionRef.current = recognition;
    }

    return () => {
      try {
        recognitionRef.current?.stop();
      } catch {
        // Recognition may already be stopped.
      }
    };
  }, [isRichText]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [isLoading, messages]);

  useEffect(() => {
    if (isPreviewBootstrapping || !activeSessionKey) return;

    saveStudioSession(activeSessionKey, {
      input,
      isRichText,
      richTextContent,
      selectedImage,
      isConversationOpen,
      messages,
      previewCode,
      previewComparisonCode,
      previewLanguage,
      previewTitle,
      previewAssets,
      codePreviewUi: codePreviewUiState,
      routeBaseline: routeBaselineRef.current,
    });
    setActiveStudioSessionKey(activeSessionKey);
  }, [
    activeSessionKey,
    codePreviewUiState,
    input,
    isConversationOpen,
    isPreviewBootstrapping,
    isRichText,
    messages,
    previewAssets,
    previewCode,
    previewComparisonCode,
    previewLanguage,
    previewTitle,
    richTextContent,
    selectedImage,
  ]);

  useEffect(() => {
    const nextBootstrapKey = sessionKey;

    const restorePersistedSession = (targetSessionKey = nextBootstrapKey) => {
      const storedSession = loadStudioSession(targetSessionKey);
      if (!storedSession) return false;
      applyPersistedSession(storedSession);
      return true;
    };

    if (resolvedBootstrapKeyRef.current === nextBootstrapKey) {
      setIsPreviewBootstrapping(false);
      setActiveSessionKey((current) => current ?? nextBootstrapKey);
      return;
    }

    setActiveSessionKey(null);
    activeBootstrapRequestRef.current += 1;
    const requestId = activeBootstrapRequestRef.current;
    const isActiveRequest = () => activeBootstrapRequestRef.current === requestId;

    if (!draftId && !appId) {
      const activeStudioSessionKey = getActiveStudioSessionKey();
      setRouteBaseline({
        code: initialCode,
        language: initialLanguage,
        title: initialTitle,
        assets: [],
      });
      resetTransientStudioState();
      resolvedBootstrapKeyRef.current = nextBootstrapKey;
      setIsPreviewBootstrapping(false);
      restoreRouteBaseline();
      setStatusMessage(null);
      if (
        activeStudioSessionKey &&
        activeStudioSessionKey !== nextBootstrapKey &&
        restorePersistedSession(activeStudioSessionKey)
      ) {
        setActiveSessionKey(activeStudioSessionKey);
      } else if (restorePersistedSession()) {
        setActiveSessionKey(nextBootstrapKey);
      } else {
        setActiveSessionKey(nextBootstrapKey);
      }
      return () => {
        if (activeBootstrapRequestRef.current === requestId) {
          activeBootstrapRequestRef.current += 1;
        }
      };
    }

    setIsPreviewBootstrapping(true);

    if (draftId) {
      if (typeof window === "undefined") return;

      try {
        resetTransientStudioState();
        const cachedDraft = cachedDraftsRef.current[draftId];
        let parsedDraft = cachedDraft;

        if (!parsedDraft) {
          const rawDraft = window.sessionStorage.getItem(
            `${STUDIO_DRAFT_STORAGE_PREFIX}${draftId}`,
          );
          if (!rawDraft) {
            if (!isActiveRequest()) return;
            if (restorePersistedSession()) {
              resolvedBootstrapKeyRef.current = nextBootstrapKey;
              setIsPreviewBootstrapping(false);
              setActiveSessionKey(nextBootstrapKey);
              return;
            }
            setStatusMessage("That Studio draft is no longer available.");
            setIsPreviewBootstrapping(false);
            return;
          }

          parsedDraft = JSON.parse(rawDraft) as StudioDraftPayload;
          cachedDraftsRef.current[draftId] = parsedDraft;
        }

        if (!isActiveRequest()) {
          return;
        }

        if (!parsedDraft) {
          if (restorePersistedSession()) {
            resolvedBootstrapKeyRef.current = nextBootstrapKey;
            setIsPreviewBootstrapping(false);
            setActiveSessionKey(nextBootstrapKey);
            return;
          }
          setStatusMessage("That Studio draft is no longer available.");
          setIsPreviewBootstrapping(false);
          return;
        }

        setRouteBaseline({
          code: parsedDraft.code || initialCode,
          language: parsedDraft.language || initialLanguage,
          title: parsedDraft.title || "Studio Draft",
          assets: Array.isArray(parsedDraft.assets) ? parsedDraft.assets : [],
        });
        restoreRouteBaseline();
        setStatusMessage("Loaded preview into Studio.");
        setMessages((prev) => [
          ...prev,
          {
            id: `${Date.now()}`,
            role: "assistant",
            content: "Loaded a preview draft into Studio.",
          },
        ]);
        restorePersistedSession();
        resolvedBootstrapKeyRef.current = nextBootstrapKey;
        setIsPreviewBootstrapping(false);
        setActiveSessionKey(nextBootstrapKey);
      } catch (error) {
        if (!isActiveRequest()) {
          return;
        }
        console.error("Failed to hydrate Studio draft:", error);
        setStatusMessage("Unable to load that Studio draft.");
        setIsPreviewBootstrapping(false);
      }
      return () => {
        if (activeBootstrapRequestRef.current === requestId) {
          activeBootstrapRequestRef.current += 1;
        }
      };
    }

    if (!appId) return;

    void (async () => {
      resetTransientStudioState();
      const loaded = await loadAppBootstrapData(appId);
      if (!isActiveRequest()) return;
      if (!loaded) {
        setStatusMessage("I couldn't load this app in Studio.");
        setIsPreviewBootstrapping(false);
        return;
      }

      setRouteBaseline({
        code: loaded.code,
        language: loaded.language || "tsx",
        title: loaded.name || "Studio App",
        assets: loaded.assets,
      });
      restoreRouteBaseline();
      setStatusMessage(`Loaded "${loaded.name}" into Studio.`);
      setMessages((prev) => [
        ...prev,
        {
          id: `${Date.now()}`,
          role: "assistant",
          content: `Loaded \`${loaded.name}\` from My Apps into Studio.`,
        },
      ]);
      restorePersistedSession();
      resolvedBootstrapKeyRef.current = nextBootstrapKey;
      setIsPreviewBootstrapping(false);
      setActiveSessionKey(nextBootstrapKey);
    })();

    return () => {
      if (activeBootstrapRequestRef.current === requestId) {
        activeBootstrapRequestRef.current += 1;
      }
    };
  }, [
    appId,
    applyPersistedSession,
    draftId,
    initialCode,
    initialLanguage,
    initialTitle,
    restoreRouteBaseline,
    resetTransientStudioState,
    sessionKey,
    setRouteBaseline,
  ]);

  const handleImageSelect = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (!file) return;

      if (!file.type.startsWith("image/")) {
        window.alert("Please select an image file.");
        return;
      }

      const reader = new FileReader();
      reader.onload = (loadEvent) => {
        const result = loadEvent.target?.result;
        if (typeof result !== "string") return;
        const base64String = result.split(",")[1];
        if (!base64String) return;

        setSelectedImage({
          url: URL.createObjectURL(file),
          mimeType: file.type,
          data: base64String,
        });
        setStatusMessage("Image attached. It will be included in the next Studio request.");
      };
      reader.readAsDataURL(file);
      event.target.value = "";
    },
    [],
  );

  const handleCodeUpload = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (!file) return;

      const getLanguageFromFileName = (fileName: string): string => {
        const lowerName = fileName.toLowerCase();
        if (lowerName.endsWith(".tsx")) return "tsx";
        if (lowerName.endsWith(".ts")) return "tsx";
        if (lowerName.endsWith(".jsx")) return "jsx";
        if (lowerName.endsWith(".js")) return "jsx";
        if (lowerName.endsWith(".html")) return "html";
        return "tsx";
      };

      const reader = new FileReader();
      reader.onload = (loadEvent) => {
        const content = loadEvent.target?.result;
        if (typeof content !== "string") return;

        setPreviewCode(content);
        setPreviewComparisonCode(null);
        setPreviewLanguage(getLanguageFromFileName(file.name));
        setPreviewTitle(file.name);
        setPreviewAssets([]);
        setStatusMessage(`Preview updated from uploaded file: ${file.name}.`);
        setLastPrompt(null);
        setMessages((prev) => [
          ...prev,
          {
            id: `${Date.now()}`,
            role: "assistant",
            content: `Updated the Studio preview from uploaded file \`${file.name}\`.`,
          },
        ]);
      };
      reader.readAsText(file);
      event.target.value = "";
    },
    [],
  );

  const handleKeepDraft = useCallback(
    (draft: string) => {
      if (isRichText) {
        richTextRef.current?.setContent(draft);
        setRichTextContent(draft);
      } else {
        setInput(draft);
      }
      setIsPromptAssistantOpen(false);
    },
    [isRichText],
  );

  const handlePreviewSnapshot = useCallback(
    (snapshot: { url: string; mimeType: string; data: string }) => {
      setSelectedImage(snapshot);
      setStatusMessage("Snapshot attached for the next Studio request.");
    },
    [],
  );

  const toggleListening = useCallback(() => {
    if (!recognitionRef.current) {
      window.alert("Speech recognition is not supported in this browser.");
      return;
    }

    if (isListening) {
      try {
        recognitionRef.current.stop();
      } catch (error) {
        console.error("Error stopping recognition:", error);
        setIsListening(false);
      }
      return;
    }

    try {
      setIsMicInitializing(true);
      recognitionRef.current.start();
      window.setTimeout(() => {
        setIsMicInitializing((current) => current && false);
      }, 3000);
    } catch (error) {
      console.error("Error starting recognition:", error);
      setIsMicInitializing(false);
      window.alert(
        "Could not start speech recognition. It might already be running or blocked.",
      );
    }
  }, [isListening]);

  const handleSubmit = useCallback(async () => {
    const messageInput = isRichText
      ? richTextRef.current?.getMarkdown() || richTextContent
      : input;
    const prompt = messageInput.trim();
    if ((!prompt && !selectedImage) || isLoading) return;
    const attachedImage = selectedImage;

    setIsLoading(true);
    setStatusMessage("Generating app...");
    setLastPrompt(prompt || "Image analysis request");
    setSelectedImage(null);
    setInput("");
    setRichTextContent("");
    if (isRichText) {
      richTextRef.current?.clear();
    }

    const userMessageId = `${Date.now()}`;
    const assistantMessageId = `${Date.now() + 1}`;
    setMessages((prev) => [
      ...prev,
      {
        id: userMessageId,
        role: "user",
        content: messageInput,
        attachments: attachedImage
          ? [
              {
                url: attachedImage.url,
                mimeType: attachedImage.mimeType,
                data: attachedImage.data,
              },
            ]
          : undefined,
      },
      {
        id: assistantMessageId,
        role: "assistant",
        content: "Updating preview...",
      },
    ]);

    try {
      const requestMessages: ChatRequestMessage[] = messages
        .filter((message) => message.content.trim().length > 0)
        .map((message) => ({
          role: message.role,
          content: message.content,
          attachments:
            message.role === "user"
              ? message.attachments
                  ?.filter(
                    (
                      attachment,
                    ): attachment is {
                      url: string;
                      mimeType: string;
                      data: string;
                    } => Boolean(attachment.data),
                  )
                  .map((attachment) => ({
                    mimeType: attachment.mimeType,
                    data: attachment.data,
                  }))
              : undefined,
        }));
      const previewContextMessage = await buildPreviewContextRequestMessage({
        title: previewTitle || "Studio Preview",
        code: previewCode,
        language: previewLanguage,
        assets: previewAssets,
      });
      if (previewContextMessage) {
        requestMessages.push(previewContextMessage);
      }
      requestMessages.push({
        role: "user",
        content: messageInput,
        attachments: attachedImage
          ? [
              {
                mimeType: attachedImage.mimeType,
                data: attachedImage.data,
              },
            ]
          : undefined,
      });
      while (requestMessages.length > 0 && requestMessages[0]?.role !== "user") {
        requestMessages.shift();
      }

      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: selectedModel,
          messages: requestMessages,
          responseMode: "preview_edit_compact",
        }),
      });

      if (!response.ok) {
        throw new Error("Failed to get response");
      }
      if (!response.body) {
        throw new Error("No response body");
      }

      const modelUsed = response.headers.get("x-model-used");
      if (
        modelUsed &&
        models.some((model) => model.id === modelUsed) &&
        modelUsed !== selectedModel
      ) {
        setSelectedModel(modelUsed);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let assistantContent = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        assistantContent += decoder.decode(value, { stream: true });
      }

      assistantContent += decoder.decode();
      const parsedPreviewEditResponse = parsePreviewEditResponse(assistantContent);
      const visibleAssistantContent =
        parsedPreviewEditResponse?.chatContent || assistantContent;
      setMessages((prev) =>
        prev.map((message) =>
          message.id === assistantMessageId
            ? { ...message, content: visibleAssistantContent }
            : message,
        ),
      );

      const extractedCodeBlock =
        parsedPreviewEditResponse?.previewCodeBlock ||
        extractLatestPreviewableCodeBlock(assistantContent);

      if (!extractedCodeBlock) {
        setStatusMessage(
          "No runnable app code was returned, so the current preview was kept.",
        );
        return;
      }

      setPreviewComparisonCode(
        extractedCodeBlock.code !== previewCode ? previewCode : null,
      );
      setPreviewCode(extractedCodeBlock.code);
      setPreviewLanguage(
        normalizePreviewLanguage(extractedCodeBlock.language),
      );
      setPreviewTitle("Studio Preview");
      setStatusMessage("Preview updated from the latest generated app.");
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unable to generate an app.";
      setMessages((prev) =>
        prev.map((entry) =>
          entry.id === assistantMessageId
            ? { ...entry, content: `Error: ${message}` }
            : entry,
        ),
      );
      setStatusMessage(message);
    } finally {
      setIsLoading(false);
    }
  }, [
    input,
    isLoading,
    isRichText,
    messages,
    models,
    previewAssets,
    previewCode,
    previewLanguage,
    previewTitle,
    richTextContent,
    selectedImage,
    selectedModel,
  ]);

  const handleKeepPreviewCode = useCallback((nextCode: string) => {
    setPreviewComparisonCode(null);
    setPreviewCode(nextCode);
    setStatusMessage("Kept all staged code changes and updated the preview.");
  }, []);

  const handleUndoPreviewCode = useCallback((nextCode: string) => {
    setPreviewComparisonCode(null);
    setPreviewCode(nextCode);
    setStatusMessage("Reverted to the previous preview code.");
  }, []);

  const handleResolvePreviewDiff = useCallback(() => {
    setPreviewComparisonCode(null);
    setStatusMessage("Kept the latest generated code changes.");
  }, []);

  const closeResetStudioModal = useCallback(() => {
    if (isResettingStudio) return;
    setIsResetModalOpen(false);
  }, [isResettingStudio]);

  const resetStudioToBaseline = useCallback((baseline: StudioRouteBaseline) => {
    setIsResettingStudio(true);
    setIsModelDropdownOpen(false);
    setIsPromptAssistantOpen(false);
    setActiveSessionKey(null);
    removeStudioSession(activeSessionKey ?? sessionKey);
    resetTransientStudioState();
    applyPreviewBaseline(baseline);
    setStatusMessage(null);
    setIsResetModalOpen(false);
    resolvedBootstrapKeyRef.current = sessionKey;
    setActiveSessionKey(sessionKey);
    setActiveStudioSessionKey(sessionKey);
    setIsResettingStudio(false);
  }, [
    activeSessionKey,
    applyPreviewBaseline,
    resetTransientStudioState,
    sessionKey,
  ]);

  const handleResetStudio = useCallback(() => {
    resetStudioToBaseline(routeBaselineRef.current);
  }, [resetStudioToBaseline]);

  const handleResetToStarterApp = useCallback(() => {
    resetStudioToBaseline(starterBaseline);
  }, [resetStudioToBaseline, starterBaseline]);

  const selectedModelLabel =
    models.find((model) => model.id === selectedModel)?.name || "Select model";

  return (
    <div className="space-y-6">
      {isPreviewBootstrapping ? (
        <section className="rounded-xl border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
          <div className="flex min-h-[320px] flex-col items-center justify-center gap-3 text-center sm:min-h-[500px]">
            <Loader2 className="h-8 w-8 animate-spin text-blue-500" />
            <div>
              <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">
                Loading Studio preview
              </h2>
              <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
                Fetching the selected app and preparing its assets.
              </p>
            </div>
          </div>
        </section>
      ) : (
        <CodePreview
          code={previewCode}
          comparisonCode={previewComparisonCode}
          language={previewLanguage}
          title={previewTitle}
          assets={previewAssets}
          onCodeKeep={handleKeepPreviewCode}
          onCodeUndo={handleUndoPreviewCode}
          onCodeDiffResolved={handleResolvePreviewDiff}
          editSource={appId ? "apps" : undefined}
          existingAppId={appId}
          onSnapshot={handlePreviewSnapshot}
          onAssetsChange={setPreviewAssets}
          persistedUiState={codePreviewUiState}
          onPersistedUiStateChange={handleCodePreviewUiStateChange}
          studioModelId={selectedModel}
        />
      )}

      <section className="rounded-2xl border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
        <div className="flex items-center justify-between gap-3 border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
          <div>
            <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">
              Studio Conversation
            </h2>
            <p className="text-sm text-zinc-500 dark:text-zinc-400">
              Prompts and chatbot replies appear here while the main preview stays above.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setIsConversationOpen((open) => !open)}
            className="inline-flex items-center gap-2 rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-200 dark:hover:bg-zinc-700/50"
            aria-expanded={isConversationOpen}
            aria-controls="studio-conversation-panel"
          >
            <span>{isConversationOpen ? "Hide" : "Show"}</span>
            <ChevronDown
              className={`h-4 w-4 transition-transform ${
                isConversationOpen ? "rotate-180" : ""
              }`}
            />
          </button>
        </div>
        {isConversationOpen ? (
          <div
            id="studio-conversation-panel"
            className="max-h-[420px] space-y-4 overflow-y-auto p-4"
          >
            {messages.length === 0 ? (
              <div className="rounded-xl border border-dashed border-zinc-200 p-6 text-center text-sm text-zinc-500 dark:border-zinc-700 dark:text-zinc-400">
                Send a message in Studio to start a conversation.
              </div>
            ) : (
              messages.map((message) => (
                <div
                  key={message.id}
                  className={`flex gap-3 ${
                    message.role === "user" ? "flex-row-reverse" : "flex-row"
                  }`}
                >
                  <div
                    className={`mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${
                      message.role === "user"
                        ? "bg-zinc-200 dark:bg-zinc-700"
                        : "bg-blue-100 dark:bg-blue-900/30"
                    }`}
                  >
                    {message.role === "user" ? (
                      <User className="h-4 w-4" />
                    ) : (
                      <Bot className="h-4 w-4 text-blue-600 dark:text-blue-400" />
                    )}
                  </div>
                  <div
                    className={`min-w-0 rounded-2xl p-3 sm:p-4 ${
                      message.role === "user"
                        ? "max-w-[92%] rounded-tr-none bg-blue-600 text-white sm:max-w-[85%]"
                        : "w-full rounded-tl-none bg-zinc-100 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100"
                    }`}
                  >
                    {message.role === "user" && message.attachments?.length ? (
                      <div className="mb-2 flex flex-wrap gap-2">
                        {message.attachments.map((attachment, index) => (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            key={`${message.id}-${index}`}
                            src={attachment.url}
                            alt="Uploaded Studio context"
                            className="h-auto w-full max-w-full rounded-lg border border-white/20 sm:w-auto sm:max-w-48"
                            loading="lazy"
                          />
                        ))}
                      </div>
                    ) : null}
                    <div className="prose prose-sm max-w-none break-words dark:prose-invert">
                      <ReactMarkdown
                        remarkPlugins={[remarkGfm, remarkMath]}
                        rehypePlugins={[rehypeKatex]}
                        components={{
                          code({
                            inline,
                            className,
                            children,
                            ...props
                          }: {
                            inline?: boolean;
                            className?: string;
                            children?: React.ReactNode;
                          }) {
                            const match = /language-(\w+)/.exec(className || "");
                            const language = match ? match[1] : "";
                            const code = String(children).replace(/\n$/, "");

                            if (!inline && language) {
                              return (
                                <div className="my-4 overflow-x-auto rounded-lg">
                                  <SyntaxHighlighter
                                    style={vscDarkPlus}
                                    language={language}
                                    PreTag="div"
                                    showLineNumbers={true}
                                    wrapLines={true}
                                    className="gemini-code-block"
                                    lineNumberStyle={{
                                      color: "#6e7681",
                                      minWidth: "2em",
                                      paddingRight: "1em",
                                      userSelect: "none",
                                    }}
                                    {...props}
                                  >
                                    {code}
                                  </SyntaxHighlighter>
                                </div>
                              );
                            }

                            return (
                              <code
                                className={`rounded px-1 ${
                                  message.role === "user"
                                    ? "bg-white/15"
                                    : "bg-zinc-200 dark:bg-zinc-700"
                                }`}
                                {...props}
                              >
                                {children}
                              </code>
                            );
                          },
                          ul: ({ children }) => (
                            <ul className="ml-4 list-disc space-y-1">{children}</ul>
                          ),
                          ol: ({ children }) => (
                            <ol className="ml-4 list-decimal space-y-1">{children}</ol>
                          ),
                          p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
                        }}
                      >
                        {message.content || (message.role === "assistant" ? "..." : "")}
                      </ReactMarkdown>
                    </div>
                  </div>
                </div>
              ))
            )}
            {isLoading ? (
              <div className="flex gap-3">
                <div className="mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-blue-100 dark:bg-blue-900/30">
                  <Bot className="h-4 w-4 text-blue-600 dark:text-blue-400" />
                </div>
                <div className="rounded-2xl rounded-tl-none bg-zinc-100 p-4 dark:bg-zinc-800">
                  <div className="flex gap-1.5">
                    <div className="h-2 w-2 animate-pulse rounded-full bg-blue-500" />
                    <div className="h-2 w-2 animate-pulse rounded-full bg-blue-500 [animation-delay:150ms]" />
                    <div className="h-2 w-2 animate-pulse rounded-full bg-blue-500 [animation-delay:300ms]" />
                  </div>
                </div>
              </div>
            ) : null}
            <div ref={messagesEndRef} />
          </div>
        ) : null}
      </section>

      <section className="rounded-2xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
        <div className="flex flex-col gap-4">
          <div className="flex items-start gap-3">
            <div className="rounded-xl bg-blue-500 p-2 text-white">
              <Sparkles className="h-5 w-5" />
            </div>
            <div>
              <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">
                Studio Composer
              </h2>
              <p className="text-sm text-zinc-500 dark:text-zinc-400">
                Describe the app you want, then update the preview with the
                latest generated code.
              </p>
            </div>
          </div>

          {selectedImage ? (
            <div className="relative inline-block">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={selectedImage.url}
                alt="Selected image for Studio analysis"
                className="h-20 w-auto rounded-lg border border-zinc-200 shadow-sm dark:border-zinc-700"
              />
              <button
                type="button"
                onClick={() => setSelectedImage(null)}
                className="absolute -right-2 -top-2 rounded-full bg-red-500 p-1 text-white shadow-md transition-colors hover:bg-red-600"
                title="Remove selected image"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ) : null}

          <div className="relative flex flex-col gap-3">
            <input
              type="file"
              ref={fileInputRef}
              onChange={handleImageSelect}
              accept="image/*"
              className="hidden"
            />
            <input
              type="file"
              ref={codeFileInputRef}
              onChange={handleCodeUpload}
              accept=".tsx,.jsx,.js,.ts,.html"
              className="hidden"
            />

            <div className="flex flex-wrap items-center gap-1.5 sm:gap-2">
              <button
                type="button"
                onClick={toggleListening}
                className={`flex h-11 w-11 items-center justify-center rounded-xl transition-all sm:h-10 sm:w-10 ${
                  isListening
                    ? "bg-red-50 text-red-500 dark:bg-red-900/20"
                    : isMicInitializing
                      ? "bg-amber-50 text-amber-500 dark:bg-amber-900/20"
                      : "text-zinc-500 hover:bg-blue-50 hover:text-blue-600 dark:hover:bg-blue-900/20"
                }`}
                title={
                  isListening
                    ? "Stop Listening"
                    : isMicInitializing
                      ? "Initializing Mic..."
                      : "Start Voice Input"
                }
              >
                {isMicInitializing ? (
                  <Loader2 className="h-5 w-5 animate-spin" />
                ) : isListening ? (
                  <Mic className="h-5 w-5 animate-pulse" />
                ) : (
                  <Mic className="h-5 w-5" />
                )}
              </button>
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="flex h-11 w-11 items-center justify-center rounded-xl text-zinc-500 transition-all hover:bg-blue-50 hover:text-blue-600 dark:hover:bg-blue-900/20 sm:h-10 sm:w-10"
                title="Upload Image"
              >
                <Paperclip className="h-5 w-5" />
              </button>
              <button
                type="button"
                onClick={() => codeFileInputRef.current?.click()}
                className="flex h-11 w-11 items-center justify-center rounded-xl text-zinc-500 transition-all hover:bg-blue-50 hover:text-blue-600 dark:hover:bg-blue-900/20 sm:h-10 sm:w-10"
                title="Upload Code for Preview"
              >
                <Upload className="h-5 w-5" />
              </button>
              <button
                type="button"
                onClick={() => {
                  setIsRichText((prev) => {
                    if (prev) {
                      const markdown = richTextRef.current?.getMarkdown() || "";
                      setInput(markdown);
                    }
                    return !prev;
                  });
                }}
                className={`flex h-11 w-11 items-center justify-center rounded-xl transition-all sm:h-10 sm:w-10 ${
                  isRichText
                    ? "bg-blue-50 text-blue-600 dark:bg-blue-900/20"
                    : "text-zinc-500 hover:bg-blue-50 hover:text-blue-600 dark:hover:bg-blue-900/20"
                }`}
                title={
                  isRichText
                    ? "Switch to plain text"
                    : "Switch to rich text editor"
                }
              >
                <Type className="h-5 w-5" />
              </button>
              <button
                type="button"
                onClick={() => setIsPromptAssistantOpen(true)}
                className="flex h-11 w-11 items-center justify-center rounded-xl text-zinc-500 transition-all hover:bg-purple-50 hover:text-purple-600 dark:hover:bg-purple-900/20 sm:h-10 sm:w-10"
                title="Prompt Assistant"
              >
                <Wand2 className="h-5 w-5" />
              </button>
              <div className="relative min-w-[220px] flex-1 sm:min-w-[280px]" ref={modelDropdownRef}>
                <button
                  type="button"
                  onClick={() => setIsModelDropdownOpen((open) => !open)}
                  className="flex w-full items-center justify-between gap-2 rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-200 dark:hover:bg-zinc-700/50"
                >
                  <span className="truncate">{selectedModelLabel}</span>
                  <ChevronDown
                    className={`h-4 w-4 transition-transform ${
                      isModelDropdownOpen ? "rotate-180" : ""
                    }`}
                  />
                </button>

                {isModelDropdownOpen ? (
                  <div className="absolute left-0 right-0 top-full z-20 mt-2 max-h-[70vh] overflow-y-auto rounded-xl border border-zinc-200 bg-white shadow-xl dark:border-zinc-700 dark:bg-zinc-800">
                    {(
                      Object.entries(groupedModels) as Array<
                        [StudioModel["provider"], StudioModel[]]
                      >
                    ).map(([provider, providerModels], groupIndex) => (
                      <div key={provider}>
                        {groupIndex > 0 ? (
                          <div className="border-t border-zinc-200 dark:border-zinc-700" />
                        ) : null}
                        <div className="bg-zinc-50/70 px-4 py-2 text-xs font-semibold uppercase tracking-wider text-zinc-400 dark:bg-zinc-900/50 dark:text-zinc-500">
                          {providerLabels[provider]}
                        </div>
                        {providerModels.map((model) => (
                          <button
                            key={model.id}
                            type="button"
                            onClick={() => {
                              setSelectedModel(model.id);
                              setIsModelDropdownOpen(false);
                            }}
                            className={`flex w-full flex-col gap-0.5 px-4 py-3 text-left transition-colors hover:bg-zinc-50 dark:hover:bg-zinc-700/50 ${
                              selectedModel === model.id
                                ? "bg-blue-50 dark:bg-blue-900/20"
                                : ""
                            }`}
                          >
                            <span
                              className={`text-sm font-medium ${
                                selectedModel === model.id
                                  ? "text-blue-600 dark:text-blue-400"
                                  : "text-zinc-900 dark:text-zinc-100"
                              }`}
                            >
                              {model.name}
                            </span>
                            <span className="text-xs text-zinc-500 dark:text-zinc-400">
                              {model.description}
                            </span>
                          </button>
                        ))}
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            </div>

            <div className="flex min-w-0 items-end gap-2">
              {isRichText ? (
                <RichTextEditor
                  ref={richTextRef}
                  placeholder="Type a message with rich formatting..."
                  onSubmit={() => {
                    void handleSubmit();
                  }}
                  onChange={(markdown) => setRichTextContent(markdown)}
                  initialContent={richTextContent || input}
                />
              ) : (
                <input
                  value={input}
                  onChange={(event) => setInput(event.target.value)}
                  placeholder="Type a message, ask for code, or analyze an uploaded image..."
                  className="min-w-0 flex-1 rounded-xl border border-zinc-200 bg-white px-4 py-3 text-sm outline-none transition-all focus:border-transparent focus:ring-2 focus:ring-blue-500 dark:border-zinc-700 dark:bg-zinc-800"
                  onKeyDown={(event) => {
                    if (
                      event.key === "Enter" &&
                      !isLoading &&
                      (input.trim() || selectedImage)
                    ) {
                      event.preventDefault();
                      void handleSubmit();
                    }
                  }}
                />
              )}
              <button
                type="button"
                onClick={() => void handleSubmit()}
                disabled={
                  (!(isRichText ? richTextContent.trim() : input.trim()) &&
                    !selectedImage) ||
                  isLoading
                }
                className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-blue-600 text-white shadow-lg shadow-blue-500/20 transition-all hover:bg-blue-700 disabled:opacity-50 disabled:hover:bg-blue-600 sm:h-12 sm:w-12"
                title="Send to Studio"
              >
                {isLoading ? (
                  <Loader2 className="h-5 w-5 animate-spin" />
                ) : (
                  <Send className="h-5 w-5" />
                )}
              </button>
            </div>
          </div>

          {statusMessage ? (
            <div className="rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm text-zinc-600 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-300">
              <p>{statusMessage}</p>
              {lastPrompt ? (
                <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                  Last prompt: {lastPrompt}
                </p>
              ) : null}
            </div>
          ) : null}

          <div className="flex justify-end">
            <button
              type="button"
              onClick={() => setIsResetModalOpen(true)}
              disabled={isLoading || isPreviewBootstrapping || isResettingStudio}
              className="inline-flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm font-medium text-red-700 transition-colors hover:bg-red-100 disabled:opacity-50 dark:border-red-900/40 dark:bg-red-950/20 dark:text-red-200 dark:hover:bg-red-950/40"
            >
              <RotateCcw className="h-4 w-4" />
              <span>Reset Studio</span>
            </button>
          </div>
        </div>
      </section>

      <PromptAssistant
        isOpen={isPromptAssistantOpen}
        onClose={() => setIsPromptAssistantOpen(false)}
        onKeep={handleKeepDraft}
        selectedModel={selectedModel}
      />

      {isResetModalOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-md rounded-xl border border-zinc-200 bg-white p-4 shadow-2xl dark:border-zinc-700 dark:bg-zinc-900">
            <div className="mb-4 flex items-start justify-between gap-4">
              <div>
                <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                  Reset Studio?
                </h3>
                <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                  This will restore the current Studio page to its original preview and clear the conversation, prompt draft, preview edits, and assets. Choose Starter App to load the built-in Studio starter instead.
                </p>
              </div>
              <button
                type="button"
                onClick={closeResetStudioModal}
                disabled={isResettingStudio}
                className="text-xs text-zinc-500 hover:text-zinc-900 disabled:opacity-50 dark:hover:text-zinc-100"
              >
                Close
              </button>
            </div>

            <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 dark:border-red-900/60 dark:bg-red-950/40">
              <p className="text-xs text-red-700 dark:text-red-200">
                This action cannot be undone.
              </p>
            </div>

            <div className="mt-4 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={closeResetStudioModal}
                disabled={isResettingStudio}
                className="rounded-md border border-zinc-300 px-3 py-1.5 text-xs text-zinc-700 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleResetToStarterApp}
                disabled={isResettingStudio}
                className="rounded-md border border-zinc-300 px-3 py-1.5 text-xs text-zinc-700 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300"
              >
                Starter App
              </button>
              <button
                type="button"
                onClick={handleResetStudio}
                disabled={isResettingStudio}
                className="rounded-md bg-red-600 px-3 py-1.5 text-xs text-white disabled:opacity-50"
              >
                {isResettingStudio ? "Resetting..." : "Reset Studio"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
