const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');
let WebSocket;
try { WebSocket = require('ws'); } catch (_) { WebSocket = null; }

// Load .env and process.env
const env = Object.assign({}, process.env);
try {
  const envCandidates = [
    path.join(__dirname, '.env'),
    path.join(__dirname, '..', '.env')
  ];
  for (const envPath of envCandidates) {
    if (fs.existsSync(envPath)) {
      const raw = fs.readFileSync(envPath, 'utf8');
      raw.split('\n').forEach(function (line) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) return;
        const eq = trimmed.indexOf('=');
        if (eq === -1) return;
        const key = trimmed.slice(0, eq).trim();
        let value = trimmed.slice(eq + 1).trim();
        const isQuoted =
          (value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"));
        if (isQuoted) value = value.slice(1, -1);
        if (!env[key]) env[key] = value;
      });
    }
  }
} catch (_) {}

const MIME = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
};

// ---------------------------------------------------------------------------
// Mistral TTS helper
// ---------------------------------------------------------------------------

function mistralTTS(text) {
  return new Promise(function (resolve, reject) {
    const apiKey = env.MISTRAL_API_KEY || '';
    const voiceId = env.MISTRAL_TTS_VOICE || 'd7c90eab-0843-4a30-9b60-13b54d4decc7';
    if (!apiKey) return reject(new Error('MISTRAL_API_KEY not set'));

    const body = JSON.stringify({
      model: 'voxtral-mini-tts-2603',
      voice: voiceId,
      input: text,
      stream: false,
      response_format: 'wav',
    });

    const req = https.request(
      {
        hostname: 'api.mistral.ai',
        port: 443,
        path: '/v1/audio/speech',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + apiKey,
          'Content-Length': Buffer.byteLength(body),
        },
      },
      function (res) {
        const chunks = [];
        res.on('data', function (c) { chunks.push(c); });
        res.on('end', function () {
          if (res.statusCode !== 200) {
            return reject(new Error('TTS ' + res.statusCode + ': ' + Buffer.concat(chunks).toString()));
          }
          const buf = Buffer.concat(chunks);
          try {
            const json = JSON.parse(buf.toString());
            let b64 = null;
            if (json.audio_data) b64 = json.audio_data;
            else if (json.data && json.data.audio_data) b64 = json.data.audio_data;
            else if (json.data && typeof json.data === 'string') b64 = json.data;
            if (b64) {
              resolve(Buffer.from(b64, 'base64'));
            } else {
              resolve(buf);
            }
          } catch (_) {
            resolve(buf);
          }
        });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Request helpers
// ---------------------------------------------------------------------------

function readBody(req) {
  return new Promise(function (resolve, reject) {
    var body = '';
    req.on('data', function (c) { body += c; });
    req.on('end', function () { resolve(body); });
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const server = http.createServer(function (req, res) {
  var parsed = url.parse(req.url);
  var pathname = parsed.pathname;
  if (pathname === '/') pathname = '/index.html';

  // ── Favicon — return empty 1x1 ICO to avoid 404 noise ─────────────
  if (pathname === '/favicon.ico') {
    res.writeHead(204, { 'Content-Type': 'image/x-icon' });
    res.end();
    return;
  }

  // ── CORS preflight for API routes (must be first) ────────────────────
  if (req.method === 'OPTIONS' && pathname.startsWith('/api/')) {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    });
    res.end();
    return;
  }

  // ── OpenAI chat proxy ────────────────────────────────────────────────
  if (pathname === '/api/chat/completions' && req.method === 'POST') {
    readBody(req).then(function (body) {
      var apiBase = env.ECHO_API_BASE || 'https://api.openai.com/v1';
      var apiKey = env.ECHO_API_KEY || '';
      var apiUrl = new URL(apiBase + '/chat/completions');

      var proxyReq = https.request(
        {
          hostname: apiUrl.hostname,
          port: apiUrl.port || 443,
          path: apiUrl.pathname,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + apiKey,
          },
        },
        function (proxyRes) {
          res.writeHead(proxyRes.statusCode, {
            'Content-Type': proxyRes.headers['content-type'] || 'text/event-stream',
            'Access-Control-Allow-Origin': '*',
          });
          proxyRes.pipe(res);
        }
      );
      proxyReq.on('error', function (err) {
        console.error('Chat proxy error:', err);
        res.writeHead(502);
        res.end('Proxy error');
      });
      proxyReq.write(body);
      proxyReq.end();
    });
    return;
  }

  // ── Mistral TTS endpoint ─────────────────────────────────────────────
  if (pathname === '/api/tts' && req.method === 'POST') {
    readBody(req).then(function (body) {
      var text = '';
      try { text = JSON.parse(body).text || ''; } catch (_) {}
      if (!text.trim()) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'No text provided' }));
        return;
      }
      mistralTTS(text).then(function (wavBuf) {
        res.writeHead(200, {
          'Content-Type': 'audio/wav',
          'Access-Control-Allow-Origin': '*',
          'Content-Length': wavBuf.length,
        });
        res.end(wavBuf);
      }).catch(function (err) {
        console.error('TTS error:', err);
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      });
    });
    return;
  }

  // ── Mistral status proxy ─────────────────────────────────────────────
  if (pathname === '/api/mistral-status' && req.method === 'GET') {
    var summaryUrl = url.parse('https://status.mistral.ai/api/v1/summary.json');
    var servicesUrl = url.parse('https://status.mistral.ai/api/v1/services.json');

    var result = { incidents: [], audioApi: null };
    var done = 0;

    function checkDone() {
      done++;
      if (done < 2) return;
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(JSON.stringify(result));
    }

    https.get(summaryUrl.href, function (proxyRes) {
      var chunks = [];
      proxyRes.on('data', function (c) { chunks.push(c); });
      proxyRes.on('end', function () {
        try {
          var data = JSON.parse(Buffer.concat(chunks).toString());
          result.incidents = data.activeIncidents || [];
        } catch (_) {}
        checkDone();
      });
    }).on('error', function () { checkDone(); });

    https.get(servicesUrl.href, function (proxyRes) {
      var chunks = [];
      proxyRes.on('data', function (c) { chunks.push(c); });
      proxyRes.on('end', function () {
        try {
          var services = JSON.parse(Buffer.concat(chunks).toString());
          for (var i = 0; i < services.length; i++) {
            if (services[i].name === 'Audio API') {
              result.audioApi = {
                status: services[i].status,
                uptime: services[i].uptime || null
              };
              break;
            }
          }
        } catch (_) {}
        checkDone();
      });
    }).on('error', function () { checkDone(); });

    return;
  }

  // ── Vision endpoint — describe a camera frame ──────────────────────
  if (pathname === '/api/vision' && req.method === 'POST') {
    readBody(req).then(function (body) {
      var imageB64 = '';
      var prompt = 'Describe what you see in this image in one short sentence.';
      try {
        var parsed = JSON.parse(body);
        imageB64 = parsed.image || '';
        if (parsed.prompt) prompt = parsed.prompt;
      } catch (_) {}
      if (!imageB64) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'No image provided' }));
        return;
      }

      var apiKey = env.ECHO_API_KEY || '';
      var apiUrl = new URL((env.ECHO_API_BASE || 'https://api.openai.com/v1') + '/chat/completions');

      var visionBody = JSON.stringify({
        model: env.ECHO_MODEL || 'gpt-4o-mini',
        max_tokens: 150,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + imageB64, detail: 'low' } }
          ]
        }]
      });

      var visionReq = https.request({
        hostname: apiUrl.hostname,
        port: apiUrl.port || 443,
        path: apiUrl.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + apiKey,
        },
      }, function (proxyRes) {
        var chunks = [];
        proxyRes.on('data', function (c) { chunks.push(c); });
        proxyRes.on('end', function () {
          try {
            var data = JSON.parse(Buffer.concat(chunks).toString());
            var text = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content || '';
            res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
            res.end(JSON.stringify({ description: text }));
          } catch (e) {
            res.writeHead(502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Failed to parse vision response' }));
          }
        });
      });
      visionReq.on('error', function (err) {
        console.error('Vision proxy error:', err);
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      });
      visionReq.write(visionBody);
      visionReq.end();
    });
    return;
  }

  // ── index.html (inject env) ──────────────────────────────────────────
  if (pathname === '/index.html') {
    var filePath = path.join(__dirname, pathname);
    fs.readFile(filePath, 'utf8', function (err, html) {
      if (err) { res.writeHead(404); res.end('Not found'); return; }
      var envScript =
        '<script>window.ECHO_ENV=' +
        JSON.stringify({
          apiKey: env.ECHO_API_KEY || '',
          apiBase: '/api',
          model: env.ECHO_MODEL || '',
        }) +
        ';</script>';
      html = html.replace('<head>', '<head>' + envScript);
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(html);
    });
    return;
  }

  // ── Static files ─────────────────────────────────────────────────────
  var filePath = path.join(__dirname, pathname);
  fs.readFile(filePath, function (err, data) {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    var ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

// ---------------------------------------------------------------------------
// WebSocket proxy for GPT Realtime Mini
// ---------------------------------------------------------------------------

if (WebSocket) {
  var wss = new WebSocket.Server({ noServer: true });

  server.on('upgrade', function (request, socket, head) {
    var pathname = url.parse(request.url).pathname;
    if (pathname === '/api/realtime') {
      wss.handleUpgrade(request, socket, head, function (ws) {
        wss.emit('connection', ws, request);
      });
    } else {
      socket.destroy();
    }
  });

  wss.on('connection', function (clientWs) {
    var apiKey = env.ECHO_API_KEY || '';
    if (!apiKey) {
      clientWs.close(1008, 'API key not configured');
      return;
    }

    console.log('Client connected to realtime voice proxy');

    var openaiWs = new WebSocket(
      'wss://api.openai.com/v1/realtime?model=gpt-realtime-2.1',
      {
        headers: {
          'Authorization': 'Bearer ' + apiKey,
        }
      }
    );

    openaiWs.on('open', function () {
      console.log('Connected to OpenAI Realtime API');
    });

    clientWs.on('message', function (data, isBinary) {
      if (openaiWs.readyState === WebSocket.OPEN) {
        openaiWs.send(data, { binary: isBinary });
      }
    });

    openaiWs.on('message', function (data, isBinary) {
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(data, { binary: isBinary });
      }
    });

    clientWs.on('close', function () {
      console.log('Client disconnected from realtime voice');
      if (openaiWs.readyState === WebSocket.OPEN ||
          openaiWs.readyState === WebSocket.CONNECTING) {
        openaiWs.close();
      }
    });

    openaiWs.on('close', function (code, reason) {
      console.log('OpenAI WebSocket closed:', code);
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.close(code, reason ? reason.toString() : 'Upstream closed');
      }
    });

    openaiWs.on('error', function (err) {
      console.error('OpenAI WebSocket error:', err.message);
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.close(1011, 'Upstream error');
      }
    });
  });
} else {
  console.warn('ws package not installed — realtime voice disabled. Run: npm install ws');
}

server.listen(3000, '0.0.0.0', function () {
  console.log('Running at http://0.0.0.0:3000');
});