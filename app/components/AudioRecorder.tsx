'use client';

import { useState, useRef, useEffect } from 'react';

const MAX_RECORDING_TIME_SECONDS = 60; // 60 seconds limit

export default function AudioRecorder() {
  const [isRecording, setIsRecording] = useState(false);
  const [transcript, setTranscript] = useState<string>('');
  const [questionNumber, setQuestionNumber] = useState<number | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string>('');
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [audioLevel, setAudioLevel] = useState<number>(0);
  const [recordingTime, setRecordingTime] = useState<number>(0);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const timerIntervalRef = useRef<NodeJS.Timeout | null>(null);

  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mediaRecorder = new MediaRecorder(stream, {
        mimeType: 'audio/webm',
      });

      mediaRecorderRef.current = mediaRecorder;
      audioChunksRef.current = [];

      // Set up audio level monitoring
      const audioContext = new AudioContext();
      const analyser = audioContext.createAnalyser();
      const microphone = audioContext.createMediaStreamSource(stream);
      
      analyser.fftSize = 256;
      microphone.connect(analyser);
      
      audioContextRef.current = audioContext;
      analyserRef.current = analyser;
      
      // Start monitoring audio levels
      monitorAudioLevel();

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      mediaRecorder.onstop = async () => {
        const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
        await transcribeAudio(audioBlob);
        
        // Clean up audio monitoring
        if (animationFrameRef.current) {
          cancelAnimationFrame(animationFrameRef.current);
        }
        if (audioContextRef.current) {
          audioContextRef.current.close();
        }
        setAudioLevel(0);
        
        // Clear timer
        if (timerIntervalRef.current) {
          clearInterval(timerIntervalRef.current);
          timerIntervalRef.current = null;
        }
        
        // Stop all tracks to release the microphone
        stream.getTracks().forEach(track => track.stop());
      };

      mediaRecorder.start();
      setIsRecording(true);
      setRecordingTime(0);
      setError('');
      
      // Start timer
      timerIntervalRef.current = setInterval(() => {
        setRecordingTime((prev) => {
          const newTime = prev + 1;
          // Auto-stop when limit is reached
          if (newTime >= MAX_RECORDING_TIME_SECONDS) {
            stopRecording();
            return MAX_RECORDING_TIME_SECONDS;
          }
          return newTime;
        });
      }, 1000);
    } catch (err) {
      setError('Failed to access microphone. Please check permissions.');
      console.error('Error accessing microphone:', err);
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
      
      // Clear timer
      if (timerIntervalRef.current) {
        clearInterval(timerIntervalRef.current);
        timerIntervalRef.current = null;
      }
    }
  };

  const monitorAudioLevel = () => {
    if (!analyserRef.current) return;
    
    const dataArray = new Uint8Array(analyserRef.current.frequencyBinCount);
    
    const updateLevel = () => {
      if (!analyserRef.current) return;
      
      analyserRef.current.getByteFrequencyData(dataArray);
      
      // Calculate average volume
      const average = dataArray.reduce((sum, value) => sum + value, 0) / dataArray.length;
      
      // Normalize to 0-100 range
      const normalizedLevel = Math.min(100, (average / 255) * 100);
      setAudioLevel(normalizedLevel);
      
      animationFrameRef.current = requestAnimationFrame(updateLevel);
    };
    
    updateLevel();
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

  // Cleanup timer on unmount
  useEffect(() => {
    return () => {
      if (timerIntervalRef.current) {
        clearInterval(timerIntervalRef.current);
      }
    };
  }, []);

  const questions = [
    "How do I check my transfer's status?",
    "When will my money arrive?",
    "Why does it say my transfer's complete when the money hasn't arrived yet?",
    "Why is my transfer taking longer than the estimate?",
    "What is a proof of payment?",
    "What's a banking partner reference number?"
  ];

  return (
    <div className="flex flex-col items-center gap-6 p-8 max-w-2xl mx-auto">
      <h1 className="text-3xl font-bold">Simple Voice Agent</h1>
      
      <div className="w-full bg-blue-50 border-2 border-blue-200 rounded-lg p-6 space-y-4">
        <div>
          <h2 className="text-xl font-semibold text-blue-900 mb-2">Try These Questions:</h2>
          <p className="text-sm text-blue-700 mb-4 italic">
            The agent can handle contextual variations of these questions. Feel free to ask them in your own words!
          </p>
        </div>
        <ol className="list-decimal list-inside space-y-2 text-gray-800">
          {questions.map((question, index) => (
            <li key={index} className="text-base">
              {question}
            </li>
          ))}
        </ol>
      </div>

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

      {isRecording && (
        <div className="w-full max-w-md space-y-2">
          <div className="flex items-center justify-between text-sm text-gray-600">
            <span>Recording Time</span>
            <span className={`font-semibold ${
              recordingTime >= MAX_RECORDING_TIME_SECONDS - 10
                ? 'text-red-600'
                : 'text-gray-700'
            }`}>
              {recordingTime}s / {MAX_RECORDING_TIME_SECONDS}s
            </span>
          </div>
          <div className="w-full h-2 bg-gray-200 rounded-full overflow-hidden">
            <div
              className={`h-full transition-all duration-300 ${
                recordingTime >= MAX_RECORDING_TIME_SECONDS - 10
                  ? 'bg-red-500'
                  : 'bg-blue-500'
              }`}
              style={{ width: `${(recordingTime / MAX_RECORDING_TIME_SECONDS) * 100}%` }}
            />
          </div>
          <div className="flex items-center justify-between text-sm text-gray-600">
            <span>Audio Level</span>
            <span>{Math.round(audioLevel)}%</span>
          </div>
          <div className="w-full h-4 bg-gray-200 rounded-full overflow-hidden">
            <div
              className={`h-full transition-all duration-100 ${
                audioLevel < 20
                  ? 'bg-gray-400'
                  : audioLevel < 60
                  ? 'bg-green-500'
                  : audioLevel < 80
                  ? 'bg-yellow-500'
                  : 'bg-red-500'
              }`}
              style={{ width: `${audioLevel}%` }}
            />
          </div>
        </div>
      )}

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