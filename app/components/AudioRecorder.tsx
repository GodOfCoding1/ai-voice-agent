"use client";

import { useState, useRef, useEffect, useCallback } from "react";

// Configuration
const DEEPGRAM_SAMPLE_RATE = 16000;
const SILENCE_PROMPT_DELAY_MS = 7000; // 7 seconds of silence before prompting
const EXTENDED_SILENCE_DELAY_MS = 20000; // 20 seconds when user asks to wait

// Deepgram Flux v2 turn events
type TurnEvent =
  | "Update"
  | "StartOfTurn"
  | "EagerEndOfTurn"
  | "TurnResumed"
  | "EndOfTurn";

type ConnectionState =
  | "disconnected"
  | "connecting"
  | "connected"
  | "processing"
  | "responding";

interface TurnState {
  turnIndex: number;
  event: TurnEvent | null;
  confidence: number;
}

export default function AudioRecorder() {
  // Connection and state
  const [connectionState, setConnectionState] =
    useState<ConnectionState>("disconnected");
  const [error, setError] = useState<string>("");

  // Audio visualization
  const [audioLevel, setAudioLevel] = useState<number>(0);
  const [isSpeaking, setIsSpeaking] = useState(false);

  // Transcription - live streaming
  const [liveTranscript, setLiveTranscript] = useState<string>("");
  const [turnState, setTurnState] = useState<TurnState>({
    turnIndex: 0,
    event: null,
    confidence: 0,
  });

  // Response
  const [questionNumber, setQuestionNumber] = useState<number | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [processingMessage, setProcessingMessage] = useState<string>("");

  // Wait intent state
  const [isExtendedWait, setIsExtendedWait] = useState(false);

  // Refs
  const websocketRef = useRef<WebSocket | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const isProcessingRef = useRef(false);
  const eagerEndTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const silenceTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const isCheckingWaitIntentRef = useRef(false);

  // Cleanup function
  const cleanup = useCallback(() => {
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }

    if (eagerEndTimeoutRef.current) {
      clearTimeout(eagerEndTimeoutRef.current);
      eagerEndTimeoutRef.current = null;
    }

    if (silenceTimeoutRef.current) {
      clearTimeout(silenceTimeoutRef.current);
      silenceTimeoutRef.current = null;
    }

    if (processorRef.current) {
      processorRef.current.disconnect();
      processorRef.current = null;
    }

    if (audioContextRef.current && audioContextRef.current.state !== "closed") {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }

    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((track) => track.stop());
      mediaStreamRef.current = null;
    }

    if (websocketRef.current) {
      // Send CloseStream message before closing
      if (websocketRef.current.readyState === WebSocket.OPEN) {
        websocketRef.current.send(JSON.stringify({ type: "CloseStream" }));
      }
      websocketRef.current.close();
      websocketRef.current = null;
    }

    setAudioLevel(0);
    setIsSpeaking(false);
    setIsExtendedWait(false);
  }, []);

  // Process the final transcript with LLM
  const processTranscript = useCallback(
    async (transcript: string) => {
      if (!transcript.trim() || isProcessingRef.current) return;

      isProcessingRef.current = true;
      setConnectionState("processing");
      setProcessingMessage("Analyzing your question...");

      try {
        const response = await fetch("/api/process-stream", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ transcript }),
        });

        if (!response.ok) {
          throw new Error("Failed to process transcript");
        }

        const reader = response.body?.getReader();
        const decoder = new TextDecoder();

        if (!reader) throw new Error("No response body");

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          const chunk = decoder.decode(value);
          const lines = chunk
            .split("\n")
            .filter((line) => line.startsWith("data: "));

          for (const line of lines) {
            try {
              const data = JSON.parse(line.slice(6));

              if (data.type === "processing") {
                setProcessingMessage(data.message);
              } else if (data.type === "result") {
                setQuestionNumber(data.questionNumber);
                setAudioUrl(data.audioUrl);
                setConnectionState("responding");

                // Auto-play audio if available
                if (data.audioUrl && audioRef.current) {
                  audioRef.current.src = data.audioUrl;
                  audioRef.current.play().catch(console.error);
                }
              } else if (data.type === "done") {
                setProcessingMessage("");
              } else if (data.type === "error") {
                setError(data.message);
              }
            } catch {
              // Ignore parse errors for incomplete chunks
            }
          }
        }
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "Failed to process transcript"
        );
      } finally {
        isProcessingRef.current = false;
        if (connectionState === "processing") {
          setConnectionState("disconnected");
        }
      }
    },
    [connectionState]
  );

  // Check if user is asking to wait/hold on
  const checkWaitIntent = useCallback(
    async (transcript: string): Promise<boolean> => {
      if (!transcript.trim() || isCheckingWaitIntentRef.current) return false;

      isCheckingWaitIntentRef.current = true;

      try {
        const response = await fetch("/api/check-wait-intent", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ transcript }),
        });

        if (!response.ok) {
          console.error("Failed to check wait intent");
          return false;
        }

        const data = await response.json();
        return data.isWaitIntent === true;
      } catch (err) {
        console.error("Error checking wait intent:", err);
        return false;
      } finally {
        isCheckingWaitIntentRef.current = false;
      }
    },
    []
  );

  // Reset silence timer - call when speech is detected
  // If no speech for 7 seconds (or 20 if extended), end the call
  const resetSilenceTimer = useCallback(
    (useExtendedTimeout = false) => {
      if (silenceTimeoutRef.current) {
        clearTimeout(silenceTimeoutRef.current);
      }

      const timeout = useExtendedTimeout
        ? EXTENDED_SILENCE_DELAY_MS
        : SILENCE_PROMPT_DELAY_MS;

      silenceTimeoutRef.current = setTimeout(() => {
        console.log(
          `No speech detected for ${timeout / 1000} seconds - ending call`
        );
        cleanup();
        setConnectionState("disconnected");
        setIsExtendedWait(false);
      }, timeout);
    },
    [cleanup]
  );

  // Start the livestream connection using Deepgram Flux v2
  const startListening = async () => {
    try {
      setError("");
      setConnectionState("connecting");
      setLiveTranscript("");
      setQuestionNumber(null);
      setAudioUrl(null);
      setTurnState({ turnIndex: 0, event: null, confidence: 0 });
      setIsExtendedWait(false);

      // Stop any playing audio
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current.currentTime = 0;
      }

      // Get Deepgram API key
      const tokenResponse = await fetch("/api/deepgram-token");
      if (!tokenResponse.ok) {
        throw new Error("Failed to get Deepgram token");
      }
      const { apiKey } = await tokenResponse.json();

      // Get microphone access
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          sampleRate: DEEPGRAM_SAMPLE_RATE,
          echoCancellation: true,
          noiseSuppression: true,
        },
      });
      mediaStreamRef.current = stream;

      // Create WebSocket connection to Deepgram Flux v2
      // Using the new turn-based API for natural conversation flow
      const wsUrl = new URL("wss://api.deepgram.com/v2/listen");
      wsUrl.searchParams.set("model", "flux-general-en");
      wsUrl.searchParams.set("encoding", "linear16");
      wsUrl.searchParams.set("sample_rate", String(DEEPGRAM_SAMPLE_RATE));
      // Tune thresholds for responsive turn detection
      wsUrl.searchParams.set("eot_timeout_ms", "1500"); // 1.5 second timeout for end of turn

      const ws = new WebSocket(wsUrl.toString(), ["token", apiKey]);
      websocketRef.current = ws;

      ws.onopen = () => {
        console.log("Deepgram Flux v2 WebSocket connected");
        setConnectionState("connected");
        startAudioProcessing(stream);
        // Start silence timer
        resetSilenceTimer();
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);

          // Handle Connected message
          if (data.type === "Connected") {
            console.log("Deepgram connected:", data.request_id);
            return;
          }

          // Handle TurnInfo messages (the core of Flux v2)
          if (data.type === "TurnInfo") {
            const {
              event: turnEvent,
              turn_index,
              transcript,
              end_of_turn_confidence,
            } = data;

            console.log(`Turn event: ${turnEvent}`, {
              turnIndex: turn_index,
              confidence: end_of_turn_confidence,
              transcript: transcript?.slice(0, 50),
            });

            // Update turn state
            setTurnState({
              turnIndex: turn_index,
              event: turnEvent as TurnEvent,
              confidence: end_of_turn_confidence,
            });

            // Update live transcript in real-time
            if (transcript) {
              setLiveTranscript(transcript);
            }

            // Handle different turn events
            switch (turnEvent) {
              case "StartOfTurn":
                setIsSpeaking(true);
                setIsExtendedWait(false); // Reset extended wait when user starts speaking
                // Reset silence timer - user is speaking
                resetSilenceTimer();
                // Clear any pending eager end timeout
                if (eagerEndTimeoutRef.current) {
                  clearTimeout(eagerEndTimeoutRef.current);
                  eagerEndTimeoutRef.current = null;
                }
                break;

              case "Update":
                // Reset silence timer when we get transcript updates
                if (transcript) {
                  resetSilenceTimer();
                }
                break;

              case "EagerEndOfTurn":
                // High confidence the user stopped - prepare to process
                // Wait a bit to see if TurnResumed comes
                eagerEndTimeoutRef.current = setTimeout(async () => {
                  // If we haven't received TurnResumed, check for wait intent then process
                  if (transcript && websocketRef.current) {
                    const finalTranscript = transcript;

                    // Check if user is asking to wait
                    const isWaitIntent = await checkWaitIntent(finalTranscript);

                    if (isWaitIntent) {
                      console.log(
                        "User asked to wait - extending timeout to 20 seconds"
                      );
                      setIsExtendedWait(true);
                      setLiveTranscript("");
                      resetSilenceTimer(true); // Use extended 20 second timeout
                    } else {
                      cleanup();
                      setConnectionState("processing");
                      processTranscript(finalTranscript);
                    }
                  }
                }, 800); // Wait 800ms for potential TurnResumed
                break;

              case "TurnResumed":
                // User continued speaking after EagerEndOfTurn
                // Reset silence timer - user is still speaking
                resetSilenceTimer();
                // Clear the timeout so we don't process prematurely
                if (eagerEndTimeoutRef.current) {
                  clearTimeout(eagerEndTimeoutRef.current);
                  eagerEndTimeoutRef.current = null;
                }
                setIsSpeaking(true);
                break;

              case "EndOfTurn":
                // Definitive end of turn - check for wait intent then process
                if (eagerEndTimeoutRef.current) {
                  clearTimeout(eagerEndTimeoutRef.current);
                  eagerEndTimeoutRef.current = null;
                }
                if (transcript) {
                  const finalTranscript = transcript;

                  // Check if user is asking to wait
                  checkWaitIntent(finalTranscript).then((isWaitIntent) => {
                    if (isWaitIntent) {
                      console.log(
                        "User asked to wait - extending timeout to 20 seconds"
                      );
                      setIsExtendedWait(true);
                      setLiveTranscript("");
                      resetSilenceTimer(true); // Use extended 20 second timeout
                    } else {
                      cleanup();
                      setConnectionState("processing");
                      processTranscript(finalTranscript);
                    }
                  });
                }
                break;
            }
          }

          // Handle fatal errors
          if (data.type === "Error") {
            console.error("Deepgram error:", data);
            setError(data.description || "Deepgram error occurred");
            cleanup();
            setConnectionState("disconnected");
          }
        } catch (e) {
          console.error("Error parsing Deepgram message:", e);
        }
      };

      ws.onerror = (event) => {
        console.error("WebSocket error:", event);
        setError("Connection error. Please try again.");
        cleanup();
        setConnectionState("disconnected");
      };

      ws.onclose = (event) => {
        console.log("Deepgram WebSocket closed:", event.code, event.reason);
        if (connectionState === "connected") {
          setConnectionState("disconnected");
        }
      };
    } catch (err) {
      console.error("Error starting livestream:", err);
      setError(
        err instanceof Error ? err.message : "Failed to start listening"
      );
      cleanup();
      setConnectionState("disconnected");
    }
  };

  // Process and stream audio data
  const startAudioProcessing = (stream: MediaStream) => {
    const audioContext = new AudioContext({ sampleRate: DEEPGRAM_SAMPLE_RATE });
    audioContextRef.current = audioContext;

    const source = audioContext.createMediaStreamSource(stream);
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 256;
    analyserRef.current = analyser;
    source.connect(analyser);

    // Create script processor for sending audio data
    const processor = audioContext.createScriptProcessor(4096, 1, 1);
    processorRef.current = processor;
    source.connect(processor);
    processor.connect(audioContext.destination);

    processor.onaudioprocess = (e) => {
      if (websocketRef.current?.readyState === WebSocket.OPEN) {
        const inputData = e.inputBuffer.getChannelData(0);

        // Convert float32 to int16 (linear16 encoding)
        const int16Data = new Int16Array(inputData.length);
        for (let i = 0; i < inputData.length; i++) {
          const s = Math.max(-1, Math.min(1, inputData[i]));
          int16Data[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
        }

        // Send raw binary audio data (ListenV2Media)
        websocketRef.current.send(int16Data.buffer);
      }
    };

    // Monitor audio levels for visualization
    const dataArray = new Uint8Array(analyser.frequencyBinCount);

    const updateLevel = () => {
      if (!analyserRef.current) return;

      analyserRef.current.getByteFrequencyData(dataArray);
      const average =
        dataArray.reduce((sum, val) => sum + val, 0) / dataArray.length;
      const normalizedLevel = Math.min(100, (average / 255) * 100);
      setAudioLevel(normalizedLevel);

      animationFrameRef.current = requestAnimationFrame(updateLevel);
    };

    updateLevel();
  };

  // Stop listening
  const stopListening = () => {
    const transcript = liveTranscript;
    cleanup();

    if (transcript.trim()) {
      processTranscript(transcript);
    } else {
      setConnectionState("disconnected");
    }
  };

  // Cleanup on unmount
  useEffect(() => {
    return () => cleanup();
  }, [cleanup]);

  // Audio ended handler
  const handleAudioEnded = () => {
    setConnectionState("disconnected");
  };

  const questions = [
    "How do I check my transfer's status?",
    "When will my money arrive?",
    "Why does it say my transfer's complete when the money hasn't arrived yet?",
    "Why is my transfer taking longer than the estimate?",
    "What is a proof of payment?",
    "What's a banking partner reference number?",
  ];

  const isListening = connectionState === "connected";
  const isProcessing = connectionState === "processing";
  const isResponding = connectionState === "responding";
  const isConnecting = connectionState === "connecting";

  // Get turn status text
  const getTurnStatusText = () => {
    if (isExtendedWait) {
      return "Take your time... (20s)";
    }
    if (!turnState.event) return null;
    switch (turnState.event) {
      case "StartOfTurn":
        return "Speaking detected...";
      case "Update":
        return "Listening...";
      case "EagerEndOfTurn":
        return `Finishing... (${Math.round(
          turnState.confidence * 100
        )}% confident)`;
      case "TurnResumed":
        return "Continuing...";
      case "EndOfTurn":
        return "Processing...";
      default:
        return null;
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-950 via-indigo-950 to-slate-900 text-white">
      {/* Animated background elements */}
      <div className="fixed inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-1/4 left-1/4 w-96 h-96 bg-indigo-500/10 rounded-full blur-3xl animate-pulse" />
        <div className="absolute bottom-1/4 right-1/4 w-96 h-96 bg-violet-500/10 rounded-full blur-3xl animate-pulse delay-1000" />
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] bg-gradient-radial from-indigo-500/5 to-transparent rounded-full" />
      </div>

      <div className="relative z-10 flex flex-col items-center gap-8 p-8 max-w-3xl mx-auto">
        {/* Header */}
        <div className="text-center space-y-2">
          <h1 className="text-4xl font-light tracking-wide">
            <span className="bg-gradient-to-r from-indigo-300 via-violet-300 to-purple-300 bg-clip-text text-transparent">
              Voice Agent
            </span>
          </h1>
          <p className="text-slate-400 text-sm font-light tracking-wider uppercase">
            Flux Streaming • Turn-based Detection
          </p>
        </div>

        {/* Main interaction area */}
        <div className="relative w-full">
          {/* Voice orb */}
          <div className="flex justify-center mb-8">
            <button
              onClick={isListening ? stopListening : startListening}
              disabled={isProcessing || isConnecting}
              className="relative group"
            >
              {/* Outer glow rings */}
              <div
                className={`absolute inset-0 rounded-full transition-all duration-500 ${
                  isListening
                    ? "animate-ping bg-indigo-500/30"
                    : isProcessing
                    ? "animate-pulse bg-amber-500/20"
                    : isResponding
                    ? "animate-pulse bg-emerald-500/20"
                    : "bg-transparent"
                }`}
                style={{ transform: "scale(1.5)" }}
              />

              {/* Audio level ring */}
              {isListening && (
                <div
                  className="absolute inset-0 rounded-full border-2 border-indigo-400/50 transition-transform duration-75"
                  style={{ transform: `scale(${1 + audioLevel / 100})` }}
                />
              )}

              {/* Turn confidence ring */}
              {isListening && turnState.event === "EagerEndOfTurn" && (
                <div
                  className="absolute inset-0 rounded-full border-4 border-amber-400/70 transition-all duration-300"
                  style={{
                    transform: `scale(${1.1 + turnState.confidence * 0.2})`,
                    opacity: turnState.confidence,
                  }}
                />
              )}

              {/* Main orb */}
              <div
                className={`relative w-32 h-32 rounded-full flex items-center justify-center transition-all duration-300 ${
                  isListening
                    ? isExtendedWait
                      ? "bg-gradient-to-br from-cyan-500 to-teal-600 shadow-lg shadow-cyan-500/50"
                      : turnState.event === "EagerEndOfTurn"
                      ? "bg-gradient-to-br from-amber-500 to-orange-600 shadow-lg shadow-amber-500/50"
                      : "bg-gradient-to-br from-indigo-500 to-violet-600 shadow-lg shadow-indigo-500/50"
                    : isProcessing
                    ? "bg-gradient-to-br from-amber-500 to-orange-600 shadow-lg shadow-amber-500/50"
                    : isResponding
                    ? "bg-gradient-to-br from-emerald-500 to-teal-600 shadow-lg shadow-emerald-500/50"
                    : isConnecting
                    ? "bg-gradient-to-br from-slate-600 to-slate-700 animate-pulse"
                    : "bg-gradient-to-br from-slate-700 to-slate-800 hover:from-indigo-600 hover:to-violet-700 hover:shadow-lg hover:shadow-indigo-500/30"
                } ${
                  isProcessing || isConnecting
                    ? "cursor-wait"
                    : "cursor-pointer"
                }`}
              >
                {/* Icon */}
                {isConnecting ? (
                  <svg
                    className="w-10 h-10 animate-spin"
                    fill="none"
                    viewBox="0 0 24 24"
                  >
                    <circle
                      className="opacity-25"
                      cx="12"
                      cy="12"
                      r="10"
                      stroke="currentColor"
                      strokeWidth="4"
                    />
                    <path
                      className="opacity-75"
                      fill="currentColor"
                      d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                    />
                  </svg>
                ) : isListening ? (
                  <div className="flex items-center gap-1">
                    {[...Array(5)].map((_, i) => (
                      <div
                        key={i}
                        className="w-1.5 bg-white rounded-full transition-all duration-75"
                        style={{
                          height: `${Math.max(
                            10,
                            Math.min(45, 10 + audioLevel * 0.8)
                          )}px`,
                        }}
                      />
                    ))}
                  </div>
                ) : isProcessing ? (
                  <svg
                    className="w-10 h-10 animate-spin"
                    fill="none"
                    viewBox="0 0 24 24"
                  >
                    <circle
                      className="opacity-25"
                      cx="12"
                      cy="12"
                      r="10"
                      stroke="currentColor"
                      strokeWidth="4"
                    />
                    <path
                      className="opacity-75"
                      fill="currentColor"
                      d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                    />
                  </svg>
                ) : isResponding ? (
                  <svg
                    className="w-10 h-10"
                    fill="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z" />
                  </svg>
                ) : (
                  <svg
                    className="w-10 h-10"
                    fill="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm-1-9c0-.55.45-1 1-1s1 .45 1 1v6c0 .55-.45 1-1 1s-1-.45-1-1V5zm6 6c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z" />
                  </svg>
                )}
              </div>
            </button>
          </div>

          {/* Status text */}
          <div className="text-center mb-6">
            <p
              className={`text-lg font-light transition-colors duration-300 ${
                isListening
                  ? isExtendedWait
                    ? "text-cyan-300"
                    : turnState.event === "EagerEndOfTurn"
                    ? "text-amber-300"
                    : "text-indigo-300"
                  : isProcessing
                  ? "text-amber-300"
                  : isResponding
                  ? "text-emerald-300"
                  : "text-slate-400"
              }`}
            >
              {isConnecting && "Connecting..."}
              {isListening && (getTurnStatusText() || "Speak now")}
              {isProcessing && (processingMessage || "Processing...")}
              {isResponding && "Playing response..."}
              {connectionState === "disconnected" && "Tap to start"}
            </p>

            {/* Turn confidence indicator */}
            {isListening && turnState.event && !isExtendedWait && (
              <div className="mt-2 flex items-center justify-center gap-2">
                <div className="h-1 w-24 bg-slate-700 rounded-full overflow-hidden">
                  <div
                    className={`h-full transition-all duration-200 ${
                      turnState.event === "EagerEndOfTurn"
                        ? "bg-amber-400"
                        : "bg-indigo-400"
                    }`}
                    style={{ width: `${turnState.confidence * 100}%` }}
                  />
                </div>
                <span className="text-xs text-slate-500">
                  {Math.round(turnState.confidence * 100)}%
                </span>
              </div>
            )}

            {/* Extended wait indicator */}
            {isExtendedWait && isListening && (
              <div className="mt-3 flex items-center justify-center">
                <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-cyan-500/20 border border-cyan-400/40 animate-pulse">
                  <svg
                    className="w-4 h-4 text-cyan-300"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
                    />
                  </svg>
                  <span className="text-sm font-medium text-cyan-300">
                    Extended wait • 20 seconds
                  </span>
                </div>
              </div>
            )}
          </div>

          {/* Live transcript display - real-time streaming */}
          {(liveTranscript || isListening) && (
            <div className="mb-6 p-6 rounded-2xl bg-white/5 backdrop-blur-sm border border-white/10 min-h-[120px]">
              <div className="flex items-center gap-2 mb-3">
                <div
                  className={`w-2 h-2 rounded-full ${
                    isListening
                      ? isExtendedWait
                        ? "bg-cyan-400 animate-pulse"
                        : turnState.event === "EagerEndOfTurn"
                        ? "bg-amber-400 animate-pulse"
                        : "bg-indigo-400 animate-pulse"
                      : "bg-slate-500"
                  }`}
                />
                <span className="text-xs uppercase tracking-wider text-slate-400">
                  Live Transcript
                </span>
                {turnState.event && isListening && (
                  <span
                    className={`ml-auto text-xs px-2 py-0.5 rounded-full ${
                      turnState.event === "EagerEndOfTurn"
                        ? "bg-amber-500/20 text-amber-300"
                        : turnState.event === "StartOfTurn"
                        ? "bg-green-500/20 text-green-300"
                        : "bg-indigo-500/20 text-indigo-300"
                    }`}
                  >
                    {turnState.event}
                  </span>
                )}
              </div>
              <p className="text-xl text-white/90 leading-relaxed min-h-[2em]">
                {liveTranscript || (
                  <span className="text-slate-500 italic">
                    Start speaking...
                  </span>
                )}
                {isListening && liveTranscript && (
                  <span className="inline-block w-0.5 h-6 bg-indigo-400 ml-1 animate-pulse align-middle" />
                )}
              </p>
            </div>
          )}

          {/* Result display */}
          {questionNumber !== null && (
            <div
              className={`mb-6 p-6 rounded-2xl backdrop-blur-sm border ${
                questionNumber === -1
                  ? "bg-amber-500/10 border-amber-500/30"
                  : "bg-emerald-500/10 border-emerald-500/30"
              }`}
            >
              <div className="flex items-center gap-2 mb-3">
                <div
                  className={`w-2 h-2 rounded-full ${
                    questionNumber === -1 ? "bg-amber-400" : "bg-emerald-400"
                  }`}
                />
                <span className="text-xs uppercase tracking-wider text-slate-400">
                  Identified Question
                </span>
              </div>
              {questionNumber === -1 ? (
                <p className="text-amber-200">No matching question found</p>
              ) : (
                <div>
                  <p className="text-emerald-300 font-medium mb-1">
                    Question #{questionNumber}
                  </p>
                  <p className="text-white/80">
                    {questions[questionNumber - 1]}
                  </p>
                </div>
              )}
            </div>
          )}

          {/* Audio player (hidden, controlled programmatically) */}
          <audio
            ref={audioRef}
            onEnded={handleAudioEnded}
            onError={() => setError("Failed to play audio response")}
            className="hidden"
          />

          {/* Visible audio controls when responding */}
          {audioUrl && isResponding && (
            <div className="mb-6 p-4 rounded-xl bg-emerald-500/10 border border-emerald-500/30">
              <audio
                src={audioUrl}
                controls
                autoPlay
                className="w-full h-10"
                style={{ filter: "invert(1)" }}
              />
            </div>
          )}

          {/* Error display */}
          {error && (
            <div className="mb-6 p-4 rounded-xl bg-red-500/10 border border-red-500/30">
              <p className="text-red-300 text-sm">{error}</p>
            </div>
          )}
        </div>

        {/* Questions list */}
        <div className="w-full p-6 rounded-2xl bg-white/5 backdrop-blur-sm border border-white/10">
          <h2 className="text-sm uppercase tracking-wider text-slate-400 mb-4">
            Try asking about:
          </h2>
          <ul className="space-y-3">
            {questions.map((question, index) => (
              <li
                key={index}
                className={`flex items-start gap-3 text-sm transition-colors ${
                  questionNumber === index + 1
                    ? "text-emerald-300"
                    : "text-slate-300 hover:text-white"
                }`}
              >
                <span
                  className={`flex-shrink-0 w-6 h-6 rounded-full flex items-center justify-center text-xs ${
                    questionNumber === index + 1
                      ? "bg-emerald-500/30 text-emerald-300"
                      : "bg-white/10 text-slate-400"
                  }`}
                >
                  {index + 1}
                </span>
                <span>{question}</span>
              </li>
            ))}
          </ul>
        </div>

        {/* Footer hint */}
        <p className="text-xs text-slate-500 text-center">
          Powered by Deepgram Flux • Natural turn detection for seamless
          conversation
        </p>
      </div>
    </div>
  );
}
