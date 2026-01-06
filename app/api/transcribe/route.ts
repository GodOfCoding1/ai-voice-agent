import { NextRequest, NextResponse } from 'next/server';
import { GoogleGenerativeAI } from '@google/generative-ai';

export async function POST(request: NextRequest) {
  try {
    const apiKey = process.env.DEEPGRAM_API_KEY;
    
    if (!apiKey) {
      return NextResponse.json(
        { error: 'Deepgram API key not configured' },
        { status: 500 }
      );
    }

    // Get the audio file from the request
    const formData = await request.formData();
    const audioFile = formData.get('audio') as File;

    if (!audioFile) {
      return NextResponse.json(
        { error: 'No audio file provided' },
        { status: 400 }
      );
    }

    // Convert File to ArrayBuffer
    const arrayBuffer = await audioFile.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // Use the file's mime type, or default to webm
    const contentType = audioFile.type || 'audio/webm';

    // Call Deepgram API
    const response = await fetch(
      'https://api.deepgram.com/v1/listen?model=nova-3&smart_format=true',
      {
        method: 'POST',
        headers: {
          'Authorization': `Token ${apiKey}`,
          'Content-Type': contentType,
        },
        body: buffer,
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Deepgram API error:', errorText);
      return NextResponse.json(
        { error: 'Failed to transcribe audio', details: errorText },
        { status: response.status }
      );
    }

    const data = await response.json();
    
    // Extract the transcript text from Deepgram response
    const transcript = data.results?.channels?.[0]?.alternatives?.[0]?.transcript || '';

    // If transcript is empty, return early
    if (!transcript.trim()) {
      return NextResponse.json({ 
        transcript: '',
        questionNumber: -1 
      });
    }

    // Call Gemini to identify the question
    const geminiApiKey = process.env.GOOGLE_GENAI_API_KEY;
    
    if (!geminiApiKey) {
      return NextResponse.json(
        { error: 'Google GenAI API key not configured' },
        { status: 500 }
      );
    }

    const genAI = new GoogleGenerativeAI(geminiApiKey);
    const model = genAI.getGenerativeModel({ model: 'gemini-3-flash-preview' });

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

    const result = await model.generateContent(prompt);
    const geminiResponse = result.response;
    const responseText = geminiResponse.text();

    // Parse the JSON response from Gemini
    let questionNumber = -1;
    try {
      // Extract JSON from the response (in case there's extra text)
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        questionNumber = parsed.questionNumber || -1;
      }
    } catch (parseError) {
      console.error('Error parsing Gemini response:', parseError);
      console.error('Gemini response text:', responseText);
    }

    // Determine the audio file path based on question number
    let audioUrl = null;
    if (questionNumber >= 1 && questionNumber <= 6) {
      audioUrl = `/${questionNumber}question.mp3`;
    }

    return NextResponse.json({ 
      transcript,
      questionNumber,
      audioUrl 
    });
  } catch (error) {
    console.error('Transcription error:', error);
    return NextResponse.json(
      { error: 'Internal server error', details: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}

