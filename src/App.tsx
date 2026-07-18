import React, { useState, useEffect, useRef } from 'react';
import { Play, Square, Loader2, Globe, Settings, Terminal, Activity, CheckCircle2, AlertCircle, Zap, Trash2, Plus } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';

// Generate a simple unique ID for the session if not exists
const getSessionId = () => {
  let id = localStorage.getItem('bot_session_id');
  if (!id) {
    id = Math.random().toString(36).substring(2, 15);
    localStorage.setItem('bot_session_id', id);
  }
  return id;
};

const SESSION_ID = getSessionId();

export default function App() {
  const [url, setUrl] = useState('');
  const [targetType, setTargetType] = useState<'website' | 'youtube'>('website');
  const [youtubeTitle, setYoutubeTitle] = useState('');
  const [trafficType, setTrafficType] = useState<'direct' | 'organic'>('direct');
  const [organicUrls, setOrganicUrls] = useState(['', '', '', '']);
  const [keywords, setKeywords] = useState('');
  const [enableKeywords, setEnableKeywords] = useState(false);
  const [visits, setVisits] = useState(10);
  const [duration, setDuration] = useState(2); // Default 2 minutes
  const [headless, setHeadless] = useState(true);
  const [useProxies, setUseProxies] = useState(false);
  const [smartAI, setSmartAI] = useState(true);
  const [proxyCount, setProxyCount] = useState(0);
  const [isRunning, setIsRunning] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const [screenshot, setScreenshot] = useState<string | null>(null);
  const [currentVisit, setCurrentVisit] = useState(0);
  const [totalVisits, setTotalVisits] = useState(0);
  const [currentAction, setCurrentAction] = useState<string | null>(null);
  const [lastCompletedVisit, setLastCompletedVisit] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [aiQuotaCooldown, setAiQuotaCooldown] = useState(false);
  const [apiKeys, setApiKeys] = useState<string[]>(() => {
    const saved = localStorage.getItem('bot_api_keys');
    return saved ? JSON.parse(saved) : [];
  });
  const [newApiKey, setNewApiKey] = useState('');
  const [manualProxies, setManualProxies] = useState('');
  const [showManualInput, setShowManualInput] = useState(false);
  const logsContainerRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [ws, setWs] = useState<WebSocket | null>(null);
  const [viewportWidth, setViewportWidth] = useState(1920);
  const [viewportHeight, setViewportHeight] = useState(1080);
  const [videoStatus, setVideoStatus] = useState<'playing' | 'paused' | 'buffering' | 'none'>('none');
  const imgRef = useRef<HTMLImageElement>(null);

  useEffect(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host;
    const socket = new WebSocket(`${protocol}//${host}`);

    socket.onopen = () => {
      console.log('WebSocket Connected');
      setWs(socket);
    };

    socket.onmessage = async (event) => {
      const message = JSON.parse(event.data);
      
      // Only process messages for the current user session
      if (message.uid && message.uid !== SESSION_ID) return;

      if (message.type === 'frame') {
        setScreenshot(message.data);
        if (message.width) setViewportWidth(message.width);
        if (message.height) setViewportHeight(message.height);
      } else if (message.type === 'video_status') {
        setVideoStatus(message.status);
      } else if (message.type === 'progress') {
        if (message.current > currentVisit) {
          setLastCompletedVisit(currentVisit);
          setTimeout(() => setLastCompletedVisit(null), 5000);
        }
        setCurrentVisit(message.current);
        setTotalVisits(message.total);
      } else if (message.type === 'action') {
        setCurrentAction(message.action);
      } else if (message.type === 'log') {
        setLogs(prev => {
          const newLogs = [...prev, message.data];
          return newLogs.slice(-100);
        });
      }
    };

    socket.onclose = () => {
      console.log('WebSocket Disconnected');
      setWs(null);
    };

    return () => socket.close();
  }, []);

  const fetchStatus = async () => {
    try {
      const res = await fetch(`/api/logs?uid=${SESSION_ID}`);
      if (res.ok) {
        const data = await res.json();
        setIsRunning(data.isRunning);
        setProxyCount(data.proxyCount || 0);
        if (data.logs && Array.isArray(data.logs)) {
          setLogs(data.logs);
        }
        if (data.screenshot) {
          setScreenshot(data.screenshot);
        }
      }
    } catch (err) {}
  };

  useEffect(() => {
    const interval = setInterval(fetchStatus, 2000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (autoScroll && logsContainerRef.current) {
      logsContainerRef.current.scrollTop = logsContainerRef.current.scrollHeight;
    }
  }, [logs, autoScroll]);

  const handleScroll = () => {
    if (!logsContainerRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = logsContainerRef.current;
    const isAtBottom = scrollHeight - scrollTop - clientHeight < 50;
    setAutoScroll(isAtBottom);
  };

  const handleProxyUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async (event) => {
      const text = event.target?.result as string;
      const proxies = text.split('\n').map(p => p.trim()).filter(p => p.length > 0);
      
      try {
        const res = await fetch('/api/proxies', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ proxies, uid: SESSION_ID })
        });
        if (res.ok) {
          const data = await res.json();
          setProxyCount(data.count);
          setLogs(prev => [...prev, `[SYSTEM] Loaded ${data.count} proxies from file.`].slice(-100));
        }
      } catch (err) {
        console.error('Failed to upload proxies:', err);
      }
    };
    reader.readAsText(file);
  };

  const handleManualProxySubmit = async () => {
    const proxies = manualProxies.split(/[\n,]+/).map(p => p.trim()).filter(p => p.length > 0);
    if (proxies.length === 0) return;
    try {
      const res = await fetch('/api/proxies', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ proxies, uid: SESSION_ID })
      });
      if (res.ok) {
        const data = await res.json();
        setProxyCount(data.count);
        setManualProxies('');
        setLogs(prev => [...prev, `[SYSTEM] Manually added ${proxies.length} proxies to the pool. Total is now ${data.count}.`].slice(-100));
      }
    } catch (err) {
      console.error('Failed to submit proxies:', err);
    }
  };

  const handleClearProxies = async () => {
    try {
      const res = await fetch('/api/proxies', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ proxies: [], uid: SESSION_ID })
      });
      if (res.ok) {
        const data = await res.json();
        setProxyCount(0);
        setLogs(prev => [...prev, `[SYSTEM] Proxy pool cleared successfully.`].slice(-100));
      }
    } catch (err) {
      console.error('Failed to clear proxies:', err);
    }
  };

  const handleStart = async () => {
    if (!url) {
      setError('Please enter a target URL');
      return;
    }
    
    let targetUrl = url.trim();
    if (!/^https?:\/\//i.test(targetUrl)) {
      targetUrl = 'https://' + targetUrl;
    }
    setUrl(targetUrl);

    const normalizedOrganicUrls = organicUrls
      .map(u => u.trim())
      .filter(u => u !== '')
      .map(u => {
        if (!/^https?:\/\//i.test(u)) {
          return 'https://' + u;
        }
        return u;
      });
    setOrganicUrls(normalizedOrganicUrls);
    
    setError(null);
    setCurrentVisit(0);
    setTotalVisits(visits);
    try {
      const res = await fetch('/api/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: targetUrl,
          targetType,
          youtubeTitle,
          visits,
          waitTime: duration * 60000,
          headless,
          useProxies,
          keywords: enableKeywords ? keywords.split(',').map(k => k.trim()) : [],
          trafficType,
          organicUrls: trafficType === 'organic' ? normalizedOrganicUrls : [],
          smartAI,
          uid: SESSION_ID,
          apiKeys
        })
      });
      
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to start bot');
      }
      
      setIsRunning(true);
      setLogs([]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start bot');
    }
  };

  const handleStop = async () => {
    try {
      await fetch('/api/stop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uid: SESSION_ID })
      });
      setIsRunning(false);
      setCurrentAction(null);
      setCurrentVisit(0);
      setTotalVisits(0);
      setScreenshot(null);
      setLastCompletedVisit(null);
      setAiQuotaCooldown(false);
      setLogs(prev => [...prev, "[SYSTEM] Engine stopped manually. Progress reset."].slice(-100));
    } catch (err) {
      console.error('Failed to stop bot:', err);
    }
  };

  const clearLogs = async () => {
    try {
      await fetch(`/api/logs?uid=${SESSION_ID}`, { method: 'DELETE' });
      setLogs([]);
    } catch (err) {
      console.error('Failed to clear logs:', err);
    }
  };

  const addApiKey = () => {
    if (!newApiKey.trim()) return;
    if (apiKeys.includes(newApiKey.trim())) {
      setNewApiKey('');
      return;
    }
    const updatedKeys = [...apiKeys, newApiKey.trim()];
    setApiKeys(updatedKeys);
    localStorage.setItem('bot_api_keys', JSON.stringify(updatedKeys));
    setNewApiKey('');
  };

  const removeApiKey = (keyToRemove: string) => {
    const updatedKeys = apiKeys.filter(k => k !== keyToRemove);
    setApiKeys(updatedKeys);
    localStorage.setItem('bot_api_keys', JSON.stringify(updatedKeys));
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-200 font-sans selection:bg-indigo-500/30">
      {/* Header */}
      <header className="border-b border-slate-800 bg-slate-900/50 backdrop-blur-xl sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-4 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 bg-indigo-600 rounded-lg flex items-center justify-center shadow-lg shadow-indigo-600/20">
              <Zap className="w-5 h-5 text-white" />
            </div>
            <h1 className="font-bold text-lg tracking-tight text-white">Bot Engine <span className="text-indigo-500">v2.0</span></h1>
          </div>
          
          <div className="flex items-center gap-4">
            {isRunning && totalVisits > 0 && (
              <div className="hidden md:flex items-center gap-3 px-4 py-1.5 bg-indigo-500/10 border border-indigo-500/20 rounded-full">
                <div className="flex flex-col">
                  <div className="flex items-center justify-between gap-8">
                    <span className="text-[10px] font-bold text-indigo-400 uppercase tracking-wider">Progress</span>
                    <span className="text-[10px] font-bold text-indigo-400">{Math.round((currentVisit / totalVisits) * 100)}%</span>
                  </div>
                  <div className="w-32 h-1 bg-slate-800 rounded-full overflow-hidden mt-1">
                    <motion.div 
                      className="h-full bg-indigo-500"
                      initial={{ width: 0 }}
                      animate={{ width: `${(currentVisit / totalVisits) * 100}%` }}
                    />
                  </div>
                </div>
                <div className="w-px h-6 bg-slate-800 mx-1" />
                <div className="text-center">
                  <div className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">Visits</div>
                  <div className="text-xs font-bold text-white">{currentVisit} / {totalVisits}</div>
                </div>
              </div>
            )}
            
            <div className="hidden sm:flex items-center gap-4 px-4 py-1.5 bg-slate-800/50 rounded-full border border-slate-700">
              <div className="flex items-center gap-2">
                <div className={`w-2 h-2 rounded-full ${isRunning ? 'bg-emerald-500 animate-pulse' : 'bg-slate-500'}`} />
                <span className="text-xs font-medium text-slate-300">{isRunning ? 'Engine Running' : 'Engine Idle'}</span>
              </div>
              <div className="w-px h-3 bg-slate-700" />
              <div className="flex items-center gap-2">
                <Globe className="w-3.5 h-3.5 text-slate-400" />
                <span className="text-xs font-medium text-slate-300">{proxyCount} Proxies</span>
              </div>
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto p-4 lg:p-6 grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left Column: Configuration */}
        <div className="lg:col-span-4 space-y-6">
          {/* API Key Management Card */}
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 shadow-xl">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <Zap className="w-4 h-4 text-indigo-400" />
                <h3 className="font-bold text-sm text-white uppercase tracking-wider">Gemini API Keys</h3>
              </div>
              {apiKeys.length > 0 && (
                <span className="text-[10px] font-bold text-indigo-400 bg-indigo-500/10 px-2 py-0.5 rounded-full border border-indigo-500/20">
                  {apiKeys.length} Active
                </span>
              )}
            </div>
            
            <div className="space-y-3">
              <div className="flex gap-2">
                <input 
                  type="password"
                  value={newApiKey}
                  onChange={(e) => setNewApiKey(e.target.value)}
                  placeholder="Paste API Key here..."
                  className="flex-1 bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-300 focus:outline-none focus:border-indigo-500 transition-colors"
                />
                <button 
                  onClick={addApiKey}
                  className="bg-indigo-600 hover:bg-indigo-500 text-white px-3 py-2 rounded-lg text-xs font-bold transition-colors flex items-center gap-1"
                >
                  <Plus className="w-3 h-3" />
                  Add
                </button>
              </div>
              
              <div className="max-h-32 overflow-y-auto space-y-2 pr-1 custom-scrollbar">
                {apiKeys.length === 0 ? (
                  <div className="text-[10px] text-slate-500 italic text-center py-2">
                    No custom keys added. Using system default.
                  </div>
                ) : (
                  apiKeys.map((key, idx) => (
                    <div key={idx} className="flex items-center justify-between bg-slate-950 border border-slate-800/50 rounded-lg px-3 py-2">
                      <div className="flex items-center gap-2 overflow-hidden">
                        <div className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                        <span className="text-[10px] text-slate-400 font-mono truncate">
                          {key.substring(0, 8)}...{key.substring(key.length - 4)}
                        </span>
                      </div>
                      <button 
                        onClick={() => removeApiKey(key)}
                        className="text-slate-500 hover:text-rose-500 transition-colors p-1"
                        title="Remove Key"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ))
                )}
              </div>
              <p className="text-[9px] text-slate-500 leading-relaxed">
                Add multiple keys to rotate automatically when quota is exceeded. Keys are stored locally in your browser.
              </p>
            </div>
          </div>

          {/* Progress Stats Card (Visible when running) */}
          <AnimatePresence>
            {isRunning && (
              <motion.div 
                initial={{ opacity: 0, y: -20 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -20 }}
                className="bg-emerald-500/10 border border-emerald-500/20 rounded-2xl p-5 shadow-lg shadow-emerald-500/5"
              >
                <div className="flex items-center justify-between mb-4">
                  <div className="flex items-center gap-2">
                    {currentVisit === totalVisits && totalVisits > 0 ? (
                      <CheckCircle2 className="w-5 h-5 text-emerald-500" />
                    ) : (
                      <Activity className="w-5 h-5 text-emerald-500" />
                    )}
                    <h3 className="font-bold text-sm text-white uppercase tracking-wider">
                      {currentVisit === totalVisits && totalVisits > 0 ? 'Engine Completed' : 'Engine Progress'}
                    </h3>
                  </div>
                  <span className="text-xs font-bold text-emerald-500 bg-emerald-500/10 px-2 py-0.5 rounded">
                    {Math.round((currentVisit / totalVisits) * 100)}%
                  </span>
                </div>
                
                <div className="grid grid-cols-2 gap-4">
                  <div className="bg-slate-950/50 rounded-xl p-3 border border-slate-800 relative overflow-hidden">
                    <div className="text-[10px] font-bold text-slate-500 uppercase mb-1">Completed</div>
                    <div className="text-2xl font-black text-white">{currentVisit}</div>
                    <AnimatePresence>
                      {lastCompletedVisit !== null && (
                        <motion.div 
                          initial={{ opacity: 0, y: 20 }}
                          animate={{ opacity: 1, y: 0 }}
                          exit={{ opacity: 0, y: -20 }}
                          className="absolute inset-0 bg-emerald-500 flex items-center justify-center text-[10px] font-bold text-white uppercase tracking-widest"
                        >
                          Visit #{lastCompletedVisit + 1} Done!
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>
                  <div className="bg-slate-950/50 rounded-xl p-3 border border-slate-800">
                    <div className="text-[10px] font-bold text-slate-500 uppercase mb-1">Remaining</div>
                    <div className="text-2xl font-black text-slate-400">{totalVisits - currentVisit}</div>
                  </div>
                </div>

                <div className="mt-4 w-full h-2 bg-slate-800 rounded-full overflow-hidden">
                  <motion.div 
                    className="h-full bg-emerald-500 shadow-[0_0_10px_rgba(16,185,129,0.5)]"
                    initial={{ width: 0 }}
                    animate={{ width: `${(currentVisit / totalVisits) * 100}%` }}
                    transition={{ type: "spring", stiffness: 50 }}
                  />
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Main Config Card */}
          <div className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden shadow-xl">
            <div className="p-4 border-b border-slate-800 bg-slate-800/30 flex items-center gap-2">
              <Settings className="w-4 h-4 text-indigo-400" />
              <h2 className="font-semibold text-sm text-white">Configuration</h2>
            </div>
            
            <div className="p-5 space-y-5">
              {/* URL Input */}
              <div className="space-y-2">
                <label className="text-xs font-medium text-slate-400 uppercase tracking-wider">Target URL</label>
                <div className="relative group">
                  <Globe className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500 group-focus-within:text-indigo-500 transition-colors" />
                  <input
                    type="url"
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                    placeholder="https://example.com"
                    disabled={isRunning}
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl py-2.5 pl-10 pr-4 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-all disabled:opacity-50"
                  />
                </div>
              </div>

              {/* Target Type Selector */}
              <div className="space-y-2">
                <label className="text-xs font-medium text-slate-400 uppercase tracking-wider">Target Type</label>
                <div className="grid grid-cols-2 gap-2 p-1 bg-slate-950 rounded-xl border border-slate-800">
                  <button
                    type="button"
                    onClick={() => setTargetType('website')}
                    disabled={isRunning}
                    className={`py-2 px-4 rounded-lg text-xs font-medium transition-all ${
                      targetType === 'website' 
                        ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-600/20' 
                        : 'text-slate-500 hover:text-slate-300'
                    }`}
                  >
                    Website / Blog
                  </button>
                  <button
                    type="button"
                    onClick={() => setTargetType('youtube')}
                    disabled={isRunning}
                    className={`py-2 px-4 rounded-lg text-xs font-medium transition-all ${
                      targetType === 'youtube' 
                        ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-600/20' 
                        : 'text-slate-500 hover:text-slate-300'
                    }`}
                  >
                    YouTube Video
                  </button>
                </div>
              </div>

              {/* YouTube Video Title Input */}
              {targetType === 'youtube' && (
                <div className="space-y-2 animate-in fade-in slide-in-from-top-2 duration-300">
                  <label className="text-xs font-medium text-slate-400 uppercase tracking-wider">YouTube Video Title (For Search)</label>
                  <input
                    type="text"
                    value={youtubeTitle}
                    onChange={(e) => setYoutubeTitle(e.target.value)}
                    placeholder="Type the exact title to search on YouTube..."
                    disabled={isRunning}
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl py-2.5 px-4 text-xs focus:outline-none focus:border-indigo-500 transition-all disabled:opacity-50"
                  />
                  <p className="text-[10px] text-indigo-400/70 italic leading-relaxed">
                    * If provided, the bot will search for this title on YouTube, find and click the video. Otherwise, it goes directly to the link.
                  </p>
                </div>
              )}

              {/* Traffic Control */}
              <div className="space-y-3">
                <label className="text-xs font-medium text-slate-400 uppercase tracking-wider">Traffic Mode</label>
                <div className="grid grid-cols-2 gap-2 p-1 bg-slate-950 rounded-xl border border-slate-800">
                  <button
                    onClick={() => setTrafficType('direct')}
                    disabled={isRunning}
                    className={`py-2 px-4 rounded-lg text-xs font-medium transition-all ${
                      trafficType === 'direct' 
                        ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-600/20' 
                        : 'text-slate-500 hover:text-slate-300'
                    }`}
                  >
                    Direct Link (Ad/Landing)
                  </button>
                  <button
                    onClick={() => setTrafficType('organic')}
                    disabled={isRunning}
                    className={`py-2 px-4 rounded-lg text-xs font-medium transition-all ${
                      trafficType === 'organic' 
                        ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-600/20' 
                        : 'text-slate-500 hover:text-slate-300'
                    }`}
                  >
                    Organic (Search Traffic)
                  </button>
                </div>

                {trafficType === 'organic' && (
                  <div className="space-y-4 pt-2 animate-in fade-in slide-in-from-top-2 duration-300">
                    <div className="space-y-3">
                      <div className="flex items-center justify-between">
                        <label className="text-[10px] font-medium text-slate-500 uppercase tracking-wider">Search Keywords</label>
                        <input
                          type="checkbox"
                          checked={enableKeywords}
                          onChange={(e) => setEnableKeywords(e.target.checked)}
                          disabled={isRunning}
                          className="w-3.5 h-3.5 rounded border-slate-800 bg-slate-950 text-indigo-600 focus:ring-indigo-500/20"
                        />
                      </div>
                      {enableKeywords && (
                        <div className="space-y-2 animate-in zoom-in-95 duration-200">
                          <input
                            type="text"
                            value={keywords}
                            onChange={(e) => setKeywords(e.target.value)}
                            placeholder="keyword1, keyword2, keyword3"
                            disabled={isRunning}
                            className="w-full bg-slate-950 border border-slate-800 rounded-lg py-2 px-3 text-xs focus:outline-none focus:border-indigo-500 transition-all"
                          />
                          <p className="text-[10px] text-indigo-400/70 italic">* Bot will search for these on Google to find your site</p>
                        </div>
                      )}
                    </div>

                    <div className="space-y-3">
                      <label className="text-[10px] font-medium text-slate-500 uppercase tracking-wider">Referral URLs (Optional)</label>
                      <div className="space-y-2">
                        {organicUrls.map((u, idx) => (
                          <input
                            key={idx}
                            type="url"
                            value={u}
                            onChange={(e) => {
                              const newUrls = [...organicUrls];
                              newUrls[idx] = e.target.value;
                              setOrganicUrls(newUrls);
                            }}
                            placeholder={`Referrer URL ${idx + 1}`}
                            disabled={isRunning}
                            className="w-full bg-slate-950 border border-slate-800 rounded-lg py-2 px-3 text-xs focus:outline-none focus:border-indigo-500 transition-all"
                          />
                        ))}
                      </div>
                      <p className="text-[10px] text-indigo-400/70 italic">* Bot will visit these URLs randomly to simulate organic referral traffic</p>
                    </div>
                  </div>
                )}
              </div>

              {/* Stats Grid */}
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <label className="text-xs font-medium text-slate-400 uppercase tracking-wider">Visits</label>
                  <input
                    type="number"
                    value={visits}
                    onChange={(e) => setVisits(parseInt(e.target.value) || 1)}
                    min="1"
                    disabled={isRunning}
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl py-2 px-4 text-sm focus:outline-none focus:border-indigo-500 transition-all"
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-xs font-medium text-slate-400 uppercase tracking-wider">Min Per Visit</label>
                  <input
                    type="number"
                    value={duration}
                    onChange={(e) => setDuration(parseInt(e.target.value) || 1)}
                    min="1"
                    disabled={isRunning}
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl py-2 px-4 text-sm focus:outline-none focus:border-indigo-500 transition-all"
                  />
                </div>
              </div>

              {/* Toggles */}
              <div className="space-y-3 pt-2">
                <label className="flex items-center justify-between p-3 bg-slate-950 rounded-xl border border-slate-800 cursor-pointer hover:bg-slate-900/50 transition-colors">
                  <div className="flex items-center gap-3">
                    <Activity className="w-4 h-4 text-indigo-400" />
                    <span className="text-sm font-medium text-slate-300">Smart AI Behavior</span>
                  </div>
                  <input
                    type="checkbox"
                    checked={smartAI}
                    onChange={(e) => setSmartAI(e.target.checked)}
                    disabled={isRunning}
                    className="w-4 h-4 rounded border-slate-800 bg-slate-950 text-indigo-600 focus:ring-indigo-500/20"
                  />
                </label>

                <label className="flex items-center justify-between p-3 bg-slate-950 rounded-xl border border-slate-800 cursor-pointer hover:bg-slate-900/50 transition-colors">
                  <div className="flex items-center gap-3">
                    <Terminal className="w-4 h-4 text-indigo-400" />
                    <span className="text-sm font-medium text-slate-300">Headless Mode</span>
                  </div>
                  <input
                    type="checkbox"
                    checked={headless}
                    onChange={(e) => setHeadless(e.target.checked)}
                    disabled={isRunning}
                    className="w-4 h-4 rounded border-slate-800 bg-slate-950 text-indigo-600 focus:ring-indigo-500/20"
                  />
                </label>
              </div>

              {/* Proxy Section */}
              <div className="pt-2">
                <div className="bg-indigo-500/5 border border-indigo-500/10 rounded-xl p-4 space-y-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Globe className="w-4 h-4 text-indigo-400" />
                      <span className="text-sm font-semibold text-indigo-100">Proxy Management</span>
                    </div>
                    <div className="flex items-center gap-3">
                      {proxyCount > 0 && (
                        <button
                          onClick={handleClearProxies}
                          disabled={isRunning}
                          className="text-[10px] font-bold text-rose-400 hover:text-rose-300 uppercase tracking-wider transition-colors cursor-pointer"
                          title="Clear current proxies"
                        >
                          Clear ({proxyCount})
                        </button>
                      )}
                      <input
                        type="checkbox"
                        checked={useProxies}
                        onChange={(e) => setUseProxies(e.target.checked)}
                        disabled={isRunning}
                        className="w-4 h-4 rounded border-slate-800 bg-slate-950 text-indigo-600 focus:ring-indigo-500/20"
                      />
                    </div>
                  </div>

                  <div className="flex gap-2 p-1 bg-slate-950 rounded-lg border border-slate-800 text-xs">
                    <button
                      type="button"
                      onClick={() => setShowManualInput(false)}
                      className={`flex-1 py-1.5 rounded-md font-medium transition-all cursor-pointer ${!showManualInput ? 'bg-indigo-600 text-white shadow' : 'text-slate-400 hover:text-slate-300'}`}
                    >
                      File Upload
                    </button>
                    <button
                      type="button"
                      onClick={() => setShowManualInput(true)}
                      className={`flex-1 py-1.5 rounded-md font-medium transition-all cursor-pointer ${showManualInput ? 'bg-indigo-600 text-white shadow' : 'text-slate-400 hover:text-slate-300'}`}
                    >
                      Manual Paste
                    </button>
                  </div>

                  {!showManualInput ? (
                    <div className="space-y-2">
                      <button
                        type="button"
                        onClick={() => fileInputRef.current?.click()}
                        disabled={isRunning}
                        className="w-full py-2 px-4 bg-indigo-600/10 border border-indigo-500/20 rounded-lg text-xs font-medium text-indigo-400 hover:bg-indigo-600/20 transition-all flex items-center justify-center gap-2 cursor-pointer"
                      >
                        Upload Proxy List (.txt)
                      </button>
                      <input
                        type="file"
                        ref={fileInputRef}
                        onChange={handleProxyUpload}
                        accept=".txt"
                        className="hidden"
                      />
                    </div>
                  ) : (
                    <div className="space-y-2">
                      <textarea
                        rows={3}
                        value={manualProxies}
                        onChange={(e) => setManualProxies(e.target.value)}
                        placeholder="Paste proxies (one per line, or comma-separated)&#10;e.g. 192.168.1.1:8080:user:pass"
                        disabled={isRunning}
                        className="w-full bg-slate-950 border border-slate-800 rounded-lg p-2 text-xs text-slate-300 focus:outline-none focus:border-indigo-500 font-mono custom-scrollbar"
                      />
                      <button
                        type="button"
                        onClick={handleManualProxySubmit}
                        disabled={isRunning || !manualProxies.trim()}
                        className="w-full py-2 px-4 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-xs font-bold transition-all disabled:opacity-50 disabled:hover:bg-indigo-600 cursor-pointer"
                      >
                        Add Manual Proxies
                      </button>
                    </div>
                  )}

                  <p className="text-[10px] text-indigo-400/60 text-center">Format: IP:PORT:USER:PASS or IP:PORT</p>
                </div>
              </div>

              {/* Action Button */}
              <div className="pt-4">
                <button
                  onClick={isRunning ? handleStop : handleStart}
                  className={`w-full py-4 rounded-xl font-bold text-sm tracking-wide transition-all flex items-center justify-center gap-3 shadow-lg ${
                    isRunning 
                      ? 'bg-rose-600 hover:bg-rose-700 text-white shadow-rose-600/20' 
                      : 'bg-indigo-600 hover:bg-indigo-700 text-white shadow-indigo-600/20'
                  }`}
                >
                  {isRunning ? (
                    <>
                      <Square className="w-4 h-4 fill-current" />
                      STOP ENGINE
                    </>
                  ) : (
                    <>
                      <Play className="w-4 h-4 fill-current" />
                      START ENGINE
                    </>
                  )}
                </button>
                {error && (
                  <div className="mt-3 p-3 bg-rose-500/10 border border-rose-500/20 rounded-xl flex items-center gap-2 text-rose-400 text-xs">
                    <AlertCircle className="w-4 h-4 shrink-0" />
                    {error}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Right Column: Live Feed & Logs */}
        <div className="lg:col-span-8 space-y-6">
          {/* Live Feed Card */}
          <div className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden shadow-xl">
            <div className="p-4 border-b border-slate-800 bg-slate-800/30 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Activity className="w-4 h-4 text-emerald-400" />
                <h2 className="font-semibold text-sm text-white">Live Browser Feed</h2>
              </div>
              <div className="flex items-center gap-3">
                {isRunning && targetType === 'youtube' && (
                  <div className="flex items-center gap-1.5 px-2 py-0.5 bg-slate-950 border border-slate-800 rounded text-[10px] font-bold uppercase tracking-wider">
                    <span className="text-slate-400">Video:</span>
                    {videoStatus === 'playing' && (
                      <span className="text-emerald-400 flex items-center gap-1">
                        <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
                        Playing
                      </span>
                    )}
                    {videoStatus === 'paused' && (
                      <span className="text-amber-500 flex items-center gap-1">
                        <span className="h-1.5 w-1.5 rounded-full bg-amber-500 animate-pulse" />
                        Paused
                      </span>
                    )}
                    {videoStatus === 'buffering' && (
                      <span className="text-blue-400 flex items-center gap-1">
                        <span className="h-1.5 w-1.5 rounded-full bg-blue-400 animate-ping" />
                        Buffering
                      </span>
                    )}
                    {videoStatus === 'none' && (
                      <span className="text-slate-500">Not Loaded</span>
                    )}
                  </div>
                )}
                {aiQuotaCooldown && (
                  <div className="flex items-center gap-1.5 px-2 py-0.5 bg-amber-500/10 border border-amber-500/20 rounded text-[10px] font-bold text-amber-500 uppercase tracking-wider animate-pulse">
                    AI Cooldown
                  </div>
                )}
                {isRunning && (
                  <div className="flex items-center gap-2">
                    <span className="flex h-2 w-2 relative">
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                      <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
                    </span>
                    <span className="text-[10px] font-bold text-emerald-500 uppercase tracking-widest">Live</span>
                  </div>
                )}
              </div>
            </div>
            
            <div className="aspect-video bg-slate-950 relative group">
              {screenshot ? (
                <div className="relative w-full h-full">
                  <img 
                    ref={imgRef}
                    src={`data:image/jpeg;base64,${screenshot}`} 
                    alt="Live Feed" 
                    className="w-full h-full object-contain cursor-crosshair select-none"
                    onClick={(e) => {
                      if (!imgRef.current || !ws || ws.readyState !== WebSocket.OPEN) return;
                      const rect = imgRef.current.getBoundingClientRect();
                      const clickX = e.clientX - rect.left;
                      const clickY = e.clientY - rect.top;
                      const relativeX = clickX / rect.width;
                      const relativeY = clickY / rect.height;
                      
                      const x = Math.round(relativeX * viewportWidth);
                      const y = Math.round(relativeY * viewportHeight);
                      
                      ws.send(JSON.stringify({
                        type: 'click',
                        uid: SESSION_ID,
                        x,
                        y,
                        width: viewportWidth,
                        height: viewportHeight
                      }));
                    }}
                  />
                  <div className="absolute top-2 right-2 bg-black/60 backdrop-blur-md px-2 py-1 rounded text-[10px] text-slate-300 pointer-events-none opacity-0 group-hover:opacity-100 transition-opacity duration-300">
                    Click anywhere on feed to interact
                  </div>
                </div>
              ) : (
                <div className="absolute inset-0 flex flex-col items-center justify-center text-slate-600">
                  {isRunning ? (
                    <>
                      <Loader2 className="w-10 h-10 animate-spin mb-4 text-indigo-500/50" />
                      <p className="text-sm font-medium animate-pulse">Waiting for browser stream...</p>
                    </>
                  ) : (
                    <>
                      <Globe className="w-12 h-12 mb-4 opacity-20" />
                      <p className="text-sm font-medium opacity-50">Engine Offline</p>
                    </>
                  )}
                </div>
              )}
              
              {/* Overlay Info */}
              <div className="absolute bottom-4 left-4 right-4 flex items-center justify-between pointer-events-none">
                <div className="flex flex-col gap-2">
                  {currentAction && (
                    <motion.div 
                      initial={{ opacity: 0, x: -20 }}
                      animate={{ opacity: 1, x: 0 }}
                      className="px-3 py-1.5 bg-indigo-600/90 backdrop-blur-md border border-indigo-400/30 rounded-lg text-[10px] font-bold text-white uppercase tracking-widest shadow-lg"
                    >
                      Action: {currentAction}
                    </motion.div>
                  )}
                  <div className="px-3 py-1.5 bg-slate-900/80 backdrop-blur-md border border-slate-700 rounded-lg text-[10px] font-mono text-slate-300">
                    {url || 'No Target'}
                  </div>
                </div>
                <div className="px-3 py-1.5 bg-slate-900/80 backdrop-blur-md border border-slate-700 rounded-lg text-[10px] font-mono text-slate-300">
                  1920x1080
                </div>
              </div>
            </div>
          </div>

          {/* System Console Card */}
          <div className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden shadow-xl flex flex-col h-[400px]">
            <div className="p-4 border-b border-slate-800 bg-slate-800/30 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Terminal className="w-4 h-4 text-indigo-400" />
                <h2 className="font-semibold text-sm text-white">System Console</h2>
              </div>
              <div className="flex items-center gap-2">
                <button 
                  onClick={clearLogs}
                  className="text-[10px] font-bold text-slate-500 hover:text-slate-300 uppercase tracking-wider transition-colors"
                >
                  Clear Logs
                </button>
              </div>
            </div>
            
            <div 
              ref={logsContainerRef}
              onScroll={handleScroll}
              className="flex-1 overflow-y-auto p-4 font-mono text-xs space-y-1.5 scrollbar-thin scrollbar-thumb-slate-800 scrollbar-track-transparent"
            >
              <AnimatePresence initial={false}>
                {logs.length === 0 ? (
                  <div className="h-full flex items-center justify-center text-slate-600 italic">
                    No system logs to display
                  </div>
                ) : (
                  logs.map((log, i) => (
                    <motion.div
                      key={i}
                      initial={{ opacity: 0, x: -10 }}
                      animate={{ opacity: 1, x: 0 }}
                      className="flex gap-3 group"
                    >
                      <span className="text-slate-600 shrink-0 select-none">{i + 1}</span>
                      <span className={`break-all ${
                        log.includes('Error') ? 'text-rose-400' : 
                        log.includes('Success') || log.includes('Verified') ? 'text-emerald-400' : 
                        log.includes('AI') ? 'text-indigo-400' :
                        'text-slate-300'
                      }`}>
                        {log}
                      </span>
                    </motion.div>
                  ))
                )}
              </AnimatePresence>
            </div>
            
            <div className="p-3 border-t border-slate-800 bg-slate-950 flex items-center justify-between">
              <div className="flex items-center gap-4">
                <div className="flex items-center gap-2">
                  <div className="w-1.5 h-1.5 rounded-full bg-indigo-500" />
                  <span className="text-[10px] text-slate-500 font-medium uppercase tracking-widest">System Ready</span>
                </div>
              </div>
              <div className="text-[10px] text-slate-600 font-mono">
                UTF-8 | Node.js | Puppeteer
              </div>
            </div>
          </div>
        </div>
      </main>

      {/* Footer */}
      <footer className="max-w-7xl mx-auto px-4 py-8 border-t border-slate-900">
        <div className="flex flex-col md:row items-center justify-between gap-4">
          <div className="flex items-center gap-2 text-slate-500 text-xs">
            <CheckCircle2 className="w-3.5 h-3.5 text-indigo-500" />
            <span>Stealth Mode Active</span>
            <span className="mx-2 text-slate-800">|</span>
            <span>Fingerprint Protection Enabled</span>
          </div>
          <p className="text-slate-600 text-[10px] font-medium uppercase tracking-widest">
            © 2026 Bot Engine Pro • Advanced Traffic Generation
          </p>
        </div>
      </footer>
    </div>
  );
}
