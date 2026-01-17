import React, { useState, useRef, useEffect } from 'react';

// Icons as simple SVG components
const MicIcon = ({ size = 24, className = "" }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
    <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/>
    <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
    <line x1="12" x2="12" y1="19" y2="22"/>
  </svg>
);

const SendIcon = ({ size = 24, className = "" }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
    <path d="m22 2-7 20-4-9-9-4Z"/>
    <path d="M22 2 11 13"/>
  </svg>
);

const XIcon = ({ size = 24, className = "" }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
    <path d="M18 6 6 18"/>
    <path d="m6 6 12 12"/>
  </svg>
);

const ChevronLeftIcon = ({ size = 24, className = "" }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
    <path d="m15 18-6-6 6-6"/>
  </svg>
);

const MoreHorizontalIcon = ({ size = 24, className = "" }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
    <circle cx="12" cy="12" r="1"/>
    <circle cx="19" cy="12" r="1"/>
    <circle cx="5" cy="12" r="1"/>
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

  const startRecording = () => {
    setIsRecording(true);
    setCharacterMood('listening');
  };

  const stopRecording = () => {
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
  };

  const handleKeyPress = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSendText();
    }
  };

  const Character = ({ mood, size = 'large' }) => {
    const baseSize = size === 'large' ? 180 : 44;
    const eyeSize = size === 'large' ? 16 : 6;

    return (
      <div
        className={`relative rounded-full flex items-center justify-center shadow-xl transition-all duration-500 ${
          mood === 'listening' ? 'scale-105' : mood === 'thinking' ? 'scale-95' : ''
        }`}
        style={{
          width: baseSize,
          height: baseSize,
          background: 'linear-gradient(135deg, #fcd34d 0%, #fb923c 50%, #f472b6 100%)'
        }}
      >
        {/* Glow effect */}
        <div
          className={`absolute inset-0 rounded-full blur-xl transition-opacity duration-500 ${
            mood === 'listening' ? 'opacity-80' : mood === 'happy' ? 'opacity-60' : 'opacity-0'
          }`}
          style={{ background: 'linear-gradient(135deg, #fcd34d50 0%, #fb923c50 50%, #f472b650 100%)' }}
        />

        <div className="relative flex flex-col items-center justify-center">
          {size === 'large' && (
            <svg width="90" height="36" viewBox="0 0 90 36" className="mb-1">
              <ellipse cx="22" cy="18" rx="16" ry="16" fill="none" stroke="#1a1a1a" strokeWidth="5" strokeLinecap="round"/>
              <ellipse cx="68" cy="18" rx="16" ry="16" fill="none" stroke="#1a1a1a" strokeWidth="5" strokeLinecap="round"/>
              <path d="M38 18 Q45 14 52 18" fill="none" stroke="#1a1a1a" strokeWidth="5" strokeLinecap="round"/>
            </svg>
          )}

          <div
            className={`flex items-center justify-center transition-all duration-300 ${size === 'large' ? '-mt-6' : ''}`}
            style={{ gap: size === 'large' ? 32 : 10 }}
          >
            <div
              className={`bg-gray-900 rounded-full transition-all duration-300 ${
                mood === 'happy' ? 'scale-y-50' : mood === 'listening' ? 'scale-110' : ''
              }`}
              style={{ width: eyeSize, height: eyeSize * 1.2 }}
            />
            <div
              className={`bg-gray-900 rounded-full transition-all duration-300 ${
                mood === 'happy' ? 'scale-y-50' : mood === 'listening' ? 'scale-110' : ''
              }`}
              style={{ width: eyeSize, height: eyeSize * 1.2 }}
            />
          </div>

          {size === 'large' && (
            <div className={`mt-3 transition-all duration-300 ${
              mood === 'happy' ? 'w-8 h-4 border-b-4 border-gray-900 rounded-b-full' :
              mood === 'listening' ? 'w-4 h-4 bg-gray-900 rounded-full' :
              mood === 'thinking' ? 'w-6 h-1 bg-gray-900 rounded-full translate-x-2' :
              'w-6 h-1 bg-gray-900 rounded-full'
            }`} />
          )}
        </div>

        {mood === 'listening' && size === 'large' && (
          <>
            <div className="absolute inset-0 rounded-full border-4 border-amber-300/40 animate-ping" />
            <div className="absolute inset-0 rounded-full border-2 border-rose-300/30 animate-pulse" />
          </>
        )}
      </div>
    );
  };

  return (
    <div
      className="h-screen flex flex-col overflow-hidden bg-gradient-to-b from-slate-50 via-orange-50/30 to-amber-50/50"
    >
      {/* iOS Status Bar */}
      <div className="flex items-center justify-between px-6 pt-3 pb-1 text-sm font-semibold">
        <span>9:41</span>
        <div className="absolute left-1/2 -translate-x-1/2 w-28 h-7 bg-black rounded-full" />
        <div className="flex items-center gap-1">
          <svg width="18" height="12" viewBox="0 0 18 12"><path d="M1 4.5h2v7H1zM5 3h2v8.5H5zM9 1.5h2V12H9zM13 0h2v12h-2z" fill="currentColor"/></svg>
          <svg width="16" height="12" viewBox="0 0 16 12"><path d="M8 2a6 6 0 014.9 2.5.5.5 0 01-.8.6A5 5 0 008 3a5 5 0 00-4.1 2.1.5.5 0 01-.8-.6A6 6 0 018 2zm0 3a4 4 0 013.3 1.7.5.5 0 01-.8.6A3 3 0 008 6a3 3 0 00-2.5 1.3.5.5 0 01-.8-.6A4 4 0 018 5zm0 3a2 2 0 011.6.8.5.5 0 01-.8.6 1 1 0 00-1.6 0 .5.5 0 01-.8-.6A2 2 0 018 8zm0 2a1 1 0 110 2 1 1 0 010-2z" fill="currentColor"/></svg>
          <svg width="25" height="12" viewBox="0 0 25 12"><rect x="0" y="0" width="22" height="12" rx="3" fill="none" stroke="currentColor" strokeWidth="1"/><rect x="22" y="4" width="2" height="4" rx="1" fill="currentColor"/><rect x="2" y="2" width="17" height="8" rx="1.5" fill="currentColor"/></svg>
        </div>
      </div>

      {/* Nav Bar */}
      <div className="flex items-center justify-between px-4 py-3">
        <button className="p-2 -ml-2 hover:bg-black/5 rounded-full transition-colors">
          <ChevronLeftIcon size={28} className="text-orange-500" />
        </button>
        <h1 className="text-lg font-semibold text-gray-900">Mico</h1>
        <button className="p-2 -mr-2 hover:bg-black/5 rounded-full transition-colors">
          <MoreHorizontalIcon size={24} className="text-gray-400" />
        </button>
      </div>

      {/* Main Content */}
      <div className="flex-1 overflow-y-auto">
        {messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full px-8 -mt-8">
            <Character mood={characterMood} size="large" />

            <h2 className="text-2xl font-bold text-gray-900 text-center mt-8 mb-2">
              Hey there! 👋
            </h2>
            <p className="text-gray-500 text-center text-base leading-relaxed max-w-xs">
              I'm excited to chat with you. Ask me anything or just say hello!
            </p>

            <div className="flex flex-wrap justify-center gap-2 mt-8 max-w-sm">
              {['Tell me a fun fact', 'Help me brainstorm', 'Explain something'].map((suggestion) => (
                <button
                  key={suggestion}
                  onClick={() => sendMessage(suggestion)}
                  className="px-4 py-2 bg-white rounded-full text-sm text-gray-700 shadow-sm border border-gray-100 hover:shadow-md hover:border-orange-200 transition-all active:scale-95"
                >
                  {suggestion}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="px-4 pb-4">
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
                        ? 'text-white rounded-2xl rounded-br-md shadow-lg shadow-orange-200/50'
                        : 'bg-white text-gray-800 rounded-2xl rounded-bl-md shadow-md'
                    }`}
                    style={msg.role === 'user' ? {
                      background: 'linear-gradient(135deg, #fb923c 0%, #f59e0b 100%)'
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
                  <div className="bg-white px-5 py-4 rounded-2xl rounded-bl-md shadow-md">
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

      {/* Recording Overlay */}
      {isRecording && (
        <div
          className="absolute inset-0 flex flex-col items-center justify-center z-50 backdrop-blur-sm"
          style={{ background: 'linear-gradient(180deg, rgba(251, 146, 60, 0.97) 0%, rgba(245, 158, 11, 0.97) 100%)' }}
        >
          <Character mood="listening" size="large" />

          <p className="text-white text-xl font-medium mt-8">Listening...</p>
          <p className="text-white/70 text-lg mt-2">{formatDuration(recordingDuration)}</p>

          <button
            onClick={stopRecording}
            className="mt-12 w-20 h-20 bg-white rounded-full flex items-center justify-center shadow-2xl active:scale-95 transition-transform"
          >
            <div className="w-8 h-8 bg-orange-500 rounded-md" />
          </button>
          <p className="text-white/60 text-sm mt-4">Tap to stop</p>
        </div>
      )}

      {/* Input Area */}
      <div className="px-4 pb-8 pt-2">
        <div className="bg-white rounded-full shadow-lg shadow-gray-200/50 border border-gray-100 flex items-center px-2 py-1.5 gap-1">
          <button
            onClick={() => setMessages([])}
            className="p-2.5 hover:bg-gray-100 rounded-full transition-colors"
          >
            <XIcon size={22} className="text-gray-400" />
          </button>

          <input
            type="text"
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            onKeyPress={handleKeyPress}
            placeholder="Message..."
            className="flex-1 outline-none text-base text-gray-800 placeholder-gray-400 bg-transparent px-2"
          />

          {inputText.trim() ? (
            <button
              onClick={handleSendText}
              className="p-2.5 rounded-full hover:shadow-lg transition-all active:scale-95"
              style={{ background: 'linear-gradient(135deg, #fb923c 0%, #f59e0b 100%)' }}
            >
              <SendIcon size={20} className="text-white" />
            </button>
          ) : (
            <button
              onClick={startRecording}
              className="p-3 rounded-full hover:shadow-lg transition-all active:scale-95"
              style={{ background: 'linear-gradient(135deg, #fb923c 0%, #f59e0b 100%)' }}
            >
              <MicIcon size={22} className="text-white" />
            </button>
          )}
        </div>

        <div className="flex justify-center mt-4">
          <div className="w-32 h-1 bg-gray-900/20 rounded-full" />
        </div>
      </div>
    </div>
  );
}
