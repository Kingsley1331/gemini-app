import { GoogleGenerativeAI } from "@google/generative-ai";
import { NextResponse } from "next/server";
import mime from "mime";

interface WavConversionOptions {
  numChannels: number;
  sampleRate: number;
  bitsPerSample: number;
}

function parseMimeType(mimeType: string) {
  const [fileType, ...params] = mimeType.split(";").map((s) => s.trim());
  const [_, format] = fileType.split("/");

  const options: Partial<WavConversionOptions> = {
    numChannels: 1,
  };

  if (format && format.startsWith("L")) {
    const bits = parseInt(format.slice(1), 10);
    if (!isNaN(bits)) {
      options.bitsPerSample = bits;
    }
  }

  for (const param of params) {
    const [key, value] = param.split("=").map((s) => s.trim());
    if (key === "rate") {
      options.sampleRate = parseInt(value, 10);
    }
  }

  return options as WavConversionOptions;
}

function createWavHeader(dataLength: number, options: WavConversionOptions) {
  const { numChannels, sampleRate, bitsPerSample } = options;

  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const buffer = Buffer.alloc(44);

  buffer.write("RIFF", 0); // ChunkID
  buffer.writeUInt32LE(36 + dataLength, 4); // ChunkSize
  buffer.write("WAVE", 8); // Format
  buffer.write("fmt ", 12); // Subchunk1ID
  buffer.writeUInt32LE(16, 16); // Subchunk1Size (PCM)
  buffer.writeUInt16LE(1, 20); // AudioFormat (1 = PCM)
  buffer.writeUInt16LE(numChannels, 22); // NumChannels
  buffer.writeUInt32LE(sampleRate, 24); // SampleRate
  buffer.writeUInt32LE(byteRate, 28); // ByteRate
  buffer.writeUInt16LE(blockAlign, 32); // BlockAlign
  buffer.writeUInt16LE(bitsPerSample, 34); // BitsPerSample
  buffer.write("data", 36); // Subchunk2ID
  buffer.writeUInt32LE(dataLength, 40); // Subchunk2Size

  return buffer;
}

function convertToWav(rawData: string, mimeType: string) {
  const options = parseMimeType(mimeType);
  const buffer = Buffer.from(rawData, "base64");
  const wavHeader = createWavHeader(buffer.length, options);

  return Buffer.concat([wavHeader, buffer]);
}

export async function POST(req: Request) {
  try {
    const apiKey = process.env.GEMINI_API_KEY;

    if (!apiKey) {
      return NextResponse.json(
        {
          error: "Configuration Error",
          details: "GEMINI_API_KEY is not defined.",
        },
        { status: 500 }
      );
    }

    const { text } = await req.json();

    if (!text) {
      return NextResponse.json({ error: "Text is required" }, { status: 400 });
    }

    const genAI = new GoogleGenerativeAI(apiKey);

    // Using the specific model and config suggested by the user
    const model = genAI.getGenerativeModel({
      model: "gemini-2.5-pro-preview-tts",
    });

    const result = await model.generateContent({
      contents: [{ role: "user", parts: [{ text }] }],
      generationConfig: {
        // @ts-expect-error - responseModalities is supported in newer Gemini models
        responseModalities: ["audio"],
        // @ts-expect-error - speechConfig is a newer feature
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

    if (response.promptFeedback?.blockReason) {
      throw new Error(
        `Content blocked: ${response.promptFeedback.blockReason}`
      );
    }

    const audioPart = response.candidates?.[0]?.content?.parts?.find(
      (p) => p.inlineData && p.inlineData.mimeType.startsWith("audio/")
    );

    if (audioPart?.inlineData) {
      const { data, mimeType: audioMimeType } = audioPart.inlineData;
      let finalBuffer: Buffer;
      let finalMimeType = audioMimeType;

      // Check if it's raw PCM (often indicated by absence of standard extension or specific mime)
      const extension = mime.getExtension(audioMimeType);
      if (!extension || audioMimeType.includes("audio/L")) {
        console.log("Converting raw PCM to WAV...");
        finalBuffer = convertToWav(data, audioMimeType);
        finalMimeType = "audio/wav";
      } else {
        finalBuffer = Buffer.from(data, "base64");
      }

      return NextResponse.json({
        audioContent: finalBuffer.toString("base64"),
        mimeType: finalMimeType,
      });
    }

    throw new Error("No audio content generated");
  } catch (error: unknown) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    console.error("Speech Generation Error:", errorMessage);

    if (errorMessage.includes("modality") || errorMessage.includes("400")) {
      return NextResponse.json(
        {
          error: "GEMINI_MODALITY_UNSUPPORTED",
          details:
            "Gemini native audio is not yet available for this API key or region.",
        },
        { status: 200 }
      );
    }

    return NextResponse.json(
      { error: "Speech Generation Error", details: errorMessage },
      { status: 500 }
    );
  }
}
