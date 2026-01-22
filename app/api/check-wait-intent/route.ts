import { NextRequest } from "next/server";
import { GoogleGenerativeAI } from "@google/generative-ai";

export async function POST(request: NextRequest) {
  try {
    const { transcript } = await request.json();

    if (!transcript || !transcript.trim()) {
      return new Response(
        JSON.stringify({ shouldWait: false, isWaitIntent: false }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    const geminiApiKey = process.env.GOOGLE_GENAI_API_KEY;

    if (!geminiApiKey) {
      return new Response(
        JSON.stringify({ error: "Google GenAI API key not configured" }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }

    const genAI = new GoogleGenerativeAI(geminiApiKey);
    const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

    const prompt = `You are analyzing a user's speech to determine if they are asking for more time to think or formulate their question.

The user said: "${transcript}"

Determine if the user is expressing any of these intents:
- Asking to wait or hold on (e.g., "hold on", "wait a moment", "give me a second", "let me think", "one moment", "hang on", "just a sec", "um let me think")
- Indicating they need more time to respond
- Expressing hesitation or pause requests

Respond ONLY with valid JSON in this exact format:
{"isWaitIntent": <boolean>}

Where isWaitIntent is:
- true: if the user is asking for more time/to wait
- false: if the user is asking a question or saying something else

Do not include any other text, explanation, or formatting. Just the JSON.`;

    const result = await model.generateContent(prompt);
    const responseText = result.response.text();

    let isWaitIntent = false;
    try {
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        isWaitIntent = parsed.isWaitIntent === true;
      }
    } catch (parseError) {
      console.error("Error parsing Gemini response:", parseError);
    }

    return new Response(JSON.stringify({ isWaitIntent }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Check wait intent error:", error);
    return new Response(JSON.stringify({ error: "Internal server error" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
