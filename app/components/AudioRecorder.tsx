'use client';

import { useState, useRef } from 'react';

export default function AudioRecorder() {
  const [isRecording, setIsRecording] = useState(false);
  const [transcript, setTranscript] = useState<string>('');
  const [questionNumber, setQuestionNumber] = useState<number | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string>('');
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mediaRecorder = new MediaRecorder(stream, {
        mimeType: 'audio/webm',
      });

      mediaRecorderRef.current = mediaRecorder;
      audioChunksRef.current = [];

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      mediaRecorder.onstop = async () => {
        const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
        await transcribeAudio(audioBlob);
        
        // Stop all tracks to release the microphone
        stream.getTracks().forEach(track => track.stop());
      };

      mediaRecorder.start();
      setIsRecording(true);
      setError('');
    } catch (err) {
      setError('Failed to access microphone. Please check permissions.');
      console.error('Error accessing microphone:', err);
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
    }
  };

  const transcribeAudio = async (audioBlob: Blob) => {
    // Stop any currently playing audio
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
    }

    setIsLoading(true);
    setError('');
    setTranscript('');
    setQuestionNumber(null);
    setAudioUrl(null);

    try {
      // Convert webm to wav format for Deepgram
      const formData = new FormData();
      
      // Create a File object from the blob
      const audioFile = new File([audioBlob], 'recording.webm', { type: 'audio/webm' });
      formData.append('audio', audioFile);

      const response = await fetch('/api/transcribe', {
        method: 'POST',
        body: formData,
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to transcribe audio');
      }

      const data = await response.json();
      setTranscript(data.transcript || 'No transcript available');
      setQuestionNumber(data.questionNumber !== undefined ? data.questionNumber : null);
      
      // Set audio URL to display and auto-play
      if (data.audioUrl) {
        setAudioUrl(data.audioUrl);
        // Auto-play will be handled by the audio element's onLoadedData event
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to transcribe audio');
      console.error('Transcription error:', err);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="flex flex-col items-center gap-6 p-8 max-w-2xl mx-auto">
      <h1 className="text-3xl font-bold">Audio Transcription</h1>
      
      <div className="flex gap-4">
        {!isRecording ? (
          <button
            onClick={startRecording}
            disabled={isLoading}
            className="px-6 py-3 bg-red-500 text-white rounded-lg hover:bg-red-600 disabled:bg-gray-400 disabled:cursor-not-allowed font-semibold"
          >
            Start Recording
          </button>
        ) : (
          <button
            onClick={stopRecording}
            className="px-6 py-3 bg-red-600 text-white rounded-lg hover:bg-red-700 font-semibold animate-pulse"
          >
            Stop Recording
          </button>
        )}
      </div>

      {isLoading && (
        <div className="text-gray-600">Transcribing audio...</div>
      )}

      {error && (
        <div className="text-red-600 bg-red-50 p-4 rounded-lg w-full">
          Error: {error}
        </div>
      )}

      {transcript && (
        <div className="w-full space-y-4">
          <div>
            <h2 className="text-xl font-semibold mb-2">Transcript:</h2>
            <div className="bg-gray-50 p-4 rounded-lg border border-gray-200 min-h-[100px]">
              <p className="text-gray-800 whitespace-pre-wrap">{transcript}</p>
            </div>
          </div>

          {questionNumber !== null && (
            <div>
              <h2 className="text-xl font-semibold mb-2">Identified Question:</h2>
              <div className={`p-4 rounded-lg border-2 ${
                questionNumber === -1 
                  ? 'bg-yellow-50 border-yellow-300' 
                  : 'bg-green-50 border-green-300'
              }`}>
                {questionNumber === -1 ? (
                  <div>
                    <p className="text-yellow-800 font-semibold mb-2">
                      No matching question found
                    </p>
                    <p className="text-yellow-700 text-sm">
                      The question doesn't match any of the predefined questions.
                    </p>
                  </div>
                ) : (
                  <div>
                    <p className="text-green-800 font-semibold mb-2">
                      Question #{questionNumber}
                    </p>
                    <p className="text-green-700">
                      {questionNumber === 1 && "How do I check my transfer's status?"}
                      {questionNumber === 2 && "When will my money arrive?"}
                      {questionNumber === 3 && "Why does it say my transfer's complete when the money hasn't arrived yet?"}
                      {questionNumber === 4 && "Why is my transfer taking longer than the estimate?"}
                      {questionNumber === 5 && "What is a proof of payment?"}
                      {questionNumber === 6 && "What's a banking partner reference number?"}
                    </p>
                  </div>
                )}
              </div>
            </div>
          )}

          {audioUrl && (
            <div>
              <h2 className="text-xl font-semibold mb-2">Audio Response:</h2>
              <div className="bg-blue-50 p-4 rounded-lg border-2 border-blue-300">
                <audio
                  ref={audioRef}
                  src={audioUrl}
                  controls
                  autoPlay
                  className="w-full"
                  onLoadedData={() => {
                    // Ensure auto-play happens when audio is loaded
                    if (audioRef.current) {
                      audioRef.current.play().catch(err => {
                        console.error('Error playing audio:', err);
                        setError('Failed to play audio response. Please click play manually.');
                      });
                    }
                  }}
                  onError={(e) => {
                    console.error('Audio playback error:', e);
                    setError('Failed to load audio response');
                  }}
                >
                  Your browser does not support the audio element.
                </audio>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

