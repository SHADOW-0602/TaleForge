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
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);

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

  const [view, setView] = useState<'home' | 'generation' | 'library' | 'privacy' | 'terms'>('home');
  const [deletedChatIds, setDeletedChatIds] = useState<Set<string>>(new Set());

  // Progress Persistence Helpers
  const saveStoryProgress = (chatId: string, progress: number) => {
    if (!chatId) return;
    const storageKey = `taleforge_progress_${chatId}`;
    const existing = localStorage.getItem(storageKey);
    // Only update if progress is further than before
    if (!existing || progress > parseInt(existing)) {
      localStorage.setItem(storageKey, progress.toString());
    }
  };

  const getStoryProgress = (chatId: string): number => {
    const progress = localStorage.getItem(`taleforge_progress_${chatId}`);
    return progress ? parseInt(progress) : 0;
  };

  // States for Continue Chat
  const [currentChatId, setCurrentChatId] = useState<string | null>(null);
  const [continueInput, setContinueInput] = useState('');

  const hasVisuals = stream.some(p => ['image', 'video', 'blueprint'].includes(p.type));

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
          keywords,
          narration: true
        }));
        setContinueInput(''); // clear input
      };

      ws.onmessage = (event) => {
        try {
          const part = JSON.parse(event.data) as ContentPart;

          if (part.type === 'music') {
            if (audioRef.current && !isMuted && !isPlayingStory) {
              audioRef.current.play().catch(e => {
                if (e.name !== 'AbortError') console.error("Scene music error:", e);
              });
            }
            return;
          }

          if (part.type === 'narration_track') {
            if (part.blocks) {
              setNarrationBlocks(part.blocks);
              setLyriaMusicUrl(part.background_music || null);
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
          .catch(err => {
            if (err.name !== 'AbortError') console.error("Playback failed:", err);
          });
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

  const [voiceVolume, setVoiceVolume] = useState(0.8);
  const [ambientVolume, setAmbientVolume] = useState(0.4);

  // Sync volumes when state changes
  useEffect(() => {
    if (audioRef.current) audioRef.current.volume = isMuted ? 0 : ambientVolume;
    if (speechAudioRef.current) speechAudioRef.current.volume = isMuted ? 0 : voiceVolume;
    if (lyriaAudioRef.current) lyriaAudioRef.current.volume = isMuted ? 0 : ambientVolume;
  }, [voiceVolume, ambientVolume, isMuted]);

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
        const playPromise = audioRef.current.play();
        if (playPromise !== undefined) {
          playPromise.catch(err => {
            if (err.name !== 'AbortError') {
              console.error("Style music play failed:", err);
            }
          });
        }
      }
    }
  }, [style, hasInteracted, isMuted]); // Added dependencies to handle play after interaction

  const toggleMute = () => {
    if (audioRef.current) {
      if (isMuted) {
        audioRef.current.muted = false;
        audioRef.current.play().catch(e => {
          if (e.name !== 'AbortError') console.error("Unmute play failed:", e);
        }); // Ensure it plays when unmuting
      } else {
        audioRef.current.muted = true;
      }
      setIsMuted(!isMuted);
    }
  };

  // Sync side-pane video playback with story narration state
  useEffect(() => {
    const sideVideos = document.querySelectorAll('.video-part video');
    sideVideos.forEach((v: any) => {
      if (isPlayingStory) {
        v.play().catch((e: any) => {
          if (e.name !== 'AbortError') console.error("Side video sync play failed:", e);
        });
      } else {
        v.pause();
      }
    });
  }, [isPlayingStory]);

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
                audioRef.current.play().catch(e => {
                  if (e.name !== 'AbortError') console.error("Scene music error:", e);
                });
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
      
      // Save progress
      if (currentChatId) {
        const progress = Math.round(((nextIndex + 1) / narrationBlocks.length) * 100);
        saveStoryProgress(currentChatId, progress);
      }

      if (speechAudioRef.current) {
        speechAudioRef.current.src = nextBlock.audio_url;
        speechAudioRef.current.play().catch(e => {
          if (e.name !== 'AbortError') console.error(`Speech play error [${nextBlock.audio_url}]:`, e);
        });

        // --- Dynamic Scene Soundtrack Swap ---
        if (nextBlock.music_url && lyriaAudioRef.current) {
          if (lyriaAudioRef.current.src !== nextBlock.music_url) {
            lyriaAudioRef.current.src = nextBlock.music_url;
            lyriaAudioRef.current.volume = 0.15; // Ensure it stays quiet during swap
            lyriaAudioRef.current.play().catch(e => {
              if (e.name !== 'AbortError') console.error("Dynamic scene music play failed:", e);
            });
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
      lyriaAudioRef.current.play().catch(e => {
        if (e.name !== 'AbortError') console.error("Lyria music err:", e);
      });
    }

    // Start first block
    if (narrationBlocks && narrationBlocks.length > 0 && speechAudioRef.current) {
      // Save initial progress
      if (currentChatId) {
        const progress = Math.round((1 / narrationBlocks.length) * 100);
        saveStoryProgress(currentChatId, progress);
      }
      speechAudioRef.current.src = narrationBlocks[0].audio_url;
      speechAudioRef.current.volume = voiceVolume; // Use user defined volume
      speechAudioRef.current.play().catch(e => {
        if (e.name !== 'AbortError') console.error(`Speech play err [${narrationBlocks[0].audio_url}]:`, e);
      });
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
        audioRef.current.play().catch(e => {
          if (e.name !== 'AbortError') console.error("Resume ambient err:", e);
        });
      }
    }
  };

  const resetCreationState = () => {
    setPrompt('');
    setKeywords([]);
    setKeywordInput('');
    setCurrentChatId(null);
    setStream([]);
    setNarrationBlocks(null);
    setLyriaMusicUrl(null);
    setIsPlayingStory(false);
    setCurrentBlockIndex(-1);
    setIsSidebarOpen(false);
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
        <source src="/LoopVideo.mp4" type="video/mp4" />
      </video>
      <div className="background-overlay"></div>

      <div className="app-layout">
        {/* Togglable Left Sidebar Navigation */}
        <aside className={`sidebar ${!isSidebarOpen ? 'collapsed' : ''}`}>
          <div className="sidebar-header">
            <h2>TaleForge</h2>
          </div>

          <nav className="sidebar-nav">
            <div className="nav-section-label">Story Lab</div>
            <div 
              className={`nav-item ${view === 'home' ? 'active' : ''}`}
              onClick={() => { resetCreationState(); setView('home'); }}
            >
              📖 Create New
            </div>
            <div 
              className={`nav-item ${view === 'library' ? 'active' : ''}`}
              onClick={() => { setView('library'); }}
            >
              📚 Library
            </div>

            <div className="nav-section-label">Visual Styles</div>
            <div className="style-list">
              {[
                { name: 'Realistic', icon: '📸', img: 'https://picsum.photos/seed/realistic/400/250' },
                { name: 'Cinematic', icon: '🎬', img: 'https://picsum.photos/seed/cinematic/400/250' },
                { name: 'Ghibli', icon: '🎨', img: 'https://picsum.photos/seed/ghibli/400/250' },
                { name: 'Noir', icon: '🕵️', img: 'https://picsum.photos/seed/noir/400/250' },
                { name: 'Vaporwave', icon: '🌈', img: 'https://picsum.photos/seed/vaporwave/400/250' },
                { name: 'Concept Art', icon: '🖼️', img: 'https://picsum.photos/seed/art/400/250' },
              ].map(s => (
                <div 
                  key={s.name} 
                  className={`style-item ${style === s.name ? 'active' : ''}`}
                  onClick={() => setStyle(s.name)}
                >
                  <img src={s.img} alt={s.name} />
                  <span>{s.icon} {s.name}</span>
                </div>
              ))}
            </div>
          </nav>

          <div className="sidebar-footer">
            <button 
              className={`music-toggle ${isMuted ? 'muted' : ''}`}
              onClick={toggleMute}
            >
              {isMuted ? '🔇' : '🎵'} {isMuted ? 'Muted' : 'Ambient On'}
            </button>
          </div>
        </aside>

        <div className="main-scroll-area">
          <button
            className={`hamburger-btn ${isSidebarOpen ? 'sidebar-is-open' : ''}`}
            onClick={() => setIsSidebarOpen(!isSidebarOpen)}
            title="Toggle Sidebar"
          >
            ☰
          </button>
          <div className={`container ${(view === 'library' || view === 'privacy' || view === 'terms') ? 'view-wide' : ''}`}>
            <div className="header">
              {view === 'generation' ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
                  <button
                    className="back-button"
                    onClick={() => {
                      setView('library');
                      setStream([]);
                    }}
                  >
                    ← Library
                  </button>
                  <div style={{ flex: 1 }}></div>
                </div>
              ) : (
                <>
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

            {view === 'library' && (
              <div className="library-section">
                <h1>Story Library</h1>
                <p>Your collection of forged narratives.</p>
                <div className="gallery-grid">
                  {chatHistory.length === 0 ? (
                    <div className="no-history">Your library is empty. Start forging!</div>
                  ) : (
                    chatHistory.map((chat) => {
                      const progress = getStoryProgress(chat.id);
                      return (
                        <div key={chat.id} className="story-card" onClick={() => loadHistoryItem(chat.id)}>
                          <img 
                            src={`https://picsum.photos/seed/${chat.id}/400/250`} 
                            alt={chat.prompt.substring(0, 50) + '...'} 
                          />
                          <div className="card-overlay">
                            <div className="card-meta">
                              <span>{chat.mode}</span>
                              <span>{new Date(chat.created_at).toLocaleDateString()}</span>
                            </div>
                            <h3 className="card-title">{chat.prompt}</h3>
                            <div className="card-footer">
                              <span>{progress === 100 ? 'Forged' : progress > 0 ? `${progress}% Complete` : 'New Story'}</span>
                              <div style={{ display: 'flex', gap: '0.5rem' }}>
                                <button 
                                  onClick={(e) => handleShareChat(e, chat.id)}
                                  style={{ padding: '0.25rem', background: 'transparent', boxShadow: 'none' }}
                                  title="Share"
                                >
                                  🔗
                                </button>
                                <button 
                                  onClick={(e) => handleDeleteChat(e, chat.id)}
                                  style={{ padding: '0.25rem', background: 'transparent', boxShadow: 'none', color: '#ef4444' }}
                                  title="Delete"
                                >
                                  🗑️
                                </button>
                              </div>
                            </div>
                          </div>
                          <div className="card-progress-container">
                            <div className="card-progress-fill" style={{ width: `${progress}%` }}></div>
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
            )}

            {view === 'privacy' && (
              <div className="legal-section markdown-prose">
                <h1>Privacy Policy</h1>
                <p>Last Updated: March 2024</p>
                <p>At TaleForge, we respect your privacy and are committed to protecting your personal data.</p>
                <h2>1. Data Collection</h2>
                <p>We collect information you provide directly, such as story prompts and account details. We also collect automated data through cookies to improve our AI generation performance.</p>
                <h2>2. AI Processing</h2>
                <p>Your story prompts are processed by our AI models (Gemini, Vertex AI). While we use these to generate content, we do not sell your personal prompts to third parties.</p>
                <button className="back-button" onClick={() => setView('home')}>Back to Home</button>
              </div>
            )}

            {view === 'terms' && (
              <div className="legal-section markdown-prose">
                <h1>Terms of Service</h1>
                <p>Last Updated: March 2024</p>
                <p>By using TaleForge, you agree to these terms.</p>
                <h2>1. Use of Service</h2>
                <p>You agree to use TaleForge only for lawful purposes. You are responsible for the content you generate and must ensure it does not infringe on any third-party rights.</p>
                <h2>2. Intellectual Property</h2>
                <p>Content generated by our AI is subject to the terms of the underlying models. Generally, you own the creative output, but TaleForge retains the right to use generated assets for platform improvement.</p>
                <button className="back-button" onClick={() => setView('home')}>Back to Home</button>
              </div>
            )}

            {view === 'home' && (
              <div className="forge-section">
                <h1>Forge New Story</h1>
                <p>Unleash your imagination into the digital canvas.</p>
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

                  <div style={{ display: 'flex', gap: '1rem', alignItems: 'center', flexWrap: 'wrap', marginTop: '1.5rem' }}>
                    <div className="select-wrapper">
                      <label>Objective</label>
                      <select
                        value={generationMode}
                        onChange={(e) => setGenerationMode(e.target.value)}
                      >
                        <option value="Storybook">📖 Storybook</option>
                        <option value="Marketing Campaign">📈 Marketing Campaign</option>
                        <option value="Educational Explainer">🎓 Educational Explainer</option>
                        <option value="Pitch Deck">📊 Pitch Deck</option>
                        <option value="Workflow Planning">⚙️ Workflow Planning</option>
                        <option value="Social Media Post">📱 Social Media Post</option>
                        <option value="Presentation">📊 AI Presentation</option>
                      </select>
                    </div>

                    <div className="select-wrapper">
                      <label>Complexity</label>
                      <select
                        value={duration}
                        onChange={(e) => setDuration(e.target.value)}
                      >
                        <option value="Short">Short (Fast)</option>
                        <option value="Medium">Medium (Balanced)</option>
                        <option value="Large">Large (Detailed)</option>
                      </select>
                    </div>

                    <div style={{ flex: 1 }}></div>

                    <button
                      className="surprise-btn"
                      onClick={handleSurpriseMe}
                      disabled={loading}
                    >
                      ✨ Surprise Me
                    </button>
                    <button className="primary-forge-btn" onClick={handleSubmit} disabled={loading}>
                    {loading ? 'Forging...' : 'Forge Content'}
                    </button>
                  </div>
                </div>
              </div>
            )}

            {view === 'generation' && (
              <div className="viewing-container">
                <div className={`generation-view-layout ${!hasVisuals ? 'no-media' : ''}`}>
                  {/* Left Pane: Reading */}
                  <div className="generation-reading-pane">
                    {narrationBlocks && !loading ? (
                      <div className="synced-text-container text-part">
                        {narrationBlocks.map((block) => {
                          let cleanText = block.text;
                          cleanText = cleanText.replace(/\[IMAGE_PROMPT:.*?\]/gis, '')
                            .replace(/\[VIDEO_PROMPT:.*?\]/gis, '')
                            .replace(/\[MUSIC_STYLE:.*?\]/gis, '')
                            .replace(/\[MIRO_DIAGRAM\].*?\[\/MIRO_DIAGRAM\]/gis, '')
                            .replace(/\[MIRO_DIAGRAM\].*?$/gis, '');
                          return (
                            <p
                              key={block.index}
                              className={`story-block ${currentBlockIndex === block.index ? 'highlighted' : (isPlayingStory && currentBlockIndex > block.index) ? 'read' : ''}`}
                            >
                              {cleanText}
                            </p>
                          );
                        })}
                      </div>
                    ) : (
                      <div className="raw-stream text-part">
                        <ReactMarkdown>
                          {stream
                            .filter(p => p.type === 'text')
                            .map(p => p.content)
                            .join('')
                            .replace(/\[IMAGE_PROMPT:.*?\]/gis, '')
                            .replace(/\[VIDEO_PROMPT:.*?\]/gis, '')
                            .replace(/\[MUSIC_STYLE:.*?\]/gis, '')
                            .replace(/\[MIRO_DIAGRAM\].*?\[\/MIRO_DIAGRAM\]/gis, '')
                            .replace(/\[MIRO_DIAGRAM\].*?$/gis, '')}
                        </ReactMarkdown>
                      </div>
                    )}

                    {loading && <div className="loading-indicator">Forging your vision...</div>}
                    
                    {/* Info Messages from Backend */}
                    {stream
                      .filter(p => p.type === 'info')
                      .map((p, idx) => (
                        <div key={idx} className="info-message-stream" style={{ color: 'var(--primary)', fontStyle: 'italic', marginBottom: '1rem', fontSize: '0.9rem' }}>
                          ✨ {p.content}
                        </div>
                      ))}

                    <div ref={streamEndRef} />

                    {/* Continuation Section */}
                    {currentChatId && !loading && (
                      <div className="continue-section">
                        <h3>Deepen the Narrative...</h3>
                        <textarea
                          placeholder="What detail should we explore next?"
                          value={continueInput}
                          onChange={(e) => setContinueInput(e.target.value)}
                        />
                        <button onClick={handleContinue} disabled={!continueInput.trim()}>
                          Forge Continuation
                        </button>
                      </div>
                    )}
                  </div>

                  {/* Right Pane: Media / Visuals - Only show if visuals exist */}
                  {hasVisuals && (
                    <div className="generation-media-pane">
                      <div className="image-grid">
                        {stream
                          .filter(p => p.type === 'image')
                          .map((p, idx) => (
                            <img key={idx} src={p.content} alt={`Scene ${idx + 1}`} />
                          ))}
                      </div>
                      {stream
                        .filter(p => p.type === 'video')
                        .map((p, idx) => (
                          <div key={idx} className="video-part">
                            <video src={p.content} loop autoPlay playsInline />
                          </div>
                        ))}
                      {stream
                        .filter(p => p.type === 'blueprint')
                        .map((p, idx) => (
                          <div key={idx} className="blueprint-part" style={{ height: '400px', marginBottom: '1rem' }}>
                            <iframe src={p.content} style={{ width: '100%', height: '100%', border: 'none' }} />
                          </div>
                        ))}
                    </div>
                  )}
                </div>

                {/* Bottom Playback Control Bar */}
                <div className={`playback-controls-bar ${stream.length > 0 ? 'active' : ''}`}>
                  <div className="control-group">
                    <div style={{ display: 'flex', flexDirection: 'column' }}>
                      <span style={{ fontSize: '0.8rem', fontWeight: 600, color: 'white' }}>Now Playing</span>
                      <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>{prompt.substring(0, 30)}...</span>
                    </div>
                  </div>

                  <div className="control-group">
                    <button 
                      className="play-btn-large" 
                      onClick={isPlayingStory ? stopStory : startStory}
                      disabled={!narrationBlocks || narrationBlocks.length === 0}
                      title={!narrationBlocks ? "Narration is being forged..." : "Play Story"}
                    >
                      {isPlayingStory ? '⏸' : '▶'}
                    </button>
                    {!narrationBlocks && <span style={{ fontSize: '0.7rem', color: 'var(--primary)' }}>Forging Voice...</span>}
                  </div>

                  <div className="control-group">
                    <div className="volume-slider">
                      <span>Voice</span>
                      <input 
                        type="range" 
                        min="0" 
                        max="1" 
                        step="0.1" 
                        value={voiceVolume} 
                        onChange={(e) => setVoiceVolume(parseFloat(e.target.value))}
                      />
                    </div>
                    <div className="volume-slider">
                      <span>Ambient</span>
                      <input 
                        type="range" 
                        min="0" 
                        max="1" 
                        step="0.1" 
                        value={ambientVolume} 
                        onChange={(e) => setAmbientVolume(parseFloat(e.target.value))}
                      />
                    </div>
                    <div style={{ display: 'flex', gap: '0.5rem' }}>
                      <button className="back-button" onClick={() => { setView('library'); setStream([]); }} style={{ marginTop: 0 }}>
                        Done
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            )}
            <footer className="app-footer">
              <div className="footer-content">
                <div className="footer-brand">
                  <h3>TaleForge</h3>
                  <p>Master the art of digital storytelling.</p>
                </div>
                <div className="footer-links">
                  <span className="footer-link" onClick={() => setView('privacy')}>Privacy</span>
                  <span className="footer-link" onClick={() => setView('terms')}>Terms</span>
                  <div className="status-indicator" title="All systems operational">
                    Live
                  </div>
                </div>
                <div className="footer-credit">
                  © 2024 TaleForge AI. Forged with passion.
                </div>
              </div>
            </footer>
          </div>
        </div>
      </div>
    </>
  );
}
