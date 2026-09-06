(function () {
  /* ── PCM16 helpers ──────────────────────────────────────────────────── */

  function float32ToInt16(float32) {
    var int16 = new Int16Array(float32.length);
    for (var i = 0; i < float32.length; i++) {
      var s = Math.max(-1, Math.min(1, float32[i]));
      int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }
    return int16;
  }

  function bufToBase64(buffer) {
    var bytes = new Uint8Array(buffer);
    var bin = '';
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }

  function resample(input, fromRate, toRate) {
    if (fromRate === toRate) return input;
    var ratio = fromRate / toRate;
    var len = Math.round(input.length / ratio);
    var out = new Float32Array(len);
    for (var i = 0; i < len; i++) {
      var idx = i * ratio;
      var lo = Math.floor(idx);
      var hi = Math.min(lo + 1, input.length - 1);
      var frac = idx - lo;
      out[i] = input[lo] * (1 - frac) + input[hi] * frac;
    }
    return out;
  }

  /* ── Custom event helpers (app.js owns the actual DOM) ────────────────
     - 'echo:transcript-start' — a turn has begun (role + id); app.js
       creates an empty bubble positioned in the log immediately, so
       ordering is correct even though the real text arrives later.
     - 'echo:transcript-delta' — append streamed partial text to id.
     - 'echo:transcript' — finalize text for id (or append a standalone
       bubble when id is omitted). */

  function emitTranscriptStart(role, id) {
    document.dispatchEvent(new CustomEvent('echo:transcript-start', {
      detail: { role: role, id: id }
    }));
  }

  function emitTranscriptDelta(id, delta) {
    if (!delta) return;
    document.dispatchEvent(new CustomEvent('echo:transcript-delta', {
      detail: { id: id, delta: delta }
    }));
  }

  function emitTranscript(role, id, text) {
    if (!text || !text.trim()) return;
    document.dispatchEvent(new CustomEvent('echo:transcript', {
      detail: { role: role, id: id || null, text: text.trim() }
    }));
  }

  /* ── State ──────────────────────────────────────────────────────────── */

  var ws = null;
  var connectPromise = null; // resolves once the session is fully configured
  var micStream = null;
  var micAudioCtx = null;
  var micAnalyser = null;
  var micDataArray = null;
  var sourceNode = null;
  var processorNode = null;
  var muteNode = null;
  var active = false;
  var starting = false;
  var playbackCtx = null;
  var sessionConfigured = false;
  var textBuffer = '';
  var currentResponseId = null;
  var responseInProgress = false;
  var currentSource = null;
  var ttsAbortController = null;

  /* ── Persistent memory buffer (survives reconnects) ─────────────────── */
  var MEMORY_KEY = 'echo_memory';
  var MAX_MEMORY = 40;

  function loadMemory() {
    try {
      return JSON.parse(localStorage.getItem(MEMORY_KEY)) || [];
    } catch (_) { return []; }
  }

  function saveMemory(memory) {
    try { localStorage.setItem(MEMORY_KEY, JSON.stringify(memory)); } catch (_) {}
  }

  function addMemory(role, text) {
    if (!text || !text.trim()) return;
    var memory = loadMemory();
    memory.push({ role: role, text: text.trim(), ts: Date.now() });
    if (memory.length > MAX_MEMORY) memory = memory.slice(-MAX_MEMORY);
    saveMemory(memory);
  }

  function getMemoryContext() {
    var memory = loadMemory();
    if (!memory.length) return '';
    var lines = memory.map(function (m) {
      return (m.role === 'user' ? 'User' : 'Echo') + ': ' + m.text;
    });
    var ctx = '\n\nRecent conversation history:\n' + lines.join('\n');
    return ctx;
  }

  var lastVisionContext = '';
  var visionMessagePrefix = '[camera] ';

  function setVisionContext(description) {
    lastVisionContext = description;
    console.log('Vision context updated:', description);
    addMemory('user', '[camera] ' + description);
    // Inject as a conversation message so the model can see it
    if (ws && ws.readyState === WebSocket.OPEN && sessionConfigured) {
      ws.send(JSON.stringify({
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: visionMessagePrefix + description }]
        }
      }));
      console.log('Injected vision into conversation');
    } else {
      console.log('Cannot inject vision - ws:', !!ws, 'readyState:', ws && ws.readyState, 'sessionConfigured:', sessionConfigured);
    }
  }

  /* ── Playback context ──────────────────────────────────────────────── */

  function getPlaybackCtx() {
    if (!playbackCtx) {
      playbackCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (playbackCtx.state === 'suspended') {
      playbackCtx.resume();
    }
    return playbackCtx;
  }

  /* ── Stop any playing/queued TTS audio and cancel an in-flight response ─── */

  function interruptPlayback() {
    if (currentSource) {
      try { currentSource.stop(); } catch (_) {}
      currentSource = null;
    }
    if (ttsAbortController) {
      ttsAbortController.abort();
      ttsAbortController = null;
    }
    if (responseInProgress && ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'response.cancel' }));
    }
    textBuffer = '';
    currentResponseId = null;
  }

  /* ── Synthesize response text via Mistral TTS and play it ───────────── */

  function synthesizeAndPlaySpeech(text) {
    if (!text || !text.trim()) return;

    ttsAbortController = new AbortController();
    var thisController = ttsAbortController;

    fetch('/api/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: text }),
      signal: thisController.signal
    })
      .then(function (res) {
        if (!res.ok) {
          var err = new Error('TTS server error ' + res.status);
          err.status = res.status;
          throw err;
        }
        return res.arrayBuffer();
      })
      .then(function (buf) { return getPlaybackCtx().decodeAudioData(buf); })
      .then(function (audioBuffer) {
        if (ttsAbortController !== thisController) return;

        if (window.App.ErrorOverlay) window.App.ErrorOverlay.clear('tts');

        var ctx = getPlaybackCtx();
        var src = ctx.createBufferSource();
        src.buffer = audioBuffer;

        var analyser = ctx.createAnalyser();
        analyser.fftSize = 128;
        analyser.smoothingTimeConstant = 0.2;
        var dataArray = new Uint8Array(analyser.frequencyBinCount);

        src.connect(analyser);
        analyser.connect(ctx.destination);

        var playback = { paused: true };
        src.onended = function () {
          playback.paused = true;
          if (currentSource === src) currentSource = null;
        };

        if (window._visualizerConnect) {
          window._visualizerConnect(analyser, dataArray, playback);
        }

        if (window.App.EchoRobot) {
          window.App.EchoRobot.driveFromAnalyser(analyser, dataArray, playback);
        }

        currentSource = src;
        playback.paused = false;
        src.start(0);
        console.log('Playing TTS response');
      })
      .catch(function (err) {
        if (err.name === 'AbortError') return;
        console.error('TTS playback error:', err);
        if (window.App.ErrorOverlay) {
          var status = err.status || 0;
          if (status === 502 || status === 500) {
            window.App.ErrorOverlay.fetchStatus();
          } else if (status === 429) {
            window.App.ErrorOverlay.report('tts',
              'Rate limited',
              'Too many requests to the voice service.',
              '',
              8000
            );
          } else {
            window.App.ErrorOverlay.report('tts',
              'Voice playback failed',
              'Could not play audio response.',
              '',
              5000
            );
          }
        }
      });
  }

  /* ── Handle server messages ─────────────────────────────────────────── */

  function onServerMessage(msg) {
    console.log('Realtime event:', msg.type, msg);
    switch (msg.type) {
      case 'session.created':
        console.log('Realtime session created');
        break;
      case 'session.updated':
        console.log('Realtime session configured');
        sessionConfigured = true;
        break;

      // Fires the instant you start talking — item_id here is the same
      // one transcription events use later, so this is the earliest
      // reliable point to reserve your bubble's spot in the log.
      case 'input_audio_buffer.speech_started':
        console.log('Speech detected');
        interruptPlayback();
        if (msg.item_id) emitTranscriptStart('user', msg.item_id);
        break;
      case 'input_audio_buffer.speech_stopped':
        console.log('Speech ended');
        break;

      case 'conversation.item.input_audio_transcription.delta':
        if (msg.item_id) emitTranscriptDelta(msg.item_id, msg.delta);
        break;
      case 'conversation.item.input_audio_transcription.completed':
        emitTranscript('user', msg.item_id, msg.transcript);
        addMemory('user', msg.transcript);
        break;

      // Reserve the assistant's bubble spot immediately, before any
      // text has streamed in — same trick as speech_started above.
      case 'response.created':
        responseInProgress = true;
        textBuffer = '';
        currentResponseId = (msg.response && msg.response.id) || null;
        if (currentResponseId) emitTranscriptStart('assistant', currentResponseId);
        break;
      case 'response.output_text.delta':
        if (msg.delta) {
          textBuffer += msg.delta;
          emitTranscriptDelta(msg.response_id || currentResponseId, msg.delta);
        }
        break;
      case 'response.output_text.done':
        synthesizeAndPlaySpeech(textBuffer);
        emitTranscript('assistant', currentResponseId, textBuffer);
        addMemory('assistant', textBuffer);
        textBuffer = '';
        currentResponseId = null;
        break;
      case 'response.done':
        responseInProgress = false;
        break;
      case 'error':
        console.error('Realtime server error:', msg.error);
        if (window.App.ErrorOverlay) {
          var errMsg = (msg.error && msg.error.message) || 'Unknown error';
          if (errMsg.indexOf('response_cancel_not_active') === -1) {
            window.App.ErrorOverlay.fetchStatus();
          }
        }
        break;
    }
  }

  /* ── WebSocket connect ──────────────────────────────────────────────── */

  // Returns a promise that resolves once the session is fully configured
  // (not just once the socket is open) — safe to call from both mic
  // start and typed-message send; concurrent callers share one attempt.
  function connect() {
    if (connectPromise) return connectPromise;

    connectPromise = new Promise(function (resolve, reject) {
      var protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      ws = new WebSocket(protocol + '//' + location.host + '/api/realtime');

      ws.onopen = function () {
        console.log('Connected to realtime voice proxy');
        if (window.App.ErrorOverlay) window.App.ErrorOverlay.clear('realtime');
      };

      ws.onmessage = function (e) {
        try {
          var msg = JSON.parse(e.data);
          onServerMessage(msg);

          if (msg.type === 'session.created' && !sessionConfigured) {
            var personality = window.App && window.App.EchoPersonality
              ? window.App.EchoPersonality.personality.systemPrompt
              : 'You are Echo.';
            var memoryContext = getMemoryContext();
            var fullInstructions = personality + memoryContext;

            ws.send(JSON.stringify({
              type: 'session.update',
              session: {
                type: 'realtime',
                output_modalities: ['text'],
                instructions: fullInstructions,
                audio: {
                  input: {
                    format: { type: 'audio/pcm', rate: 24000 },
                    transcription: { model: 'whisper-1', language: 'en' },
                    turn_detection: {
                      type: 'server_vad',
                      threshold: 0.7,
                      prefix_padding_ms: 200,
                      silence_duration_ms: 400
                    }
                  }
                }
              }
            }));
          }

          if (msg.type === 'session.updated') {
            resolve(); // session ready — safe to send messages now
          }
        } catch (_) {}
      };

      ws.onerror = function (err) {
        console.error('Realtime WebSocket error:', err);
        connectPromise = null;
        if (window.App.ErrorOverlay) {
          window.App.ErrorOverlay.fetchStatus();
        }
        reject(err);
      };

      ws.onclose = function () {
        console.log('Realtime WebSocket closed');
        ws = null;
        sessionConfigured = false;
        connectPromise = null;
      };
    });

    return connectPromise;
  }

  /* ── Send a typed message through the same session as voice ─────────── */

  function sendText(text) {
    if (!text || !text.trim()) return Promise.resolve();
    addMemory('user', text);

    return connect().then(function () {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;

      ws.send(JSON.stringify({
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: text }]
        }
      }));
      ws.send(JSON.stringify({ type: 'response.create' }));
    });
  }

  /* ── Start mic capture ──────────────────────────────────────────────── */

  async function start() {
    if (active || starting) return;
    starting = true;

    try {
      await connect();

      micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      micAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (micAudioCtx.state === 'suspended') {
        await micAudioCtx.resume();
      }
      micAnalyser = micAudioCtx.createAnalyser();
      micAnalyser.fftSize = 128;
      micAnalyser.smoothingTimeConstant = 0.2;
      micDataArray = new Uint8Array(micAnalyser.frequencyBinCount);

      var micRate = micAudioCtx.sampleRate;
      sourceNode = micAudioCtx.createMediaStreamSource(micStream);
      sourceNode.connect(micAnalyser);

      processorNode = micAudioCtx.createScriptProcessor(2048, 1, 1);
      processorNode.onaudioprocess = function (e) {
        if (!ws || ws.readyState !== WebSocket.OPEN || !active) return;

        var input = e.inputBuffer.getChannelData(0);
        if (micRate !== 24000) {
          input = resample(input, micRate, 24000);
        }

        var pcm16 = float32ToInt16(input);
        var b64 = bufToBase64(pcm16.buffer);

        ws.send(JSON.stringify({
          type: 'input_audio_buffer.append',
          audio: b64
        }));
      };

      sourceNode.connect(processorNode);

      // ScriptProcessorNode needs a destination connection to keep firing
      // onaudioprocess reliably, but must not be audible — route it through
      // a silent gain node instead of the raw destination.
      muteNode = micAudioCtx.createGain();
      muteNode.gain.value = 0;
      processorNode.connect(muteNode);
      muteNode.connect(micAudioCtx.destination);

      active = true;
    } finally {
      starting = false;
    }
  }

  /* ── Stop ───────────────────────────────────────────────────────────── */

  function stop() {
    active = false;
    interruptPlayback();

    if (processorNode) { processorNode.disconnect(); processorNode = null; }
    if (muteNode) { muteNode.disconnect(); muteNode = null; }
    if (sourceNode) { sourceNode.disconnect(); sourceNode = null; }
    if (micStream) { micStream.getTracks().forEach(function (t) { t.stop(); }); micStream = null; }
    if (micAudioCtx) { micAudioCtx.close(); micAudioCtx = null; }
    micAnalyser = null;
    micDataArray = null;
  }

  function disconnect() {
    stop();
    if (ws) { ws.close(); ws = null; }
    sessionConfigured = false;
    connectPromise = null;
  }

  /* ── Expose ─────────────────────────────────────────────────────────── */

  window.App = window.App || {};
  window.App.EchoRealtime = {
    connect: connect,
    start: start,
    stop: stop,
    disconnect: disconnect,
    sendText: sendText,
    setVisionContext: setVisionContext,
    interruptPlayback: interruptPlayback,
    isActive: function () { return active; },
    getMicAnalyser: function () { return micAnalyser; },
    getMicDataArray: function () { return micDataArray; }
  };
})();