import { useState, useRef, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';

interface ContentPart {
  type: 'text' | 'image' | 'audio' | 'video' | 'info' | 'error' | 'music' | 'blueprint' | 'narration_track' | 'history_meta';
  content?: string;
  blocks?: { index: number; speaker: string; text: string; audio_url: string; music_url?: string }[];
  background_music?: string;
  chat?: ChatRecord;
}

interface ChatRecord {
  id: string;
  prompt: string;
  mode: string;
  style: string;
  created_at: string;
}

const STYLE_MUSIC: Record<string, string> = {
  'Cinematic': 'https://incompetech.com/music/royalty-free/mp3-royaltyfree/Epic%20Unease.mp3',
  'Epic Fantasy': 'https://incompetech.com/music/royalty-free/mp3-royaltyfree/Curse%20of%20the%20Scarab.mp3',
  'Sci-Fi Noir': 'https://incompetech.com/music/royalty-free/mp3-royaltyfree/Unseen%20Horrors.mp3',
  'Political Drama': 'https://incompetech.com/music/royalty-free/mp3-royaltyfree/Dark%20Standoff.mp3',
  'Space Opera': 'https://incompetech.com/music/royalty-free/mp3-royaltyfree/Clash%20Defiant.mp3',
  'Mystery': 'https://incompetech.com/music/royalty-free/mp3-royaltyfree/Gagool.mp3',
  'Comedy': 'https://incompetech.com/music/royalty-free/mp3-royaltyfree/Sneaky%20Snitch.mp3',
  'Thriller': 'https://incompetech.com/music/royalty-free/mp3-royaltyfree/Ghost%20Story.mp3',
  // Scene-based Moods
  'Suspense': 'https://incompetech.com/music/royalty-free/mp3-royaltyfree/Echoes%20of%20Time.mp3',
  'Action': 'https://incompetech.com/music/royalty-free/mp3-royaltyfree/Hitman.mp3',
  'Calm': 'https://incompetech.com/music/royalty-free/mp3-royaltyfree/Touching%20Moments%20One%20-%20Pulse.mp3',
  'Mysterious': 'https://incompetech.com/music/royalty-free/mp3-royaltyfree/Dark%20Fog.mp3',
  'Epic': 'https://incompetech.com/music/royalty-free/mp3-royaltyfree/Five%20Armies.mp3',
  'Melancholic': 'https://incompetech.com/music/royalty-free/mp3-royaltyfree/Despair%20and%20Triumph.mp3',
};

const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000';

export default function App() {
  const [prompt, setPrompt] = useState('');
  const [keywords, setKeywords] = useState<string[]>([]);
  const [keywordInput, setKeywordInput] = useState('');
  const [isMuted, setIsMuted] = useState(false);

  const [hasInteracted, setHasInteracted] = useState(false);
  const audioRef = useRef<HTMLAudioElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null); // Added ref for background
  const [generationMode, setGenerationMode] = useState('Storybook');
  const [style, setStyle] = useState('Auto');
  const [aiMode] = useState<'Auto' | 'Fast' | 'Pro'>('Auto');
  const [duration, setDuration] = useState('Short');
  const [stream, setStream] = useState<ContentPart[]>([]);
  const [loading, setLoading] = useState(false);
  const streamEndRef = useRef<HTMLDivElement>(null);

  const [chatHistory, setChatHistory] = useState<ChatRecord[]>([]);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);

  // Synchronized Narration Playback State
  const [narrationBlocks, setNarrationBlocks] = useState<{ index: number; speaker: string; text: string; audio_url: string; music_url?: string }[] | null>(null);
  const [lyriaMusicUrl, setLyriaMusicUrl] = useState<string | null>(null);
  const [isPlayingStory, setIsPlayingStory] = useState(false);
  const [currentBlockIndex, setCurrentBlockIndex] = useState(-1);
  const [wasAmbientMuted, setWasAmbientMuted] = useState(false); // To remember if ambient was on before story started
  const speechAudioRef = useRef<HTMLAudioElement>(null);
  const lyriaAudioRef = useRef<HTMLAudioElement>(null);

  const [openMenuId, setOpenMenuId] = useState<string | null>(null);

  const scrollToBottom = () => {
    streamEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  const [view, setView] = useState<'home' | 'generation'>('home');
  const [deletedChatIds, setDeletedChatIds] = useState<Set<string>>(new Set());

  // States for Continue Chat
  const [currentChatId, setCurrentChatId] = useState<string | null>(null);
  const [continueInput, setContinueInput] = useState('');

  const handleContinue = async () => {
    if (!continueInput.trim() || !currentChatId) return;

    // Stop any existing narration
    stopStory();
    setNarrationBlocks(null);
    setLyriaMusicUrl(null);
    setLoading(true);

    try {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = API_BASE_URL.replace(/^https?:/, protocol) + '/ws/generate';
      const ws = new WebSocket(wsUrl);

      ws.onopen = () => {
        // Send continuation configuration
        ws.send(JSON.stringify({
          chat_id: currentChatId,
          prompt: continueInput,
          mode: generationMode,
          style,
          duration,
          keywords
        }));
        setContinueInput(''); // clear input
      };

      ws.onmessage = (event) => {
        try {
          const part = JSON.parse(event.data) as ContentPart;

          if (part.type === 'music') {
            if (audioRef.current && !isMuted && !isPlayingStory) {
              audioRef.current.src = STYLE_MUSIC[part.content || 'Cinematic'] || audioRef.current.src;
              audioRef.current.play().catch(e => console.error("Scene music error:", e));
            }
            return;
          }

          setStream((prev) => {
            const lastPart = prev[prev.length - 1];
            if (lastPart && lastPart.type === 'text' && part.type === 'text') {
              const newStream = [...prev];
              newStream[newStream.length - 1] = {
                ...lastPart,
                content: (lastPart.content || '') + (part.content || '')
              };
              return newStream;
            }
            return [...prev, part];
          });
        } catch (e) {
          console.error('Error parsing stream chunk. Line was:', event.data, e);
        }
      };

      ws.onerror = (error) => {
        console.error('WebSocket Error:', error);
        setStream((prev) => [...prev, { type: 'error', content: 'Connection to backend failed.' }]);
        setLoading(false);
      };

      ws.onclose = () => {
        setLoading(false);
      };

    } catch (error) {
      setStream((prev) => [...prev, { type: 'error', content: 'Failed to initialize WebSocket.' }]);
      setLoading(false);
    }
  };

  const fetchHistory = async () => {

    try {
      const res = await fetch(`${API_BASE_URL}/history`);
      if (res.ok) {
        const data = await res.json();
        setChatHistory(prev => {
          let apiHistory = data.history || [];

          // Filter out any items we know we've recently deleted locally, 
          // because D1 edge caching might still return them for a few seconds/minutes
          apiHistory = apiHistory.filter((h: ChatRecord) => !deletedChatIds.has(h.id));

          // Keep existing items that haven't appeared in the API yet (because of D1 edge cache propagation delays)
          const apiIds = new Set(apiHistory.map((h: ChatRecord) => h.id));
          const optimisticItems = prev.filter(h => !apiIds.has(h.id) && !deletedChatIds.has(h.id));
          // Merge optimistic items at the top
          return [...optimisticItems, ...apiHistory].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
        });
      }
    } catch (e) {
      console.error("Failed to load history", e);
    }
  };

  const loadHistoryItem = async (chatId: string) => {
    try {
      setLoading(true);
      const res = await fetch(`${API_BASE_URL}/history/${chatId}`);
      if (res.ok) {
        const data = await res.json();
        const chat = data.chat;
        setPrompt(chat.prompt);
        setGenerationMode(chat.mode);
        setStyle(chat.style);
        setCurrentChatId(chat.id); // Set the current chat ID for continuations

        let newStream: ContentPart[] = [];
        if (chat.full_text) {
          newStream.push({ type: 'text', content: chat.full_text });
        }
        if (chat.assets) {
          try {
            const parsedAssets = JSON.parse(chat.assets);
            // Filter out narration_track from visible stream but load it into state
            const narration = parsedAssets.find((a: any) => a.type === 'narration_track');
            if (narration && narration.blocks) {
              setNarrationBlocks(narration.blocks);
              setLyriaMusicUrl(narration.background_music || null);
            } else {
              setNarrationBlocks(null);
              setLyriaMusicUrl(null);
            }
            const visibleAssets = parsedAssets.filter((a: any) => ['image', 'video', 'audio', 'blueprint'].includes(a.type));
            newStream = [...newStream, ...visibleAssets];
          } catch (e) { console.error("Error parsing assets", e); }
        }

        setStream(newStream);
        setView('generation');
        setIsSidebarOpen(false); // auto close sidebar on load
      }
    } catch (e) {
      console.error("Failed to load history item", e);
    } finally {
      setLoading(false);
    }
  };

  const handleShareChat = (e: React.MouseEvent, chatId: string) => {
    e.stopPropagation();
    const url = new URL(window.location.origin);
    url.searchParams.set('chat', chatId);
    navigator.clipboard.writeText(url.toString());
    setOpenMenuId(null);
    alert('Link copied to clipboard!');
  };

  const handleDeleteChat = async (e: React.MouseEvent, chatId: string) => {
    e.stopPropagation();
    if (!window.confirm("Are you sure you want to permanently delete this story?")) return;

    // Add to tombstone list to prevent edge cache repopulation
    setDeletedChatIds(prev => new Set(prev).add(chatId));

    // Optimistic UI update: Remove it immediately before waiting on the slow network
    setChatHistory(prev => prev.filter(c => c.id !== chatId));
    if (openMenuId === chatId) setOpenMenuId(null);
    if (view === 'generation' && stream.length > 0) {
      // Only close the main viewer if the story being read is the one being deleted
      const currentChatId = stream.find(p => p.type === 'history_meta')?.chat?.id;
      if (currentChatId === chatId || !currentChatId) {
        setView('home');
        setStream([]);
      }
    }

    try {
      const res = await fetch(`${API_BASE_URL}/history/${chatId}`, { method: 'DELETE' });
      if (!res.ok) {
        // If it failed on the backend, remove from tombstone and refresh
        setDeletedChatIds(prev => {
          const next = new Set(prev);
          next.delete(chatId);
          return next;
        });
        fetchHistory();
      }
    } catch (err) {
      console.error('Failed to delete chat:', err);
      // Remove from tombstone if network failed
      setDeletedChatIds(prev => {
        const next = new Set(prev);
        next.delete(chatId);
        return next;
      });
      fetchHistory(); // Restore if network error
    }
  };

  useEffect(() => {
    fetchHistory();
  }, [view, deletedChatIds]); // Re-run when tombstones change to filter eagerly

  useEffect(() => {
    scrollToBottom();
  }, [stream]);

  // Force play background video and intercept deep-links
  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);
    const chatId = urlParams.get('chat');
    if (chatId) {
      loadHistoryItem(chatId);
      window.history.replaceState({}, document.title, window.location.pathname);
    }

    let isMounted = true;
    if (videoRef.current) {
      videoRef.current.play().catch(e => {
        if (isMounted && e.name !== 'AbortError') {
          console.error("BG Video failed:", e);
        }
      });
    }
    return () => {
      isMounted = false;
    };
  }, []);

  // Ambient Music Logic
  useEffect(() => {
    const handleInteraction = () => {
      setHasInteracted(true);
      if (audioRef.current && audioRef.current.paused) {
        audioRef.current.play()
          .catch(err => console.error("Playback failed:", err));
      }
    };

    // Listen for any interaction to trigger audio
    window.addEventListener('mousedown', handleInteraction);
    window.addEventListener('keydown', handleInteraction);

    return () => {
      window.removeEventListener('mousedown', handleInteraction);
      window.removeEventListener('keydown', handleInteraction);
    };
  }, []);

  // Update music track when style changes
  useEffect(() => {
    if (audioRef.current) {
      if (style === 'Auto') {
        const styleKeys = Object.keys(STYLE_MUSIC);
        const randomStyle = styleKeys[Math.floor(Math.random() * styleKeys.length)];
        audioRef.current.src = STYLE_MUSIC[randomStyle];
      } else {
        audioRef.current.src = STYLE_MUSIC[style] || STYLE_MUSIC['Cinematic'];
      }
      audioRef.current.load();
      // Only attempt to play if we already have permission from an interaction
      if (!isMuted && hasInteracted) {
        audioRef.current.play().catch(err => console.error("Style music play failed:", err));
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [style]); // intentionally omitted hasInteracted and isMuted so track doesn't switch on click/mute

  const toggleMute = () => {
    if (audioRef.current) {
      if (isMuted) {
        audioRef.current.muted = false;
        audioRef.current.play(); // Ensure it plays when unmuting
      } else {
        audioRef.current.muted = true;
      }
      setIsMuted(!isMuted);
    }
  };

  const handleSurpriseMe = async () => {
    setLoading(true);
    try {
      const response = await fetch(`${API_BASE_URL}/surprise`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ style, ai_mode: aiMode, mode: generationMode }),
      });
      const data = await response.json();
      if (data.prompt) {
        setPrompt(data.prompt);
      }
    } catch (error) {
      console.error('Failed to get surprise prompt', error);
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async () => {
    if (!prompt && keywords.length === 0) return;
    setView('generation');
    setLoading(true);
    setStream([]);
    setNarrationBlocks(null);
    setLyriaMusicUrl(null);
    setIsPlayingStory(false);
    setCurrentBlockIndex(-1);

    try {
      // Determine the WebSocket protocol (ws:// or wss://) based on HTTP or HTTPS
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = API_BASE_URL.replace(/^https?:/, protocol) + '/ws/generate';
      const ws = new WebSocket(wsUrl);

      ws.onopen = () => {
        // Send initial configuration
        ws.send(JSON.stringify({
          prompt,
          mode: generationMode,
          style,
          ai_mode: aiMode,
          duration,
          keywords,
          narration: true
        }));
      };

      ws.onmessage = (event) => {
        try {
          const part = JSON.parse(event.data) as ContentPart;

          if (part.type === 'history_meta' && part.chat) {
            setCurrentChatId(part.chat.id); // Enable continue chat immediately
            setChatHistory(prev => {
              const newHistory = prev.filter(c => c.id !== part.chat!.id);
              return [part.chat!, ...newHistory];
            });
            return; // Don't add to visible stream
          }
          if (part.type === 'music') {
            // Scene-based music switch
            if (audioRef.current && !isMuted && !isPlayingStory) {
              const targetSrc = STYLE_MUSIC[part.content || 'Cinematic'];
              if (targetSrc && (!audioRef.current.src || !audioRef.current.src.endsWith(targetSrc))) {
                audioRef.current.src = targetSrc;
                audioRef.current.play().catch(e => console.error("Scene music error:", e));
              }
            }
            return; // Don't add to visible stream
          }
          if (part.type === 'narration_track') {
            if (part.blocks) {
              setNarrationBlocks(part.blocks);
              setLyriaMusicUrl(part.background_music || null);
            }
            return; // Handled specially by the "Play Story" button
          }
          // Visible streaming
          setStream((prev) => {
            const lastPart = prev[prev.length - 1];
            if (lastPart && lastPart.type === 'text' && part.type === 'text') {
              const newStream = [...prev];
              newStream[newStream.length - 1] = {
                ...lastPart,
                content: (lastPart.content || '') + (part.content || '')
              };
              return newStream;
            }
            return [...prev, part];
          });
        } catch (e) {
          console.error('Error parsing stream chunk. Line was:', event.data, e);
        }
      };

      ws.onerror = (error) => {
        console.error('WebSocket Error:', error);
        setStream((prev) => [...prev, { type: 'error', content: 'Connection to backend failed.' }]);
        setLoading(false);
      };

      ws.onclose = () => {
        setLoading(false);
        fetchHistory(); // Refresh history list after new generation completes
      };

      // Cleanup mechanism if component unmounts - not strictly necessary here 
      // as handleSubmit scope isn't tied to unmount, but good practice if we stored `ws` in state.

    } catch (error) {
      setStream((prev) => [...prev, { type: 'error', content: 'Failed to initialize WebSocket.' }]);
      setLoading(false);
      fetchHistory();
    }
  };

  const playNextBlock = () => {
    if (!narrationBlocks) return;

    const nextIndex = currentBlockIndex + 1;
    if (nextIndex < narrationBlocks.length) {
      setCurrentBlockIndex(nextIndex);
      const nextBlock = narrationBlocks[nextIndex];

      if (speechAudioRef.current) {
        speechAudioRef.current.src = nextBlock.audio_url;
        speechAudioRef.current.play().catch(e => console.error("Speech play error:", e));

        // --- Dynamic Scene Soundtrack Swap ---
        if (nextBlock.music_url && lyriaAudioRef.current) {
          if (lyriaAudioRef.current.src !== nextBlock.music_url) {
            lyriaAudioRef.current.src = nextBlock.music_url;
            lyriaAudioRef.current.volume = 0.15; // Ensure it stays quiet during swap
            lyriaAudioRef.current.play().catch(e => console.error("Dynamic scene music play failed:", e));
          }
        }
      }
    } else {
      // Story finished
      stopStory();
    }
  };

  const startStory = () => {
    setIsPlayingStory(true);
    setCurrentBlockIndex(0);
    setWasAmbientMuted(isMuted);

    // Audio Ducking: Keep ambient playing, but quiet it down significantly
    if (audioRef.current && !isMuted) {
      audioRef.current.volume = 0.15;
    }

    // Play Lyria track if available, also very quiet
    if (lyriaAudioRef.current && lyriaMusicUrl) {
      lyriaAudioRef.current.volume = 0.15; // Keep it quiet behind speech
      lyriaAudioRef.current.play().catch(e => console.error("Lyria music err:", e));
    }

    // Start first block
    if (narrationBlocks && narrationBlocks.length > 0 && speechAudioRef.current) {
      speechAudioRef.current.src = narrationBlocks[0].audio_url;
      speechAudioRef.current.volume = 1.0; // Ensure speech is at full volume
      speechAudioRef.current.play().catch(e => console.error("Speech play err:", e));
    }
  };

  const stopStory = () => {
    setIsPlayingStory(false);
    setCurrentBlockIndex(-1);

    // Stop Lyria and reset volume
    if (lyriaAudioRef.current) {
      lyriaAudioRef.current.pause();
      lyriaAudioRef.current.currentTime = 0;
      lyriaAudioRef.current.volume = 1.0;
    }

    // Stop Speech
    if (speechAudioRef.current) {
      speechAudioRef.current.pause();
    }

    // Resume Ambient to full volume if it wasn't muted before
    if (audioRef.current) {
      audioRef.current.volume = 1.0;
      if (!wasAmbientMuted) {
        audioRef.current.play().catch(e => console.error("Resume ambient err:", e));
      }
    }
  };

  return (
    <>
      {/* Cinematic Studio Background Video */}
      <video
        ref={videoRef}
        autoPlay
        loop
        muted
        playsInline
        className="background-video"
      >
        <source src="/Loop Video.mp4" type="video/mp4" />
      </video>
      <div className="background-overlay"></div>

      <div className="app-layout">
        {chatHistory.length > 0 && (
          <aside className={`sidebar ${isSidebarOpen ? 'open' : 'closed'}`}>
            <div className="sidebar-header">
              <h2>📜 History</h2>
            </div>
            <div className="sidebar-content">
              {chatHistory.map((chat) => (
                <div
                  key={chat.id}
                  className="history-card"
                  onClick={() => loadHistoryItem(chat.id)}
                  style={{ cursor: 'pointer' }}
                  onMouseLeave={() => setOpenMenuId(null)}
                >
                  <button
                    className={`history-menu-btn ${openMenuId === chat.id ? 'active' : ''}`}
                    onClick={(e) => { e.stopPropagation(); setOpenMenuId(openMenuId === chat.id ? null : chat.id); }}
                    title="Options"
                  >
                    ⋮
                  </button>
                  {openMenuId === chat.id && (
                    <div className="history-dropdown">
                      <button className="history-dropdown-item" onClick={(e) => handleShareChat(e, chat.id)}>
                        🔗 Share Link
                      </button>
                      <button className="history-dropdown-item delete" onClick={(e) => handleDeleteChat(e, chat.id)}>
                        🗑️ Delete
                      </button>
                    </div>
                  )}
                  <div className="history-meta">
                    <span className="history-mode">{chat.mode}</span>
                    <span className="history-date">{new Date(chat.created_at).toLocaleDateString()}</span>
                  </div>
                  <p className="history-prompt">{chat.prompt}</p>
                </div>
              ))}
            </div>
          </aside>
        )}

        <div className="main-scroll-area">
          {chatHistory.length > 0 && (
            <button
              className={`hamburger-btn ${isSidebarOpen ? 'sidebar-is-open' : ''}`}
              onClick={() => setIsSidebarOpen(!isSidebarOpen)}
              title="Toggle History"
            >
              ☰
            </button>
          )}
          <div className="container">
            <div className="header">
              {view === 'generation' ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
                  <button
                    className="back-button"
                    onClick={() => {
                      setView('home');
                      setStream([]);
                    }}
                  >
                    ← New Story
                  </button>
                  <div style={{ flex: 1 }}></div>
                  <div style={{ position: 'relative' }}>
                    <button
                      className={`music-toggle ${isMuted ? 'muted' : ''}`}
                      onClick={toggleMute}
                      title={isMuted ? "Unmute Atmosphere" : "Mute Atmosphere"}
                    >
                      {isMuted ? '🔇' : '🎵'}
                      <span>{isMuted ? 'Muted' : 'Ambient On'}</span>
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <div style={{ position: 'absolute', top: '1.5rem', right: '1.5rem' }}>
                    <button
                      className={`music-toggle ${isMuted ? 'muted' : ''}`}
                      onClick={toggleMute}
                      title={isMuted ? "Unmute Atmosphere" : "Mute Atmosphere"}
                    >
                      {isMuted ? '🔇' : '🎵'}
                      <span>{isMuted ? 'Muted' : 'Ambient On'}</span>
                    </button>
                  </div>
                  <h1>TaleForge</h1>
                  <p>Advanced Multimodal Narrative Studio</p>
                </>
              )}
              <audio
                ref={audioRef}
                loop
                autoPlay
                muted={isMuted}
                src={STYLE_MUSIC[style] || STYLE_MUSIC['Cinematic']}
                style={{ display: 'none' }}
              />
              {/* Hidden audio engines for synced playback */}
              <audio ref={speechAudioRef} onEnded={playNextBlock} style={{ display: 'none' }} />
              <audio ref={lyriaAudioRef} src={lyriaMusicUrl || ''} loop style={{ display: 'none' }} />
            </div>

            {view === 'home' && (
              <div className="input-section">
                <textarea
                  placeholder={
                    generationMode === 'Marketing Campaign' ? 'Describe your product/campaign... (e.g., A new organic energy drink called Volt)' :
                      generationMode === 'Educational Explainer' ? 'What topic should we explain? (e.g., How quantum computing works)' :
                        generationMode === 'Pitch Deck' ? 'What are you pitching? (e.g., A B2B SaaS for AI email management)' :
                          generationMode === 'Workflow Planning' ? 'What process are we planning? (e.g., User onboarding flow)' :
                            generationMode === 'Social Media Post' ? 'What is the subject of your post? (e.g., A behind-the-scenes look at our cafe)' :
                              'What\'s your story idea? (Or leave blank and just use keywords!)'
                  }
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  className="base-input prompt-textarea"
                />

                <div className="keyword-section">
                  <input
                    type="text"
                    placeholder="Add keywords (press Enter)..."
                    value={keywordInput}
                    onChange={(e) => setKeywordInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && keywordInput.trim()) {
                        if (!keywords.includes(keywordInput.trim())) {
                          setKeywords([...keywords, keywordInput.trim()]);
                        }
                        setKeywordInput('');
                        e.preventDefault();
                      }
                    }}
                  />
                  <div className="chips">
                    {keywords.map((k, i) => (
                      <span key={i} className="chip">
                        {k}
                        <button
                          onClick={() => setKeywords(keywords.filter((_, idx) => idx !== i))}
                          className="chip-remove"
                        >
                          ×
                        </button>
                      </span>
                    ))}
                  </div>
                </div>

                <div style={{ display: 'flex', gap: '1rem', alignItems: 'center', flexWrap: 'wrap', marginTop: '1rem' }}>
                  <select
                    value={generationMode}
                    onChange={(e) => setGenerationMode(e.target.value)}
                    style={{ padding: '0.75rem', borderRadius: '0.5rem', background: '#334155', color: 'white', fontWeight: 'bold' }}
                  >
                    <option value="Storybook">📖 Storybook</option>
                    <option value="Marketing Campaign">📈 Marketing Campaign</option>
                    <option value="Educational Explainer">🎓 Educational Explainer</option>
                    <option value="Pitch Deck">📊 Pitch Deck</option>
                    <option value="Workflow Planning">⚙️ Workflow Planning</option>
                    <option value="Social Media Post">📱 Social Media Post</option>
                  </select>
                  {generationMode === 'Storybook' && (
                    <select
                      value={style}
                      onChange={(e) => setStyle(e.target.value)}
                      style={{ padding: '0.75rem', borderRadius: '0.5rem', background: '#334155', color: 'white' }}
                    >
                      <option value="Auto">✨ Auto Detect (AI Chosen)</option>
                      <option value="Cinematic">🎬 Cinematic</option>
                      <option value="Epic Fantasy">⚔️ Epic Fantasy</option>
                      <option value="Sci-Fi Noir">🌌 Sci-Fi Noir</option>
                      <option value="Political Drama">⚖️ Political Drama</option>
                      <option value="Space Opera">🚀 Space Opera</option>
                      <option value="Mystery">🔍 Mystery</option>
                      <option value="Comedy">🎭 Comedy</option>
                      <option value="Thriller">🔪 Thriller</option>
                    </select>
                  )}
                  {generationMode === 'Storybook' && (
                    <select
                      value={duration}
                      onChange={(e) => setDuration(e.target.value)}
                      style={{ padding: '0.75rem', borderRadius: '0.5rem', background: '#334155', color: 'white' }}
                    >
                      <option value="Short">Short (5 mins / ~2p)</option>
                      <option value="Medium">Medium (~30 pages)</option>
                      <option value="Large">Large (~100 pages)</option>
                    </select>
                  )}
                  <button
                    onClick={handleSurpriseMe}
                    disabled={loading}
                    style={{ background: '#4b5563', borderColor: '#4b5563' }}
                  >
                    Surprise Me
                  </button>
                  <button onClick={handleSubmit} disabled={loading}>
                    {loading ? 'Forging...' : 'Forge Content'}
                  </button>
                </div>
              </div>
            )}

            {view === 'generation' && (
              <div className="output-section">
                {stream.length > 0 && (
                  <div className="output-header" style={{ display: 'flex', gap: '1rem', alignItems: 'center', marginBottom: '1rem' }}>

                    {narrationBlocks && (
                      <button
                        className="play-story-btn"
                        onClick={isPlayingStory ? stopStory : startStory}
                        style={{
                          background: isPlayingStory ? '#ef4444' : '#4f46e5',
                          color: 'white',
                          padding: '0.6rem 1.2rem',
                          borderRadius: '999px',
                          border: 'none',
                          fontWeight: 'bold',
                          display: 'flex',
                          alignItems: 'center',
                          gap: '0.5rem',
                          boxShadow: 'var(--shadow-md)'
                        }}
                      >
                        {isPlayingStory ? 'Stop' : 'Listen Story'}
                      </button>
                    )}
                  </div>
                )}

                {/* Once we have narrationBlocks, we hide the raw text stream and render the blocks to support highlighting */}
                <div className="content-container">
                  {narrationBlocks && !loading ? (
                    <div className="synced-text-container text-part">
                      {narrationBlocks.map((block) => {
                        let cleanText = block.text;
                        // Fallback frontend strip for narration playback text as well
                        cleanText = cleanText.replace(/\[IMAGE_PROMPT:.*?\]/gis, '')
                          .replace(/\[VIDEO_PROMPT:.*?\]/gis, '')
                          .replace(/\[MUSIC_STYLE:.*?\]/gis, '')
                          .replace(/\[MIRO_DIAGRAM\].*?\[\/MIRO_DIAGRAM\]/gis, '')
                          .replace(/\[MIRO_DIAGRAM\].*?$/gis, '');
                        return (
                          <p
                            key={block.index}
                            className={`story-block ${currentBlockIndex === block.index ? 'highlighted' : (isPlayingStory && currentBlockIndex > block.index) ? 'read' : ''}`}
                            style={{ marginBottom: '1rem' }}
                          >
                            {cleanText}
                          </p>
                        );
                      })}
                    </div>
                  ) : (
                    (() => {
                      const merged: any[] = [];
                      let currentText = "";

                      const invisibleTypes = ['history_meta', 'music', 'narration_track'];

                      stream.forEach((part, index) => {
                        if (part.type === 'text') {
                          currentText += part.content;
                        } else if (invisibleTypes.includes(part.type)) {
                          merged.push({ ...part, key: `part-${index}` });
                        } else {
                          if (currentText) {
                            merged.push({ type: 'text', content: currentText, key: `text-${index}` });
                            currentText = "";
                          }
                          merged.push({ ...part, key: `part-${index}` });
                        }
                      });
                      if (currentText) {
                        merged.push({ type: 'text', content: currentText, key: 'text-end' });
                      }

                      return (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '2rem' }}>
                          {merged
                            .filter(p => !invisibleTypes.includes(p.type))
                            .map((part) => {
                              let cleanContent = part.content;
                              if (part.type === 'text' && typeof cleanContent === 'string') {
                                // Fallback frontend strip: hide any leaked systemic instructions or prompts
                                cleanContent = cleanContent.replace(/\[IMAGE_PROMPT:.*?\]/gis, '')
                                  .replace(/\[VIDEO_PROMPT:.*?\]/gis, '')
                                  .replace(/\[MUSIC_STYLE:.*?\]/gis, '')
                                  .replace(/\[MIRO_DIAGRAM\].*?\[\/MIRO_DIAGRAM\]/gis, '')
                                  .replace(/\[MIRO_DIAGRAM\].*?$/gis, ''); // Catch trailing unfinished ones
                              }

                              return (
                                <div key={part.key} className={`content-part ${part.type}-part`}>
                                  {part.type === 'text' && <div className="markdown-prose"><ReactMarkdown>{cleanContent}</ReactMarkdown></div>}
                                  {part.type === 'image' && <img src={part.content} alt="Generated scene" />}
                                  {part.type === 'audio' && <audio controls autoPlay className="audio-part" src={part.content} />}
                                  {part.type === 'video' && <div className="video-part"><video controls autoPlay src={part.content} /></div>}
                                  {part.type === 'blueprint' && (
                                    <div className="blueprint-part" style={{ marginTop: '2rem', marginBottom: '2rem', height: '600px', width: '100%', borderRadius: '1rem', overflow: 'hidden', border: '1px solid var(--glass-border)' }}>
                                      <div style={{ padding: '0.75rem 1rem', background: '#1e293b', borderBottom: '1px solid #3b82f6', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                                        <span>🗺️ <strong>Interactive Miro Diagram</strong></span>
                                        <a href={part.content?.replace('live-embed', 'board').split('?')[0] || '#'} target="_blank" rel="noreferrer" style={{ fontSize: '0.85rem', color: '#94a3b8', textDecoration: 'underline' }}>Open Fullscreen</a>
                                      </div>
                                      <iframe
                                        src={part.content}
                                        style={{ width: '100%', height: 'calc(100% - 45px)', border: 'none' }}
                                        allowFullScreen
                                        allow="fullscreen; clipboard-read; clipboard-write"
                                      />
                                    </div>
                                  )}
                                  {part.type === 'info' && <div className="info-part">✨ {part.content}</div>}
                                  {part.type === 'error' && <div style={{ color: '#ef4444' }}>{part.content}</div>}
                                </div>
                              );
                            })}
                        </div>
                      );
                    })()
                  )}

                  {/* Always render media generated (images/video/blueprints) at bottom if we hid the stream for synced text */}
                  {narrationBlocks && !loading && stream.filter(p => !['text', 'info', 'error', 'music'].includes(p.type)).map((part, idx) => (
                    <div key={`media-${idx}`} className={`content-part ${part.type}-part`}>
                      {part.type === 'image' && <img src={part.content} alt="Generated scene" />}
                      {part.type === 'video' && <div className="video-part"><video controls autoPlay={!isPlayingStory} src={part.content} /></div>}
                      {part.type === 'blueprint' && (
                        <div className="blueprint-part" style={{ marginTop: '2rem', marginBottom: '2rem', height: '600px', width: '100%', borderRadius: '1rem', overflow: 'hidden', border: '1px solid var(--glass-border)' }}>
                          <div style={{ padding: '0.75rem 1rem', background: '#1e293b', borderBottom: '1px solid #3b82f6', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                            <span>🗺️ <strong>Interactive Miro Diagram</strong></span>
                            <a href={part.content?.replace('live-embed', 'board').split('?')[0] || '#'} target="_blank" rel="noreferrer" style={{ fontSize: '0.85rem', color: '#94a3b8', textDecoration: 'underline' }}>Open Fullscreen</a>
                          </div>
                          <iframe
                            src={part.content}
                            style={{ width: '100%', height: 'calc(100% - 45px)', border: 'none' }}
                            allowFullScreen
                            allow="fullscreen; clipboard-read; clipboard-write"
                          />
                        </div>
                      )}
                    </div>
                  ))}
                </div>

                {loading && <div className="loading-indicator">Forging your vision...</div>}
                <div ref={streamEndRef} />

                {/* Continue Chat Section */}
                {currentChatId && !loading && (
                  <div className="continue-section" style={{ marginTop: '2rem', padding: '1.5rem', background: 'rgba(30, 41, 59, 0.7)', borderRadius: '1rem', border: '1px solid var(--glass-border)' }}>
                    <h3 style={{ marginTop: 0, marginBottom: '1rem', color: '#f8fafc' }}>Continue the Tale...</h3>
                    <textarea
                      style={{ width: '100%', padding: '1rem', borderRadius: '0.5rem', background: 'rgba(15, 23, 42, 0.8)', color: 'white', border: '1px solid #475569', minHeight: '80px', marginBottom: '1rem' }}
                      placeholder="What happens next? Or what detail should we zoom in on?"
                      value={continueInput}
                      onChange={(e) => setContinueInput(e.target.value)}
                    />
                    <button
                      onClick={handleContinue}
                      disabled={!continueInput.trim()}
                      style={{ background: continueInput.trim() ? '#3b82f6' : '#475569' }}
                    >
                      Forge Continuation
                    </button>
                  </div>
                )}
                <footer className="app-footer">
                  <div className="footer-content">
                    <div className="footer-brand">
                      <h3>TaleForge</h3>
                      <p>Powered by Google Genesis-Stack & Vertex AI</p>
                    </div>
                    <div className="footer-links">
                      <span>v2.0.4-beta</span>
                      <span>•</span>
                      <span>System Status: <span className="status-indicator">Online</span></span>
                      <span>•</span>
                      <a href="https://github.com/SHADOW-0602/TaleForge" target="_blank" rel="noopener noreferrer">Documentation</a>
                    </div>
                    <div className="footer-credit">
                      Built with ❤️ by the SHADOW
                    </div>
                  </div>
                </footer>
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
