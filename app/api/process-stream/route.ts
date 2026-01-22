import { NextRequest } from "next/server";
import { GoogleGenerativeAI } from "@google/generative-ai";

export async function POST(request: NextRequest) {
  try {
    const { transcript } = await request.json();

    if (!transcript || !transcript.trim()) {
      return new Response(JSON.stringify({ error: "No transcript provided" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
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

    const prompt = `You are analyzing a user's question about money transfers. The user may ask their question in a vague or indirect way, so you need to reason about what they're likely asking.

Here are the possible questions:
1. How do I check my transfer's status?
2. When will my money arrive?
3. Why does it say my transfer's complete when the money hasn't arrived yet?
4. Why is my transfer taking longer than the estimate?
5. What is a proof of payment?
6. What's a banking partner reference number?

User's question: "${transcript}"

Analyze the user's question and determine which of the above questions (1, 2, ..., 6) they are most likely asking.

If the question doesn't match any of the above, return -1.

Respond ONLY with valid JSON in this exact format:
{"questionNumber": <number>}

Do not include any other text, explanation, or formatting. Just the JSON.`;

    // Create a streaming response
    const encoder = new TextEncoder();

    const stream = new ReadableStream({
      async start(controller) {
        try {
          // Send initial processing status
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                type: "processing",
                message: "Analyzing your question...",
              })}\n\n`
            )
          );

          const result = await model.generateContent(prompt);
          const responseText = result.response.text();

          // Parse the JSON response from Gemini
          let questionNumber = -1;
          try {
            const jsonMatch = responseText.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
              const parsed = JSON.parse(jsonMatch[0]);
              questionNumber = parsed.questionNumber || -1;
            }
          } catch (parseError) {
            console.error("Error parsing Gemini response:", parseError);
          }

          // Determine the audio file path based on question number
          let audioUrl = null;
          if (questionNumber >= 1 && questionNumber <= 6) {
            audioUrl = `/${questionNumber}question.mp3`;
          }

          // Send the result
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                type: "result",
                questionNumber,
                audioUrl,
                transcript,
              })}\n\n`
            )
          );

          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({ type: "done" })}\n\n`)
          );
          controller.close();
        } catch (error) {
          console.error("Stream error:", error);
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                type: "error",
                message:
                  error instanceof Error ? error.message : "Unknown error",
              })}\n\n`
            )
          );
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  } catch (error) {
    console.error("Process stream error:", error);
    return new Response(JSON.stringify({ error: "Internal server error" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
