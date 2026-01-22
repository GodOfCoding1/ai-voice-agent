import { NextResponse } from "next/server";

export async function GET() {
  const apiKey = process.env.DEEPGRAM_API_KEY;

  if (!apiKey) {
    return NextResponse.json(
      { error: "Deepgram API key not configured" },
      { status: 500 }
    );
  }

  // Return the API key for client-side WebSocket connection
  // In production, you'd want to generate a temporary token instead
  return NextResponse.json({ apiKey });
}
