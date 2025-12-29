import { GoogleGenerativeAI } from "@google/generative-ai";
import { NextResponse } from "next/server";

export async function POST(req: Request) {
  try {
    const apiKey = process.env.GEMINI_API_KEY;

    if (!apiKey) {
      return NextResponse.json(
        {
          error: "Configuration Error",
          details:
            "GEMINI_API_KEY is not defined in environment variables. Check your .env.local file and restart your server.",
        },
        { status: 500 }
      );
    }

    const { prompt, pro = true } = await req.json();

    if (!prompt) {
      return NextResponse.json(
        { error: "Prompt is required" },
        { status: 400 }
      );
    }

    const currentGenAI = new GoogleGenerativeAI(apiKey);

    // Official Nano Banana models
    // Defaulting to the standard model (gemini-2.5-flash-image) as it has higher free-tier availability
    const modelName = pro
      ? "gemini-3-pro-image-preview"
      : "gemini-2.5-flash-image";

    const model = currentGenAI.getGenerativeModel({
      model: modelName,
    });

    const result = await model.generateContent({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        // @ts-expect-error - Official multimodal generation modality
        responseModalities: ["IMAGE"],
      },
    });

    const response = await result.response;
    const part = response.candidates?.[0]?.content?.parts?.[0];

    if (part?.inlineData) {
      const imageUrl = `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`;
      return NextResponse.json({ imageUrl });
    }

    return NextResponse.json(
      { error: "No image data returned from Nano Banana" },
      { status: 500 }
    );
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json(
      { error: "Nano Banana Generation Failed", details: message },
      { status: 500 }
    );
  }
}
