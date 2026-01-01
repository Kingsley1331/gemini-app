import { GoogleGenerativeAI } from "@google/generative-ai";

export async function POST(req: Request) {
  try {
    const apiKey = process.env.GEMINI_API_KEY;

    if (!apiKey) {
      return new Response(
        JSON.stringify({
          error: "Configuration Error",
          details: "GEMINI_API_KEY is not defined.",
        }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }

    const { text } = await req.json();

    if (!text) {
      return new Response(JSON.stringify({ error: "Text is required" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const genAI = new GoogleGenerativeAI(apiKey);

    // Using the specific model and config suggested by the user
    const model = genAI.getGenerativeModel({
      model: "gemini-2.5-pro-preview-tts",
    });

    const result = await model.generateContent({
      contents: [{ role: "user", parts: [{ text }] }],
      generationConfig: {
        // responseModalities is supported in newer Gemini models
        // @ts-expect-error - Newer Gemini feature
        responseModalities: ["audio"],
        // speechConfig is a newer feature
        // @ts-expect-error - Newer Gemini feature
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: {
              voiceName: "Zephyr",
            },
          },
        },
      },
    });

    const response = await result.response;
    const part = response.candidates?.[0]?.content?.parts?.find(
      (p) => p.inlineData && p.inlineData.mimeType.startsWith("audio/")
    );

    if (part?.inlineData) {
      const { data, mimeType } = part.inlineData;
      return new Response(
        JSON.stringify({
          audio: data,
          mimeType: mimeType,
        }),
        {
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    throw new Error("No audio content generated");
  } catch (error: unknown) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    console.error("Speech Generation Error:", errorMessage);

    if (errorMessage.includes("modality") || errorMessage.includes("400")) {
      return new Response(
        JSON.stringify({
          error: "GEMINI_MODALITY_UNSUPPORTED",
          details:
            "Gemini native audio is not yet available for this API key or region.",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify({
        error: "Speech Generation Error",
        details: errorMessage,
      }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}
