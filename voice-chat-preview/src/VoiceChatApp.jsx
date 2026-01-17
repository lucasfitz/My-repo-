import React, { useState, useRef, useEffect } from 'react';

// Icons as simple SVG components
const MicIcon = ({ size = 24, className = "" }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
    <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/>
    <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
    <line x1="12" x2="12" y1="19" y2="22"/>
  </svg>
);

const XIcon = ({ size = 24, className = "" }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
    <path d="M18 6 6 18"/>
    <path d="m6 6 12 12"/>
  </svg>
);

const SettingsIcon = ({ size = 24, className = "" }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
    <circle cx="12" cy="12" r="3"/>
    <path d="M12 1v6m0 6v6M5.64 5.64l4.24 4.24m4.24 4.24l4.24 4.24M1 12h6m6 0h6M5.64 18.36l4.24-4.24m4.24-4.24l4.24-4.24"/>
  </svg>
);

export default function VoiceChatApp() {
  const [messages, setMessages] = useState([]);
  const [inputText, setInputText] = useState('');
  const [isRecording, setIsRecording] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [recordingDuration, setRecordingDuration] = useState(0);
  const [characterMood, setCharacterMood] = useState('idle');
  const messagesEndRef = useRef(null);
  const recordingIntervalRef = useRef(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  useEffect(() => {
    if (isRecording) {
      recordingIntervalRef.current = setInterval(() => {
        setRecordingDuration(prev => prev + 1);
      }, 1000);
    } else {
      clearInterval(recordingIntervalRef.current);
      setRecordingDuration(0);
    }
    return () => clearInterval(recordingIntervalRef.current);
  }, [isRecording]);

  const formatDuration = (seconds) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  const generateResponse = (input) => {
    const responses = [
      "That's wonderful! Learning keeps our minds sharp and curious. What subject has been calling to you lately?",
      "I love that energy! There's something magical about the moment before discovery. What's piqued your interest?",
      "Perfect mindset! The world is full of fascinating things. Want to explore something together?",
      "Curiosity is such a gift! What questions have been bubbling up for you recently?",
    ];
    return responses[Math.floor(Math.random() * responses.length)];
  };

  const sendMessage = (text) => {
    const userMessage = { role: 'user', content: text, type: 'text', timestamp: new Date() };
    setMessages(prev => [...prev, userMessage]);
    setInputText('');
    setIsProcessing(true);
    setCharacterMood('thinking');

    setTimeout(() => {
      const aiMessage = {
        role: 'assistant',
        content: generateResponse(text),
        type: 'text',
        timestamp: new Date()
      };
      setMessages(prev => [...prev, aiMessage]);
      setIsProcessing(false);
      setCharacterMood('happy');
      setTimeout(() => setCharacterMood('idle'), 2000);
    }, 1500);
  };

  const handleSendText = () => {
    if (!inputText.trim()) return;
    sendMessage(inputText);
  };

  const toggleRecording = () => {
    if (isRecording) {
      // Stop recording
      setIsRecording(false);
      const transcribedText = "I'd love to learn something new today";
      const userMessage = { role: 'user', content: transcribedText, type: 'voice', timestamp: new Date() };
      setMessages(prev => [...prev, userMessage]);
      setIsProcessing(true);
      setCharacterMood('thinking');

      setTimeout(() => {
        const aiMessage = {
          role: 'assistant',
          content: generateResponse(transcribedText),
          type: 'text',
          timestamp: new Date()
        };
        setMessages(prev => [...prev, aiMessage]);
        setIsProcessing(false);
        setCharacterMood('happy');
        setTimeout(() => setCharacterMood('idle'), 2000);
      }, 1500);
    } else {
      // Start recording
      setIsRecording(true);
      setCharacterMood('listening');
    }
  };

  const handleKeyPress = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSendText();
    }
  };

  const Character = ({ mood, size = 'large' }) => {
    const baseSize = size === 'large' ? 240 : 44;

    return (
      <div
        className={`relative flex items-center justify-center transition-all duration-500 ${
          mood === 'listening' ? 'scale-105' : mood === 'thinking' ? 'scale-95' : ''
        }`}
        style={{
          width: baseSize,
          height: baseSize,
        }}
      >
        {/* Main character blob */}
        <div
          className="absolute inset-0 rounded-full"
          style={{
            background: 'linear-gradient(135deg, #FFB5A7 0%, #FEC89A 50%, #FED7AA 100%)',
            boxShadow: '0 20px 60px rgba(254, 200, 154, 0.4)',
          }}
        />

        {/* Glow effect when listening */}
        {mood === 'listening' && size === 'large' && (
          <>
            <div
              className="absolute inset-0 rounded-full animate-ping"
              style={{
                background: 'radial-gradient(circle, rgba(254, 200, 154, 0.6) 0%, transparent 70%)',
              }}
            />
            <div
              className="absolute inset-0 rounded-full animate-pulse"
              style={{
                background: 'radial-gradient(circle, rgba(255, 181, 167, 0.4) 0%, transparent 70%)',
              }}
            />
          </>
        )}

        {/* Glasses and face */}
        <div className="relative flex flex-col items-center justify-center z-10">
          {size === 'large' && (
            <>
              {/* Glasses */}
              <div className="flex items-center gap-3 mb-2">
                {/* Left lens */}
                <div className="relative">
                  <div
                    className="rounded-full border-[6px] border-gray-800 bg-gray-800/5"
                    style={{ width: 52, height: 52 }}
                  />
                  {/* Left pupil */}
                  <div
                    className={`absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-gray-900 rounded-full transition-all duration-300 ${
                      mood === 'happy' ? 'scale-y-50' : mood === 'listening' ? 'scale-110' : ''
                    }`}
                    style={{ width: 8, height: 10 }}
                  />
                </div>

                {/* Bridge */}
                <div className="w-3 h-1 bg-gray-800 rounded-full" style={{ marginTop: -2 }} />

                {/* Right lens */}
                <div className="relative">
                  <div
                    className="rounded-full border-[6px] border-gray-800 bg-gray-800/5"
                    style={{ width: 52, height: 52 }}
                  />
                  {/* Right pupil */}
                  <div
                    className={`absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-gray-900 rounded-full transition-all duration-300 ${
                      mood === 'happy' ? 'scale-y-50' : mood === 'listening' ? 'scale-110' : ''
                    }`}
                    style={{ width: 8, height: 10 }}
                  />
                </div>
              </div>

              {/* Mouth */}
              <div className={`mt-2 transition-all duration-300 ${
                mood === 'happy' ? 'w-8 h-4 border-b-[3px] border-gray-800 rounded-b-full' :
                mood === 'listening' ? 'w-3 h-3 bg-gray-800 rounded-full' :
                mood === 'thinking' ? 'w-6 h-1 bg-gray-800 rounded-full' :
                'w-6 h-1 bg-gray-800 rounded-full'
              }`} />
            </>
          )}

          {size === 'small' && (
            <div className="flex items-center gap-1">
              {/* Small glasses for avatar */}
              <div className="w-3 h-3 rounded-full border-2 border-gray-800" />
              <div className="w-3 h-3 rounded-full border-2 border-gray-800" />
            </div>
          )}
        </div>
      </div>
    );
  };

  return (
    <div
      className="h-screen flex flex-col overflow-hidden"
      style={{
        background: 'linear-gradient(180deg, #F3E8FF 0%, #FCE7F3 20%, #FED7AA 60%, #FEE2C5 100%)'
      }}
    >
      {/* Main Content */}
      <div className="flex-1 overflow-y-auto flex flex-col">
        {messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center flex-1 px-8 pb-32">
            <Character mood={characterMood} size="large" />

            <h2 className="text-[32px] font-bold text-gray-900 text-center mt-12 leading-tight max-w-sm">
              Let's dive in. What would you like to learn?
            </h2>

            {isRecording && (
              <p className="text-gray-600 text-lg mt-4">
                Recording: {formatDuration(recordingDuration)}
              </p>
            )}
          </div>
        ) : (
          <div className="px-4 pb-4 pt-8">
            <div className="flex justify-center py-4">
              <Character mood={characterMood} size="small" />
            </div>

            <div className="space-y-3">
              {messages.map((msg, idx) => (
                <div
                  key={idx}
                  className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
                >
                  <div
                    className={`max-w-[80%] px-4 py-3 ${
                      msg.role === 'user'
                        ? 'text-white rounded-2xl rounded-br-md shadow-lg'
                        : 'bg-white/80 backdrop-blur text-gray-800 rounded-2xl rounded-bl-md shadow-md'
                    }`}
                    style={msg.role === 'user' ? {
                      background: 'linear-gradient(135deg, #FB923C 0%, #F59E0B 100%)'
                    } : {}}
                  >
                    {msg.type === 'voice' && (
                      <div className="flex items-center gap-1 text-xs opacity-70 mb-1">
                        <MicIcon size={10} />
                        <span>Voice message</span>
                      </div>
                    )}
                    <p className="text-[15px] leading-relaxed">{msg.content}</p>
                  </div>
                </div>
              ))}

              {isProcessing && (
                <div className="flex justify-start">
                  <div className="bg-white/80 backdrop-blur px-5 py-4 rounded-2xl rounded-bl-md shadow-md">
                    <div className="flex gap-1.5">
                      <div className="w-2 h-2 bg-orange-300 rounded-full animate-bounce" style={{animationDelay: '0ms'}} />
                      <div className="w-2 h-2 bg-orange-400 rounded-full animate-bounce" style={{animationDelay: '150ms'}} />
                      <div className="w-2 h-2 bg-orange-500 rounded-full animate-bounce" style={{animationDelay: '300ms'}} />
                    </div>
                  </div>
                </div>
              )}
              <div ref={messagesEndRef} />
            </div>
          </div>
        )}
      </div>

      {/* Input Area - Always visible */}
      <div className="px-6 pb-12 pt-4">
        <div className="bg-white/90 backdrop-blur-xl rounded-[28px] shadow-lg flex items-center px-4 py-3 gap-3">
          <button
            onClick={() => setMessages([])}
            className="p-2 hover:bg-gray-100 rounded-full transition-colors flex-shrink-0"
          >
            <XIcon size={24} className="text-gray-600" />
          </button>

          <input
            type="text"
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            onKeyPress={handleKeyPress}
            placeholder="Message..."
            className="flex-1 outline-none text-base text-gray-800 placeholder-gray-400 bg-transparent"
          />

          <button
            onClick={toggleRecording}
            className={`p-3 rounded-full transition-all flex-shrink-0 ${
              isRecording
                ? 'bg-red-500 hover:bg-red-600 animate-pulse'
                : 'bg-cyan-400 hover:bg-cyan-500'
            }`}
          >
            <MicIcon size={24} className="text-white" />
          </button>

          <button
            className="p-3 hover:bg-gray-100 rounded-full transition-colors flex-shrink-0"
          >
            <SettingsIcon size={24} className="text-gray-600" />
          </button>
        </div>
      </div>
    </div>
  );
}
