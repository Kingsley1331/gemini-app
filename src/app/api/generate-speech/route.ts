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

    // Reverting to the specialized TTS model which supports native audio output
    const model = genAI.getGenerativeModel({
      model: "gemini-2.5-pro-preview-tts",
    });

    const result = await model.generateContentStream({
      contents: [{ role: "user", parts: [{ text }] }],
      generationConfig: {
        // @ts-expect-error - Newer Gemini feature
        responseModalities: ["audio"],
        // speechConfig is a newer feature
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: {
              voiceName: "Zephyr",
            },
          },
        },
      },
    });

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        try {
          for await (const chunk of result.stream) {
            const part = chunk.candidates?.[0]?.content?.parts?.find(
              (p) => p.inlineData && p.inlineData.mimeType.startsWith("audio/")
            );

            if (part?.inlineData) {
              const { data, mimeType } = part.inlineData;
              controller.enqueue(
                encoder.encode(JSON.stringify({ audio: data, mimeType }) + "\n")
              );
            }
          }
          controller.close();
        } catch (error) {
          console.error("Streaming error:", error);
          controller.error(error);
        }
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "application/x-ndjson",
        "Cache-Control": "no-cache",
      },
    });
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
