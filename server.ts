import express from 'express';
console.log('Server script starting...');
import { createServer as createViteServer } from 'vite';
import path from 'path';
import cors from 'cors';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { Browser, Page } from 'puppeteer';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'http';
import { GoogleGenAI, Type } from '@google/genai';

puppeteer.use(StealthPlugin());

async function startServer() {
  const app = express();
  const server = createServer(app);
  const wss = new WebSocketServer({ server });
  const PORT = 3000;

  app.use(cors());
  app.use(express.json());

  // WebSocket connection handling
  let connectedClients: WebSocket[] = [];
  let pendingDecisions: Map<string, (decision: any) => void> = new Map();

  wss.on('connection', (ws) => {
    connectedClients.push(ws);
    
    ws.on('message', async (data) => {
      try {
        const message = JSON.parse(data.toString());
        if (message.type === 'ai_decision' && message.requestId) {
          const resolve = pendingDecisions.get(message.requestId);
          if (resolve) {
            resolve(message.decision);
            pendingDecisions.delete(message.requestId);
          }
        } else if (message.type === 'click' && message.uid) {
          const session = getOrCreateSession(message.uid);
          if (session && session.activePage && !session.activePage.isClosed()) {
            const page = session.activePage;
            addLog(message.uid, `[USER] Interactive click executed at ${message.x}x${message.y}`);
            
            try {
              // Perform a native mouse click at user coordinates
              await page.mouse.click(message.x, message.y).catch(() => {});
              
              // Immediately take a screenshot and broadcast back to update UI
              const base64 = await page.screenshot({ encoding: 'base64', type: 'jpeg', quality: 75 }).catch(() => null);
              if (base64) {
                session.currentScreenshot = base64;
                const frameMsg = JSON.stringify({ 
                  type: 'frame', 
                  data: base64, 
                  uid: message.uid, 
                  width: message.width || 1920, 
                  height: message.height || 1080 
                });
                connectedClients.forEach(client => {
                  if (client.readyState === WebSocket.OPEN) {
                    client.send(frameMsg);
                  }
                });
              }
            } catch (clickErr) {}
          }
        }
      } catch (e) {
        console.error('Error parsing WS message:', e);
      }
    });

    ws.on('close', () => {
      connectedClients = connectedClients.filter(c => c !== ws);
    });
  });

  const requestAIDecision = async (
    uid: string,
    screenshot: string,
    width: number,
    height: number,
    popupCloseCount: number,
    trafficType: string,
    retryCount = 0
  ): Promise<any> => {
    const session = getOrCreateSession(uid);
    const envKey = process.env.GEMINI_API_KEY;
    const availableKeys = session.apiKeys && session.apiKeys.length > 0 ? session.apiKeys : (envKey ? [envKey] : []);

    if (availableKeys.length === 0) {
      addLog(uid, "Warning: No Gemini API key available. Please add one in the settings.");
      return { action: "SCROLL", x: null, y: null, reason: "No API key configured: scrolling as fallback." };
    }

    try {
      const currentKey = availableKeys[retryCount % availableKeys.length];
      const ai = new GoogleGenAI({
        apiKey: currentKey,
        httpOptions: {
          headers: {
            'User-Agent': 'aistudio-build',
          }
        }
      });

      const prompt = `You are an expert human-like web interaction bot. Analyze this screenshot of a webpage.
The screenshot dimensions are ${width}x${height}.
Your goal is to simulate a real human user to generate high-quality, natural traffic.

CURRENT MODE: ${trafficType === 'organic' ? 'Organic (Ad Traffic)' : 'Direct (Landing Page/Ad Link)'}
CURRENT STATE: You have closed ${popupCloseCount || 0} pop-ups so far in this session.

HUMAN-LIKE STRATEGY:
1. **CRITICAL - AD & POPUP REMOVAL:** If you see ANY overlay, popup, or banner that blocks the page, prioritize closing it. 
   - **Look for the "X" icon, "Close", "Dismiss", or "Skip Ad" button.** 
   - **DO NOT click the middle of an ad to close it.** You must find the specific close button.
   - Look for fake buttons like "Download is ready", "Tap to proceed", "Start Download" that are clearly ads. Use "CLOSE_POPUP" on the "X" if available, otherwise use "CLOSE_POPUP" on the most likely close area.
   - This applies to ALL modes.
2. **MODE-SPECIFIC BEHAVIOR:**
   - **If MODE is "Organic (Ad Traffic)":** You should primarily SCROLL, **INTERACT** with page elements (links, buttons, menus), and **FREQUENTLY** CLICK_AD. Be natural and selective.
   - **If MODE is "Direct (Landing Page/Ad Link)":** This is often a direct link to an ad or a landing page (e.g., Montage/MoneyTag). You SHOULD interact with the page naturally. You MAY click ads, buttons like "Proceed", "Continue", or "Accept" if they appear to be part of the user's intended path. Your goal is to look like a real interested visitor.
3. **INTERACT:** Use this to click on interesting parts of the page, menu items, or internal links to look like a real browsing human.
4. **FAST INTERACTION:** Act quickly. If you see a CAPTCHA, solve it.
5. If there is a video, you may use "CLOSE_POPUP" to skip ads or "SCROLL" to browse.
6. Spend some time "WAIT"ing or "SCROLL"ing to look natural, but prioritize clearing the screen of any obstructions first.
7. **DISTANCE IDENTIFICATION:** Look for ads and elements across the entire page, not just the center. Identify targets even if they are far from the current mouse position.

IMPORTANT: 
- Be extremely precise with (x, y) coordinates.
- **Look for the EXACT visual center of the "Skip Ad" button, "X" icon, or the "Close" text.**
- If you see a Google AdSense "Vignette" (full screen ad), look for the "Close" or "X" at the top right or top left.
- Return ONLY a JSON object.
- Use the following format:
{
  "action": "CLICK_AD" | "CLOSE_POPUP" | "SCROLL" | "WAIT" | "NAVIGATE_BACK" | "INTERACT",
  "x": number | null,
  "y": number | null,
  "reason": "string explaining your action based on the current mode (${trafficType})"
}

If action is SCROLL, WAIT, NAVIGATE_BACK, or if no specific coordinate is needed, x and y can be null.`;

      const allowedActions = ["CLICK_AD", "CLOSE_POPUP", "SCROLL", "WAIT", "NAVIGATE_BACK", "INTERACT"];

      const response = await ai.models.generateContent({
        model: "gemini-3.5-flash",
        contents: [
          {
            parts: [
              { text: prompt },
              { inlineData: { data: screenshot, mimeType: "image/jpeg" } }
            ]
          }
        ],
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              action: { type: Type.STRING, enum: allowedActions },
              x: { type: Type.NUMBER },
              y: { type: Type.NUMBER },
              reason: { type: Type.STRING }
            },
            required: ["action", "reason"]
          }
        }
      });

      const resultText = response?.text?.trim() || "{}";
      const result = JSON.parse(resultText);
      return result;
    } catch (err: any) {
      console.error("Server AI Error:", err);
      const errStr = (err.message || "") + " " + JSON.stringify(err);
      const isQuotaError = 
        errStr.toLowerCase().includes('429') || 
        errStr.toLowerCase().includes('quota');

      if (isQuotaError) {
        const hasMoreKeys = availableKeys.length > retryCount + 1;
        if (hasMoreKeys) {
          addLog(uid, `[SYSTEM] Key #${retryCount + 1} quota exhausted. Rotating to Key #${retryCount + 2}...`);
          return requestAIDecision(uid, screenshot, width, height, popupCloseCount, trafficType, retryCount + 1);
        } else {
          addLog(uid, `[SYSTEM] ALL API keys quota exhausted. Falling back to auto-pilot scroll.`);
          return { action: "SCROLL", x: null, y: null, reason: "AI Quota exhausted: falling back to scroll." };
        }
      }

      const maxRetries = 2;
      if (retryCount < maxRetries) {
        addLog(uid, `Retrying AI decision (attempt ${retryCount + 1})...`);
        return requestAIDecision(uid, screenshot, width, height, popupCloseCount, trafficType, retryCount + 1);
      }

      return { action: "SCROLL", x: null, y: null, reason: "AI failed after retries: scrolling as fallback." };
    }
  };

  // Multi-user session management
  const userSessions: Map<string, {
    browser: Browser | null;
    isRunning: boolean;
    logs: string[];
    proxyList: string[];
    currentScreenshot: string | null;
    popupCloseCount: number;
    apiKeys?: string[];
    currentRunId?: string;
    activePage?: Page | null;
  }> = new Map();

  const getOrCreateSession = (uid: string) => {
    if (!userSessions.has(uid)) {
      userSessions.set(uid, {
        browser: null,
        isRunning: false,
        logs: [],
        proxyList: [],
        currentScreenshot: null,
        popupCloseCount: 0,
        apiKeys: []
      });
    }
    return userSessions.get(uid)!;
  };

  const addLog = (uid: string, msg: string) => {
    const session = getOrCreateSession(uid);
    const timestamp = new Date().toLocaleTimeString();
    const formattedMsg = `[${timestamp}] ${msg}`;
    session.logs.push(formattedMsg);
    if (session.logs.length > 100) session.logs.shift();
    console.log(`[Bot ${uid}] ${msg}`);
    
    // Broadcast to the specific user's dashboard
    const message = JSON.stringify({ type: 'log', data: formattedMsg, uid });
    connectedClients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    });
  };

  const broadcastFrame = (uid: string, base64Frame: string, width: number, height: number) => {
    const session = getOrCreateSession(uid);
    session.currentScreenshot = base64Frame;
    const message = JSON.stringify({ type: 'frame', data: base64Frame, uid, width, height });
    connectedClients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    });
  };

  const broadcastAction = (uid: string, action: string) => {
    const message = JSON.stringify({ type: 'action', action, uid });
    connectedClients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    });
  };

  const broadcastProgress = (uid: string, current: number, total: number) => {
    const message = JSON.stringify({ type: 'progress', current, total, uid });
    connectedClients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    });
  };

  app.get('/api/logs', (req, res) => {
    const uid = req.query.uid as string;
    if (!uid) return res.status(400).json({ error: 'UID is required' });
    const session = getOrCreateSession(uid);
    res.json({ logs: session.logs, isRunning: session.isRunning, proxyCount: session.proxyList.length, screenshot: session.currentScreenshot });
  });

  app.delete('/api/logs', (req, res) => {
    const uid = req.query.uid as string;
    if (!uid) return res.status(400).json({ error: 'UID is required' });
    const session = getOrCreateSession(uid);
    session.logs = [];
    res.json({ message: 'Logs cleared' });
  });

  app.post('/api/proxies', (req, res) => {
    const { proxies, uid } = req.body;
    if (!uid) return res.status(400).json({ error: 'UID is required' });
    if (Array.isArray(proxies)) {
      const session = getOrCreateSession(uid);
      session.proxyList = proxies.filter(p => p.trim().length > 0);
      addLog(uid, `Proxy pool updated: ${session.proxyList.length} proxies are ready.`);
      res.json({ message: 'Proxies updated', count: session.proxyList.length });
    } else {
      res.status(400).json({ error: 'Invalid proxy list' });
    }
  });

  const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
  ];

  const VIEWPORTS = [
    { width: 1920, height: 1080 },
    { width: 1366, height: 768 },
    { width: 1440, height: 900 },
    { width: 1536, height: 864 },
    { width: 1280, height: 720 },
  ];

  app.post('/api/start', async (req, res) => {
    const {
      url,
      targetType = 'website',
      youtubeTitle = '',
      visits = 1,
      waitTime = 5000,
      headless = true,
      useProxies = false,
      keywords = [],
      trafficType = 'direct',
      organicUrls = [],
      smartAI = true,
      uid,
      apiKeys = []
    } = req.body;

    if (!uid) return res.status(400).json({ error: 'UID is required' });
    if (!url) return res.status(400).json({ error: 'URL is required' });
    
    const normalizeUrl = (input: string) => {
      let trimmed = (input || '').trim();
      if (!trimmed) return trimmed;
      if (!/^https?:\/\//i.test(trimmed)) {
        trimmed = 'https://' + trimmed;
      }
      try {
        const urlObj = new URL(trimmed);
        if (urlObj.hostname === 'youtu.be') {
          const videoId = urlObj.pathname.substring(1);
          const searchParams = urlObj.search;
          trimmed = `https://www.youtube.com/watch?v=${videoId}${searchParams ? '&' + searchParams.substring(1) : ''}`;
        } else if (urlObj.hostname.includes('youtube.com') && urlObj.pathname.startsWith('/shorts/')) {
          const videoId = urlObj.pathname.split('/')[2];
          const searchParams = urlObj.search;
          trimmed = `https://www.youtube.com/watch?v=${videoId}${searchParams ? '&' + searchParams.substring(1) : ''}`;
        } else if (urlObj.hostname === 'm.youtube.com') {
          urlObj.hostname = 'www.youtube.com';
          trimmed = urlObj.toString();
        }
      } catch (e) {}
      return trimmed;
    };

    const targetUrl = normalizeUrl(url);
    const normalizedOrganicUrls = (organicUrls || []).map((u: string) => normalizeUrl(u));

    const session = getOrCreateSession(uid);
    if (session.isRunning) return res.status(400).json({ error: 'Bot is already running for this user' });
    if (useProxies && session.proxyList.length === 0) return res.status(400).json({ error: 'No proxies loaded.' });

    session.apiKeys = apiKeys;
    session.isRunning = true;
    session.logs = [];
    session.popupCloseCount = 0;
    const runId = Math.random().toString(36).substring(2, 15);
    session.currentRunId = runId;
    addLog(uid, `Starting ${trafficType.toUpperCase()} traffic bot for: ${targetUrl}`);

    (async () => {
      let completedSuccessfully = false;
      try {
        let currentProxyIndex = 0;

        for (let i = 0; i < visits; i++) {
          if (!session.isRunning) break;
          broadcastProgress(uid, i + 1, visits);
          addLog(uid, `Visit #${i + 1}/${visits} starting (Simulating new device)...`);

          let visitCompleted = false;
          let maxAttempts = useProxies ? Math.min(5, session.proxyList.length) : 1;
          if (maxAttempts < 1) maxAttempts = 1;

          for (let attempt = 0; attempt < maxAttempts; attempt++) {
            if (!session.isRunning) break;
            if (visitCompleted) break;

            if (attempt > 0) {
              addLog(uid, `Attempt #${attempt + 1}/${maxAttempts} for Visit #${i + 1} using next proxy...`);
            }

            const randomViewport = VIEWPORTS[Math.floor(Math.random() * VIEWPORTS.length)];
            const randomUA = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];

            try {
            const launchArgs = [
              '--no-sandbox',
              '--disable-setuid-sandbox',
              '--disable-dev-shm-usage',
              '--disable-blink-features=AutomationControlled',
              '--disable-infobars',
              '--window-position=0,0',
              '--ignore-certificate-errors',
              '--ignore-certificate-errors-spki-list',
              '--autoplay-policy=no-user-gesture-required',
              '--mute-audio',
              '--disable-ipv6',
              '--disable-gpu',
              '--disable-features=AudioServiceOutOfProcess',
            ];

            addLog(uid, `Visit #${i + 1} - Device: ${randomViewport.width}x${randomViewport.height}, UA: ...${randomUA.slice(-20)}`);

            let currentProxy = '';
            let proxyAuth: any = null;

            if (useProxies && session.proxyList.length > 0) {
              const rawProxy = session.proxyList[(i + currentProxyIndex) % session.proxyList.length];
              if (rawProxy.includes('@')) {
                const parts = rawProxy.split('@');
                const authParts = parts[0].split(':');
                currentProxy = parts[1];
                proxyAuth = { username: authParts[0], password: authParts[1] };
              } else {
                const parts = rawProxy.split(':');
                if (parts.length === 4) {
                  currentProxy = `${parts[0]}:${parts[1]}`;
                  proxyAuth = { username: parts[2], password: parts[3] };
                } else {
                  currentProxy = rawProxy;
                }
              }
              launchArgs.push(`--proxy-server=${currentProxy}`);
            }

            try {
              session.browser = await puppeteer.launch({
                headless: true,
                ignoreDefaultArgs: ['--enable-automation'],
                args: [
                  ...launchArgs,
                  `--window-size=${randomViewport.width},${randomViewport.height}`,
                  '--disable-web-security',
                  '--allow-running-insecure-content',
                ],
              }) as any;
            } catch (launchErr: any) {
              addLog(uid, `Failed to launch browser: ${launchErr.message}. Retrying...`);
              await new Promise(r => setTimeout(r, 3000));
              currentProxyIndex++; // Try next proxy on next attempt
              continue;
            }

            // Use a fresh incognito context for every visit to ensure no cookies/cache persist
            const context = await session.browser!.createBrowserContext();
            const page = await context.newPage();
            session.activePage = page;

            // Set up clean browser localization header
            try {
              await page.setExtraHTTPHeaders({
                'Accept-Language': 'en-US,en;q=0.9'
              });
            } catch (e) {}

            // Inject stealth properties to look like a 100% organic user browser
            try {
              await page.evaluateOnNewDocument(() => {
                // Remove navigator.webdriver flag
                Object.defineProperty(navigator, 'webdriver', {
                  get: () => undefined,
                });

                // Mock Chrome global object which is missing in headless/Puppeteer
                (window as any).chrome = {
                  runtime: {},
                  loadTimes: function() {},
                  csi: function() {},
                  app: {}
                };

                // Overwrite languages to match typical desktop browsers
                Object.defineProperty(navigator, 'languages', {
                  get: () => ['en-US', 'en'],
                });

                // Mock a normal list of browser plugins
                Object.defineProperty(navigator, 'plugins', {
                  get: () => [
                    { name: 'Chrome PDF Viewer', filename: 'mhjfbgodfjkljgedofcnpejinbobenim' },
                    { name: 'Chromium PDF Viewer', filename: 'internal-pdf-viewer' }
                  ],
                });

                // Mock WebGL vendor/renderer to avoid default SwiftShader graphics card detection
                const getParameter = WebGLRenderingContext.prototype.getParameter;
                WebGLRenderingContext.prototype.getParameter = function(parameter) {
                  // UNMASKED_VENDOR_WEBGL (37445)
                  if (parameter === 37445) {
                    return 'Intel Open Source Technology Center';
                  }
                  // UNMASKED_RENDERER_WEBGL (37446)
                  if (parameter === 37446) {
                    return 'Mesa DRI Intel(R) HD Graphics 620 (Kaby Lake GT2)';
                  }
                  return getParameter.call(this, parameter);
                };
              });
            } catch (e) {}
            
            // Clear any potential leftover data (though incognito should handle it)
            const cdpClient = await page.target().createCDPSession();
            await cdpClient.send('Network.clearBrowserCookies');
            await cdpClient.send('Network.clearBrowserCache');
            
            // Wipes out all local databases, storage, cache, service workers, cookies, etc.
            try {
              await cdpClient.send('Storage.clearDataForOrigin', {
                origin: '*',
                storageTypes: 'all'
              });
            } catch (storageErr) {}
            
            addLog(uid, "[CLEAN] Browser cookies, cache, local storage, and session history have been completely cleared (100% Clean Session).");
            
            if (proxyAuth) await page.authenticate(proxyAuth);

            const captureAndBroadcast = async (targetPage = session.activePage || page) => {
              if (!session.isRunning || !targetPage || targetPage.isClosed()) return;
              try {
                const base64 = await targetPage.screenshot({ encoding: 'base64', type: 'jpeg', quality: 75 });
                broadcastFrame(uid, base64, randomViewport.width, randomViewport.height);
                return base64;
              } catch (e) {
                return null;
              }
            };

            await page.setUserAgent(randomUA);
            await page.setViewport(randomViewport);

            if (useProxies && currentProxy) {
              addLog(uid, `Connecting and verifying proxy: ${currentProxy}...`);
              let verified = false;
              let ipInfo = '';
              
              // Try 1: HTTPS ipify
              try {
                await page.goto('https://api.ipify.org?format=json', { waitUntil: 'networkidle2', timeout: 8000 });
                ipInfo = await page.evaluate(() => document.body.innerText).catch(() => '');
                verified = true;
              } catch (err) {
                // Try 2: HTTP ipify (avoid SSL issues on certain proxies)
                try {
                  await page.goto('http://api.ipify.org?format=json', { waitUntil: 'networkidle2', timeout: 8000 });
                  ipInfo = await page.evaluate(() => document.body.innerText).catch(() => '');
                  verified = true;
                } catch (err2) {
                  // Try 3: AWS checkip (lightweight plain text)
                  try {
                    await page.goto('http://checkip.amazonaws.com', { waitUntil: 'networkidle2', timeout: 8000 });
                    ipInfo = await page.evaluate(() => document.body.innerText).catch(() => '');
                    verified = true;
                  } catch (err3) {}
                }
              }

              if (verified) {
                addLog(uid, `Proxy connection successful! External IP: ${ipInfo.trim()}`);
              } else {
                addLog(uid, `Proxy IP check timed out/blocked on ${currentProxy}. Proceeding to target URL to verify accessibility directly...`);
              }
            }

          let urlSequence = [targetUrl];
          if (trafficType === 'organic') {
            if (keywords && keywords.length > 0) {
              const randomKeyword = keywords[Math.floor(Math.random() * keywords.length)];
              addLog(uid, `Organic Search Mode: Searching for "${randomKeyword}" on Google...`);
              await page.goto('https://www.google.com', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
              await page.type('textarea[name="q"]', randomKeyword, { delay: 100 });
              await page.keyboard.press('Enter');
              await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
              
              addLog(uid, `Searching for target URL: ${targetUrl} in results...`);
              const found = await page.evaluate((targetUrlInput) => {
                const links = Array.from(document.querySelectorAll('a'));
                const targetLink = links.find(l => l.href.includes(targetUrlInput));
                if (targetLink) {
                  targetLink.scrollIntoView();
                  return true;
                }
                return false;
              }, targetUrl);

              if (found) {
                addLog(uid, "Target URL found in search results. Clicking...");
                await Promise.all([
                  page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {}),
                  page.evaluate((targetUrlInput) => {
                    const links = Array.from(document.querySelectorAll('a'));
                    const targetLink = links.find(l => l.href.includes(targetUrlInput));
                    if (targetLink) targetLink.click();
                  }, targetUrl)
                ]);
              } else {
                addLog(uid, "Target URL not found on first page of search results. Navigating directly.");
                await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
              }
            } else {
              urlSequence = [targetUrl, ...normalizedOrganicUrls].sort(() => Math.random() - 0.5);
            }
          }

          for (let uIdx = 0; uIdx < urlSequence.length; uIdx++) {
            if (!session.isRunning) break;
            const currentTargetUrl = urlSequence[uIdx];
            const isMainUrl = currentTargetUrl === targetUrl;
            const stepStartTime = Date.now();

            // Helper to check if YouTube is active
            const checkIsYouTube = () => {
              try {
                const currentUrl = page.url();
                return currentUrl.includes('youtube.com') || currentUrl.includes('youtu.be') || currentTargetUrl.includes('youtube.com') || currentTargetUrl.includes('youtu.be');
              } catch (e) {
                return currentTargetUrl.includes('youtube.com') || currentTargetUrl.includes('youtu.be');
              }
            };

            let navigationSuccessful = false;
            let lastErr: any = null;

            // YouTube Search by Title Flow
            if (targetType === 'youtube' && youtubeTitle && isMainUrl) {
              addLog(uid, `YouTube Search Mode: Navigating to YouTube to search for: "${youtubeTitle}"...`);
              try {
                await page.goto('https://www.youtube.com', { waitUntil: 'domcontentloaded', timeout: 25000 });
                await new Promise(r => setTimeout(r, 4000));
                await captureAndBroadcast();

                // Clear any cookie/consent prompt first
                await page.evaluate(() => {
                  const consentSelectors = [
                    '#introAgreeButton',
                    'button[aria-label*="Accept all"]',
                    'button[aria-label*="Agree"]',
                    'button#accept-button',
                    '#confirm-button',
                    'ytd-button-renderer.ytd-consent-bump-v2-renderer button'
                  ];
                  for (const sel of consentSelectors) {
                    const btn = document.querySelector(sel) as HTMLElement;
                    if (btn) btn.click();
                  }
                  
                  const consentForm = document.querySelector('form[action*="consent"]');
                  if (consentForm) {
                    const buttons = Array.from(consentForm.querySelectorAll('button'));
                    const targetBtn = buttons.find(b => {
                      const txt = b.innerText.toLowerCase();
                      return txt.includes('accept') || txt.includes('agree') || txt.includes('yes') || txt.includes('allow') || txt.includes('consent');
                    });
                    if (targetBtn) targetBtn.click();
                  }
                }).catch(() => {});

                // Type the video title into YouTube search bar
                const searchInputSelector = 'input[name="search_query"], input#search, input.ytd-searchbox';
                await page.waitForSelector(searchInputSelector, { timeout: 10000 });
                
                await page.evaluate((selector) => {
                  const input = document.querySelector(selector) as HTMLInputElement;
                  if (input) {
                    input.value = '';
                    input.focus();
                  }
                }, searchInputSelector);

                addLog(uid, `Typing search query: "${youtubeTitle}"...`);
                await page.type(searchInputSelector, youtubeTitle, { delay: 100 });
                await new Promise(r => setTimeout(r, 1000));
                await captureAndBroadcast();

                addLog(uid, "Submitting search...");
                await page.keyboard.press('Enter');
                await new Promise(r => setTimeout(r, 5000));
                await captureAndBroadcast();

                // Find video ID from the targetUrl
                let targetVideoId = '';
                try {
                  const urlObj = new URL(targetUrl);
                  targetVideoId = urlObj.searchParams.get('v') || '';
                } catch (e) {}

                addLog(uid, `Scanning search results for video matching ID "${targetVideoId || 'Any'}" or title...`);
                
                const clickSuccessful = await page.evaluate((videoId, titleText) => {
                  const links = Array.from(document.querySelectorAll('a'));
                  
                  // 1. Try matching video ID
                  if (videoId) {
                    const targetLink = links.find(l => l.href && l.href.includes(videoId));
                    if (targetLink) {
                      targetLink.scrollIntoView({ behavior: 'smooth', block: 'center' });
                      targetLink.click();
                      return true;
                    }
                  }
                  
                  // 2. Try matching title substring
                  if (titleText) {
                    const lowerTitle = titleText.toLowerCase();
                    const targetLink = links.find(l => {
                      const ariaLabel = (l.getAttribute('aria-label') || '').toLowerCase();
                      const titleAttr = (l.getAttribute('title') || '').toLowerCase();
                      const text = (l.textContent || '').toLowerCase();
                      const isVideoLink = l.href && (l.href.includes('/watch') || l.href.includes('/shorts/'));
                      return isVideoLink && (ariaLabel.includes(lowerTitle) || titleAttr.includes(lowerTitle) || text.includes(lowerTitle));
                    });
                    if (targetLink) {
                      targetLink.scrollIntoView({ behavior: 'smooth', block: 'center' });
                      targetLink.click();
                      return true;
                    }
                  }

                  // 3. Fallback to first video link
                  const firstVideoLink = links.find(l => l.href && l.href.includes('/watch') && l.getBoundingClientRect().width > 0);
                  if (firstVideoLink) {
                    firstVideoLink.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    firstVideoLink.click();
                    return true;
                  }

                  return false;
                }, targetVideoId, youtubeTitle).catch(() => false);

                if (clickSuccessful) {
                  addLog(uid, "Success: Found target video in search results. Clicked!");
                  await new Promise(r => setTimeout(r, 6000));
                  navigationSuccessful = true;
                } else {
                  addLog(uid, "Warning: Could not locate target video in search results. Navigating directly instead.");
                }
              } catch (searchErr: any) {
                addLog(uid, `YouTube search failed: ${searchErr.message}. Falling back to direct navigation.`);
              }
            }

            if (!navigationSuccessful) {
              addLog(uid, `Navigating to: ${currentTargetUrl}`);
              // Try with 'domcontentloaded' first (fast, bypasses video/ad stream hangs)
              try {
                await page.goto(currentTargetUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });
                navigationSuccessful = true;
              } catch (err: any) {
                lastErr = err;
                addLog(uid, `First navigation attempt with 'domcontentloaded' yielded: ${err.message}. Checking if loaded...`);
              }
            }

            // Check if page successfully navigated to a non-blank URL
            if (!navigationSuccessful) {
              try {
                const currentUrl = page.url();
                if (currentUrl !== 'about:blank' && !currentUrl.includes('chrome-error://')) {
                  addLog(uid, `Navigation threw but page loaded: ${currentUrl}. Proceeding...`);
                  navigationSuccessful = true;
                }
              } catch (e) {}
            }

            // Fallback retry with 'load' and shorter timeout
            if (!navigationSuccessful) {
              try {
                addLog(uid, `Retrying navigation with 'load' (15s timeout)...`);
                await page.goto(currentTargetUrl, { waitUntil: 'load', timeout: 15000 });
                navigationSuccessful = true;
              } catch (err: any) {
                lastErr = err;
                try {
                  const currentUrl = page.url();
                  if (currentUrl !== 'about:blank' && !currentUrl.includes('chrome-error://')) {
                    addLog(uid, `Proceeding anyway; URL changed to ${currentUrl}.`);
                    navigationSuccessful = true;
                  }
                } catch (e) {}
              }
            }

            // Ultimate fallback: check if body element exists in the DOM
            if (!navigationSuccessful) {
              await new Promise(r => setTimeout(r, 4000));
              const hasBody = await page.evaluate(() => !!document.body && document.body.innerText.length > 0).catch(() => false);
              if (hasBody) {
                addLog(uid, `Found active page body in browser. Proceeding anyway.`);
                navigationSuccessful = true;
              } else {
                throw lastErr || new Error("Navigation failed completely.");
              }
            }
            
            // Add a random initial delay to look more human
            const initialDelay = 3000 + Math.random() * 5000;
            await new Promise(r => setTimeout(r, initialDelay));
            
            // Special handling for YouTube to ensure player is ready and periodic ad skip
            let ytInterval: any = null;
            if (checkIsYouTube()) {
              addLog(uid, "YouTube detected. Starting background controller...");
              // Initial play button click
              try {
                await page.click('button.ytp-large-play-button').catch(() => {});
              } catch (e) {}

              ytInterval = setInterval(async () => {
                if (!session.isRunning || !page || page.isClosed()) {
                  if (ytInterval) clearInterval(ytInterval);
                  return;
                }
                try {
                  // Perform trusted native clicks for player controls to bypass autoplay and synthetic event blocks
                  try {
                    const playState = await page.evaluate(() => {
                      const video = document.querySelector('video');
                      const player = document.getElementById('movie_player');
                      
                      // Desktop & Mobile Large Play Buttons
                      const largePlaySelectors = [
                        'button.ytp-large-play-button',
                        '.ytp-large-play-button',
                        '.media-item-thumbnail-play-button',
                        'button[aria-label="Play video"]',
                        '.player-control-play-pause-button'
                      ];
                      
                      let largePlaySel = '';
                      for (const sel of largePlaySelectors) {
                        const btn = document.querySelector(sel) as HTMLElement;
                        if (btn && window.getComputedStyle(btn).display !== 'none') {
                          largePlaySel = sel;
                          break;
                        }
                      }

                      // Check if video is paused and needs a play action.
                      // We use YouTube's official player state if available:
                      // -1 = unstarted, 0 = ended, 1 = playing, 2 = paused, 3 = buffering, 5 = cued.
                      let needsPlay = false;
                      if (player && typeof (player as any).getPlayerState === 'function') {
                        const state = (player as any).getPlayerState();
                        needsPlay = (state === 2 || state === -1 || state === 5);
                      } else if (video) {
                        needsPlay = video.paused && !video.ended;
                      }

                      // If we need play, we can first try programmatic play inside the browser
                      if (needsPlay) {
                        try {
                          if (player && typeof (player as any).playVideo === 'function') {
                            (player as any).playVideo();
                          } else if (video) {
                            video.play().catch(() => {});
                          }
                        } catch (e) {}
                      }

                      // Check for skip button visibility
                      let skipSelector = '';
                      const skipSelectors = [
                        '.ytp-ad-skip-button',
                        '.ytp-ad-skip-button-modern',
                        '.ytp-skip-ad-button',
                        '.ytp-skip-ad-button-text',
                        '.ytp-ad-skip-button-container',
                        'button.ytp-ad-skip-button',
                        'button.ytp-skip-ad-button',
                        '.ytp-ad-skip-button-slot',
                        '.video-ads .ytp-ad-skip-button'
                      ];
                      for (const sel of skipSelectors) {
                        const btn = document.querySelector(sel) as HTMLElement;
                        if (btn && window.getComputedStyle(btn).display !== 'none') {
                          skipSelector = sel;
                          break;
                        }
                      }

                      return { largePlaySel, needsPlay, skipSelector };
                    }).catch(() => null);

                    if (playState) {
                      if (playState.largePlaySel) {
                        await page.click(playState.largePlaySel).catch(() => {});
                      }
                      if (playState.skipSelector) {
                        await page.click(playState.skipSelector).catch(() => {});
                      }
                    }
                  } catch (clickErr) {}

                  await page.evaluate(() => {
                    // 1. Bypass Cookie Consent & Before you continue dialogs
                    const consentForm = document.querySelector('form[action*="consent"]');
                    if (consentForm) {
                      const buttons = Array.from(consentForm.querySelectorAll('button'));
                      if (buttons.length > 0) {
                        const targetBtn = buttons.find(b => {
                          const txt = b.innerText.toLowerCase();
                          return txt.includes('accept') || txt.includes('agree') || txt.includes('yes') || txt.includes('allow') || txt.includes('accepter') || txt.includes('akzeptier') || txt.includes('co_sign') || txt.includes('consent');
                        }) || buttons[buttons.length - 1];
                        if (targetBtn) {
                          (targetBtn as HTMLElement).click();
                        }
                      }
                    }

                    const otherConsentButtons = [
                      '#introAgreeButton',
                      'button[aria-label*="Accept all"]',
                      'button[aria-label*="Agree"]',
                      'ytd-button-renderer.ytd-consent-bump-v2-renderer button',
                      'tp-yt-paper-button[aria-label*="Agree"]',
                      'button#accept-button',
                      '#confirm-button'
                    ];
                    for (const sel of otherConsentButtons) {
                      const btn = document.querySelector(sel) as HTMLElement;
                      if (btn && window.getComputedStyle(btn).display !== 'none') {
                        btn.click();
                      }
                    }

                    const allButtons = Array.from(document.querySelectorAll('button, [role="button"]'));
                    for (const btn of allButtons) {
                      const txt = (btn.textContent || '').trim().toLowerCase();
                      if (txt === 'accept all' || txt === 'i agree' || txt === 'agree' || txt === 'accept' || txt === 'allow' || txt === 'allow all') {
                        const hBtn = btn as HTMLElement;
                        if (window.getComputedStyle(hBtn).display !== 'none') {
                          hBtn.click();
                        }
                      }
                    }

                    // 2. Dismiss "Are you still there? Video paused" or "Continue watching?" (Bangla dialogs & deep container checks)
                    const confirmSelectors = [
                      'yt-formatted-string.style-blue-text',
                      'ytd-button-renderer#confirm-button',
                      '#confirm-button button',
                      '.yt-confirm-dialog-button',
                      'tp-yt-paper-button#button',
                      'yt-confirm-dialog-renderer button',
                      'paper-dialog button'
                    ];
                    for (const sel of confirmSelectors) {
                      const btn = document.querySelector(sel) as HTMLElement;
                      if (btn && window.getComputedStyle(btn).display !== 'none') {
                        btn.click();
                      }
                    }

                    // Find buttons in popups asking to reply/continue
                    const dialogs = document.querySelectorAll('ytd-popup-container, yt-confirm-dialog-renderer, paper-dialog, .yt-confirm-dialog-renderer, #dialog');
                    for (const dialog of Array.from(dialogs)) {
                      const buttons = dialog.querySelectorAll('button, tp-yt-paper-button, yt-button-renderer, yt-formatted-string, span, a');
                      for (const btn of Array.from(buttons)) {
                        const txt = (btn.textContent || '').trim().toLowerCase();
                        if (
                          txt.includes('yes') || 
                          txt.includes('keep watching') || 
                          txt.includes('continue') || 
                          txt.includes('হ্যাঁ') || 
                          txt.includes('চালিয়ে') || 
                          txt.includes('চালিয়ে') || 
                          txt.includes('দেখা') ||
                          txt.includes('ঠিক আছে') ||
                          txt.includes('অবিরত') ||
                          txt.includes('agree')
                        ) {
                          const hBtn = btn as HTMLElement;
                          if (window.getComputedStyle(hBtn).display !== 'none') {
                            hBtn.click();
                          }
                        }
                      }
                    }

                    // 2.1 Dismiss Premium/Sign-in popups ("No thanks", "Not now", "Dismiss", "না, ধন্যবাদ", "এখন নয়", "এখন নয়", "বাতিল করুন")
                    const dismissButtons = document.querySelectorAll('button, tp-yt-paper-button, yt-button-renderer, yt-formatted-string, span');
                    for (const btn of Array.from(dismissButtons)) {
                      const txt = (btn.textContent || '').trim().toLowerCase();
                      if (
                        txt === 'no thanks' ||
                        txt === 'not now' ||
                        txt === 'dismiss' ||
                        txt === 'skip' ||
                        txt === 'না, ধন্যবাদ' ||
                        txt === 'এখন নয়' ||
                        txt === 'এখন নয়' ||
                        txt === 'বাতিল করুন'
                      ) {
                        const hBtn = btn as HTMLElement;
                        if (window.getComputedStyle(hBtn).display !== 'none') {
                          hBtn.click();
                        }
                      }
                    }

                    // 3. Play control (Additional DOM Fallback - Idempotent Programmatic Play)
                    const video = document.querySelector('video');
                    const player = document.getElementById('movie_player');
                    
                    // Click YouTube large play button if it's visible
                    const largePlayBtn = document.querySelector('button.ytp-large-play-button') as HTMLElement;
                    if (largePlayBtn && window.getComputedStyle(largePlayBtn).display !== 'none') {
                      largePlayBtn.click();
                    }

                    // Idempotent play triggers
                    let needsPlay = false;
                    if (player && typeof (player as any).getPlayerState === 'function') {
                      const state = (player as any).getPlayerState();
                      needsPlay = (state === 2 || state === -1 || state === 5);
                    } else if (video) {
                      needsPlay = video.paused && !video.ended;
                    }

                    if (needsPlay) {
                      try {
                        if (player && typeof (player as any).playVideo === 'function') {
                          (player as any).playVideo();
                        } else if (video) {
                          video.play().catch(() => {});
                        }
                      } catch (e) {}
                    }

                    // Click skip ad button if visible (Additional DOM Fallback)
                    const skipSelectors = [
                      '.ytp-ad-skip-button',
                      '.ytp-ad-skip-button-modern',
                      '.ytp-skip-ad-button',
                      '.ytp-skip-ad-button-text',
                      '.ytp-ad-skip-button-container',
                      'button.ytp-ad-skip-button',
                      'button.ytp-skip-ad-button',
                      '.ytp-ad-skip-button-slot'
                    ];
                    
                    for (const sel of skipSelectors) {
                      const btn = document.querySelector(sel) as HTMLElement;
                      if (btn && window.getComputedStyle(btn).display !== 'none') {
                        btn.click();
                        break;
                      }
                    }
                  }).catch(() => {});

                  // Evaluate and broadcast video status
                  const videoStatus = await page.evaluate(() => {
                    const video = document.querySelector('video');
                    if (!video) return 'none';
                    if (video.seeking || video.readyState < 3) return 'buffering';
                    if (video.paused) return 'paused';
                    return 'playing';
                  }).catch(() => 'none');

                  const statusMessage = JSON.stringify({
                    type: 'video_status',
                    status: videoStatus,
                    uid
                  });
                  connectedClients.forEach(client => {
                    if (client.readyState === WebSocket.OPEN) {
                      client.send(statusMessage);
                    }
                  });

                  await captureAndBroadcast().catch(() => {});
                } catch (e) {}
              }, 1000);
            }
            
            await captureAndBroadcast(); // Immediate update after load

            const stepWaitTime = trafficType === 'organic' ? waitTime / urlSequence.length : waitTime;
            const cycleDuration = Math.min(600000, stepWaitTime);

            const autoCloseAds = async () => {
              if (!session.isRunning || !page || page.isClosed()) return false;
              try {
                return await page.evaluate((mode) => {
                  let closedCount = 0;
                  // Common ad selectors (X buttons, close text, etc.)
                  const selectors = [
                    'button[aria-label="Close"]', 'button[aria-label="dismiss"]',
                    'div[aria-label="Close"]', 'span[aria-label="Close"]',
                    '.close-button', '.close-btn', '.dismiss-button',
                    '#dismiss-button', '.skip-ad', '.ytp-ad-skip-button',
                    '.close-icon', '.close_icon', '.btn-close', '.ad-close',
                    '[id*="close"]', '[class*="close"]', '[id*="dismiss"]',
                    '[class*="dismiss"]', '[id*="skip"]', '[class*="skip"]',
                    'svg[class*="close"]', 'path[d*="M19 6.41"]',
                    '#close-button', '.close-wrapper', '.close-link',
                    '.ad-close-button', '.ad-dismiss', '.ad-skip',
                    '.ez-close-button', '.ez-dismiss', '.ez-skip',
                    '.sp-close-button', '.sp-dismiss', '.sp-skip',
                    '.qc-cmp2-close-icon', '.qc-cmp2-dismiss-button'
                  ];

                  // Look for elements that look like close buttons
                  const elements = document.querySelectorAll(selectors.join(','));
                  elements.forEach((el) => {
                    const htmlEl = el as HTMLElement;
                    const rect = htmlEl.getBoundingClientRect();
                    // Only click visible, small buttons (likely close buttons)
                    if (rect.width > 0 && rect.height > 0 && rect.width < 150 && rect.height < 150) {
                      htmlEl.click();
                      closedCount++;
                    }
                  });

                  // Also look for full-screen overlays and hide them
                  const overlays = Array.from(document.querySelectorAll('div, section, iframe, ins')).filter(el => {
                    const style = window.getComputedStyle(el);
                    const rect = el.getBoundingClientRect();
                    const isFixed = style.position === 'fixed' || style.position === 'absolute';
                    const isLarge = rect.width > window.innerWidth * 0.5 && rect.height > window.innerHeight * 0.5;
                    const isHighZ = style.zIndex && parseInt(style.zIndex) > 50;
                    
                    // Specific check for AdSense vignettes and other common ad iframes
                    const isAdSenseVignette = el.id?.includes('aswift') || el.className?.includes('adsbygoogle') || el.tagName === 'INS';
                    const isAdIframe = el.tagName === 'IFRAME' && (el.id?.includes('google_ads') || el.className?.includes('ad-iframe'));
                    
                    // Only hide blocking overlays that are clearly NOT the main content
                    // If it's a direct link, the "ad" might be the main content, so we are careful
                    return (isFixed && isLarge && isHighZ && style.backgroundColor !== 'transparent');
                  });

                  overlays.forEach(overlay => {
                    const htmlEl = overlay as HTMLElement;
                    htmlEl.style.display = 'none';
                    htmlEl.style.visibility = 'hidden';
                    htmlEl.style.opacity = '0';
                    htmlEl.style.pointerEvents = 'none';
                    closedCount++;
                  });

                  // We no longer hide ad containers in any mode to ensure compatibility with Direct Links (Montage, etc.)
                  // The AI will decide whether to click them or not.

                  return closedCount > 0;
                }, trafficType);
              } catch (e) {
                return false;
              }
            };

            let aiCycleCounter = 0;
            const runCycle = async () => {
              if (!session.isRunning || session.currentRunId !== runId || !page || page.isClosed()) return;
              try {
                // Always try automatic ad closing first to save AI credits
                const autoClosed = await autoCloseAds();
                if (autoClosed) {
                  addLog(uid, "Auto-Closer: Handled overlays/ads automatically.");
                  await captureAndBroadcast();
                  // If we auto-closed something, wait a bit before doing anything else
                  await new Promise(r => setTimeout(r, 2000));
                }

                aiCycleCounter++;
                // Call AI every 8 cycles instead of 5 to further save quota
                // Also skip AI if we just auto-closed something to be safe
                const isAiCycle = smartAI && (aiCycleCounter % 8 === 1) && !autoClosed;
                
                if (isAiCycle) {
                  const screenshot = await captureAndBroadcast();
                  if (screenshot) {
                    const decision = await requestAIDecision(uid, screenshot, randomViewport.width, randomViewport.height, session.popupCloseCount, trafficType);
                    if (decision) {
                      addLog(uid, `AI Decision: ${decision.action} - ${decision.reason}`);
                      broadcastAction(uid, decision.action);
                      
                      if (decision.action === 'CLICK_AD' || decision.action === 'CLOSE_POPUP' || decision.action === 'INTERACT') {
                        if (decision.x !== null && decision.y !== null && decision.x !== undefined && decision.y !== undefined) {
                          // Store current URL to detect same-tab navigation
                          const startUrl = page.url();

                          // Scroll element into view first for better reliability (only if NOT YouTube)
                          if (!checkIsYouTube()) {
                            await page.evaluate((x, y) => {
                              const el = document.elementFromPoint(x, y);
                              if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                            }, decision.x, decision.y).catch(() => {});
                            await new Promise(r => setTimeout(r, 1000));
                          }

                          // Re-capture coordinates after scroll
                          await captureAndBroadcast();
                          
                          // Add jitter and mouse movement
                          const jitterX = decision.x + (Math.random() * 10 - 5);
                          const jitterY = decision.y + (Math.random() * 10 - 5);
                          
                          if (session.browser) {
                            await page.bringToFront().catch(() => {});
                            await page.evaluate(() => window.focus()).catch(() => {});
                          }
                          
                          // Move mouse from a "distance" to the target
                          const startX = Math.random() * randomViewport.width;
                          const startY = Math.random() * randomViewport.height;
                          await page.mouse.move(startX, startY);
                          await page.mouse.move(jitterX, jitterY, { steps: 15 });
                          await new Promise(r => setTimeout(r, 500 + Math.random() * 500));
                          
                          let resolved = false;
                          const newPagePromise = new Promise<Page | null>(resolve => {
                            const timeout = setTimeout(() => {
                              if (!resolved) {
                                resolved = true;
                                if (session.browser) session.browser.off('targetcreated', listener);
                                resolve(null);
                              }
                            }, 15000);

                            const listener = (target: any) => {
                              if (target.type() === 'page' && !resolved) {
                                resolved = true;
                                clearTimeout(timeout);
                                if (session.browser) session.browser.off('targetcreated', listener);
                                resolve(target.page());
                              }
                            };
                            if (session.browser) session.browser.on('targetcreated', listener);
                            else resolve(null);
                          });

                          // Human-like click
                          await page.mouse.down();
                          await new Promise(r => setTimeout(r, 100 + Math.random() * 100));
                          await page.mouse.up();

                          // Wait for navigation or new tab
                          await new Promise(r => setTimeout(r, 5000));
                          
                          let openedPage = await newPagePromise;
                          let currentUrl = page.url();
                          let navigatedInSameTab = currentUrl !== startUrl;

                          // If no navigation detected yet, try a short wait for navigation
                          if (!openedPage && !navigatedInSameTab) {
                            await page.waitForNavigation({ timeout: 2000, waitUntil: 'domcontentloaded' }).catch(() => {});
                            currentUrl = page.url();
                            navigatedInSameTab = currentUrl !== startUrl;
                          }

                          if (!openedPage && !navigatedInSameTab && (decision.action === 'CLICK_AD' || decision.action === 'INTERACT')) {
                            addLog(uid, "Navigation not detected. Trying robust JS click...");
                            await page.evaluate((x, y) => {
                              const el = document.elementFromPoint(x, y) as HTMLElement;
                              if (el) {
                                // Check if it's likely a link or button
                                let target = el;
                                while (target && target.tagName !== 'A' && target.tagName !== 'BUTTON' && target.tagName !== 'BODY') {
                                  target = target.parentElement as HTMLElement;
                                }
                                
                                if (target && (target.tagName === 'A' || target.tagName === 'BUTTON' || el.onclick || el.getAttribute('role') === 'button')) {
                                  ['mousedown', 'mouseup', 'click'].forEach(evt => {
                                    el.dispatchEvent(new MouseEvent(evt, { bubbles: true, cancelable: true, view: window }));
                                  });
                                  if (target !== el) target.click();
                                }
                              }
                            }, jitterX, jitterY).catch(() => {});
                            
                            // Wait again after JS click
                            await new Promise(r => setTimeout(r, 5000));
                            openedPage = await newPagePromise;
                            currentUrl = page.url();
                            navigatedInSameTab = currentUrl !== startUrl;
                          }
                          
                          await page.waitForNetworkIdle({ timeout: 5000 }).catch(() => {});
                          
                          if (decision.action === 'CLOSE_POPUP') {
                            session.popupCloseCount++;
                            addLog(uid, `Popup closed (Total: ${session.popupCloseCount}).`);
                            
                            // Check if a new page was opened by mistake during CLOSE_POPUP
                            if (openedPage) {
                              addLog(uid, "Popup click opened an unwanted tab. Closing it...");
                              await openedPage.close().catch(() => {});
                            }

                            // Force hide element at coordinates
                            await page.evaluate((x, y) => {
                              const el = document.elementFromPoint(x, y);
                              if (el) {
                                const htmlEl = el as HTMLElement;
                                htmlEl.style.display = 'none';
                                htmlEl.style.visibility = 'hidden';
                                htmlEl.style.opacity = '0';
                                htmlEl.style.pointerEvents = 'none';
                                const parent = htmlEl.parentElement;
                                if (parent && (parent.offsetWidth < 500 || parent.offsetHeight < 500)) {
                                  parent.style.display = 'none';
                                }
                              }
                            }, jitterX, jitterY).catch(() => {});
                          } else {
                            // Handle navigation (either new tab or same tab)
                            if (openedPage || navigatedInSameTab) {
                              const targetPage = openedPage || page;
                              session.activePage = targetPage;
                              addLog(uid, `${decision.action === 'CLICK_AD' ? 'Ad' : 'Link'} opened. Simulating human visit...`);
                              
                              const visitWaitTime = 15000 + Math.random() * 15000; // 15-30 seconds
                              const visitStartTime = Date.now();
                              
                              let lastScrollTime = 0;
                              while (Date.now() - visitStartTime < visitWaitTime) {
                                if (!session.isRunning) break;
                                const isTargetYouTube = targetPage.url().includes('youtube.com') || targetPage.url().includes('youtu.be');
                                if (!isTargetYouTube && (Date.now() - lastScrollTime > 6000)) {
                                  const scrollAmt = Math.random() > 0.3 ? Math.random() * 500 : -(Math.random() * 200);
                                  await targetPage.evaluate((amt) => window.scrollBy({ top: amt, behavior: 'smooth' }), scrollAmt).catch(() => {});
                                  lastScrollTime = Date.now();
                                }
                                await captureAndBroadcast(targetPage);
                                await new Promise(r => setTimeout(r, 1000));
                              }
                              
                              if (openedPage) {
                                addLog(uid, "Closing ad/link tab and returning to main page.");
                                await openedPage.close().catch(() => {});
                              } else {
                                addLog(uid, "Navigating back to main page.");
                                await page.goBack().catch(() => {});
                              }
                              
                              session.activePage = page;
                              await captureAndBroadcast();
                            }
                          }
                        }
                      } else if (decision.action === 'SCROLL') {
                        if (!checkIsYouTube()) {
                          const scrollAmount = Math.random() > 0.3 ? 400 : -200;
                          await page.evaluate((amt) => window.scrollBy({ top: amt, behavior: 'smooth' }), scrollAmount);
                        } else {
                          addLog(uid, "YouTube active: Scroll action bypassed to keep player in focus.");
                        }
                      } else if (decision.action === 'WAIT') {
                        addLog(uid, "Simulating human reading/waiting...");
                        // Random mouse movement while waiting
                        for (let j = 0; j < 3; j++) {
                          const mx = Math.random() * randomViewport.width;
                          const my = Math.random() * randomViewport.height;
                          await page.mouse.move(mx, my, { steps: 20 }).catch(() => {});
                          await new Promise(r => setTimeout(r, 1000));
                        }
                      } else if (decision.action === 'NAVIGATE_BACK') {
                        addLog(uid, "Navigating back...");
                        await page.goBack({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
                      }
                    } else {
                      // Fallback if AI decision is null
                      if (!checkIsYouTube()) {
                        addLog(uid, "AI decision timed out or failed. Using fallback: SCROLL");
                        const scrollAmount = Math.random() > 0.3 ? 400 : -200;
                        await page.evaluate((amt) => window.scrollBy({ top: amt, behavior: 'smooth' }), scrollAmount);
                      } else {
                        addLog(uid, "AI decision timed out or failed. YouTube active: Bypassing scroll fallback.");
                        const mx = Math.random() * randomViewport.width;
                        const my = Math.random() * randomViewport.height;
                        await page.mouse.move(mx, my, { steps: 20 }).catch(() => {});
                      }
                    }
                  }
                } else {
                  // Non-AI cycle: Perform random human-like movement to save quota
                  const rand = Math.random();
                  if (rand > 0.4) {
                    if (!checkIsYouTube()) {
                      const scrollAmt = Math.random() > 0.3 ? 300 : -150;
                      broadcastAction(uid, 'SCROLL');
                      await page.evaluate((amt) => window.scrollBy({ top: amt, behavior: 'smooth' }), scrollAmt);
                    } else {
                      addLog(uid, "YouTube active: Bypassing non-AI scroll cycle.");
                      const mx = Math.random() * randomViewport.width;
                      const my = Math.random() * randomViewport.height;
                      await page.mouse.move(mx, my, { steps: 20 }).catch(() => {});
                    }
                  } else {
                    // Random mouse movement
                    addLog(uid, "Simulating human reading...");
                    const mx = Math.random() * randomViewport.width;
                    const my = Math.random() * randomViewport.height;
                    await page.mouse.move(mx, my, { steps: 20 }).catch(() => {});
                    await new Promise(r => setTimeout(r, 1000));
                  }
                  await captureAndBroadcast();
                }
                await captureAndBroadcast();
              } catch (e) {}

              if (session.isRunning && session.currentRunId === runId) {
                const nextDelay = 3000 + Math.random() * 4000; // Faster cycle: 3-7s
                setTimeout(runCycle, nextDelay);
              }
            };

            runCycle();

            while (session.isRunning && (Date.now() - stepStartTime < cycleDuration)) {
              await new Promise(r => setTimeout(r, 1000));
              await captureAndBroadcast().catch(() => {});
            }
            if (ytInterval) {
              clearInterval(ytInterval);
              ytInterval = null;
            }
            await page.close().catch(() => {});
          }

          if (session.browser) {
            addLog(uid, "Closing current browser session...");
            await session.browser.close().catch(() => {});
            session.browser = null;
          }
          
          session.currentScreenshot = null;
          broadcastFrame(uid, '', randomViewport.width, randomViewport.height);
          const interVisitDelay = 3000 + Math.random() * 5000;
          addLog(uid, `Success: Visit #${i + 1}/${visits} completed successfully!`);
          broadcastProgress(uid, i + 1, visits); // Update progress after completion
          addLog(uid, `Waiting ${Math.round(interVisitDelay/1000)}s before next visit...`);
          await new Promise(r => setTimeout(r, interVisitDelay)); 

          visitCompleted = true; // Mark as successful
        } catch (visitErr: any) {
          addLog(uid, `Attempt #${attempt + 1}/${maxAttempts} for Visit #${i + 1} failed: ${visitErr.message}`);
          if (session.browser) {
            addLog(uid, "Cleaning up browser session after failure...");
            await session.browser.close().catch(() => {});
            session.browser = null;
          }
          session.currentScreenshot = null;
          broadcastFrame(uid, '', randomViewport.width, randomViewport.height);
          
          currentProxyIndex++; // try next proxy in proxyList on next attempt loop
          
          const errorDelay = 4000;
          await new Promise(r => setTimeout(r, errorDelay));
        }
      }

    }
    if (session.isRunning) {
      completedSuccessfully = true;
    }
    } catch (err: any) {
        addLog(uid, `Error: ${err.message}`);
      } finally {
        if (completedSuccessfully) {
          addLog(uid, `Success: All ${visits} visits completed successfully!`);
        } else {
          addLog(uid, `Bot stopped or interrupted.`);
        }
        session.isRunning = false;
        session.currentScreenshot = null;
        session.activePage = null;
        if (session.browser) {
          await session.browser.close().catch(() => {});
          session.browser = null;
        }
        addLog(uid, 'Bot Engine Stopped.');
      }
    })();

    res.json({ message: 'Bot started' });
  });

  app.post('/api/stop', async (req, res) => {
    const { uid } = req.body;
    if (!uid) return res.status(400).json({ error: 'UID is required' });
    const session = getOrCreateSession(uid);
    session.isRunning = false;
    session.activePage = null;
    addLog(uid, 'Stopping bot requested. Closing browser and cleaning up...');
    if (session.browser) {
      try {
        await session.browser.close().catch(() => {});
      } catch (e) {}
      session.browser = null;
    }
    session.currentScreenshot = null;
    addLog(uid, 'Bot Engine Stopped immediately.');
    res.json({ message: 'Stop signal sent and session cleaned up' });
  });

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({ server: { middlewareMode: true }, appType: 'spa' });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => res.sendFile(path.join(distPath, 'index.html')));
  }

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[Server] Running on http://localhost:${PORT}`);
  });
}

startServer();
