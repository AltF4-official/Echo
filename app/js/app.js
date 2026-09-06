(function () {
  document.addEventListener("DOMContentLoaded", function () {
    const bootScreen = document.getElementById("boot-screen");
    const mainScreen = document.getElementById("main-screen");
    const visualizerContainer = document.getElementById("visualizer-container");
    const micBtn = document.getElementById("mic-btn");
    const screenGlow = document.getElementById("screen-edge-glow");
    const cameraBtn = document.getElementById("camera-btn");
    const robotBtn = document.getElementById("robot-btn");
    const webcamFrame = document.getElementById("webcam-frame");
    const webcamVideo = document.getElementById("webcam-video");
    const chatBtn = document.getElementById("chat-btn");
    const echoChatForm = document.getElementById("echo-chat-form");
    const echoChatInput = document.getElementById("echo-chat-input");
    const echoChatLog = document.getElementById("echo-chat-log");

    const visualizer = App.AudioVisualizer.init(visualizerContainer);
    window._visualizerConnect = visualizer.connectAnalyser;
    const echoChat = App.EchoChat.init({
      form: echoChatForm,
      input: echoChatInput,
      log: echoChatLog
    });

    function revealMainScreen() {
      mainScreen.hidden = false;
      requestAnimationFrame(function () {
        mainScreen.classList.add("is-visible");
      });
    }

    App.BootScreen.initBootScreen({
      onDismiss: function () {
        bootScreen.classList.add("is-fading");

        window.setTimeout(function () {
          bootScreen.remove();
          revealMainScreen();
        }, 220);
      }
    });

    /* Transcript → chat log */
    const messageBubbles = {};

    document.addEventListener("echo:transcript-start", function (e) {
      const { role, id } = e.detail;
      const bubble = document.createElement("div");
      bubble.className = "echo-msg " + (role === "user" ? "is-user" : "is-echo");

      if (role === "assistant") {
        bubble.classList.add("is-streaming");
      }

      echoChatLog.appendChild(bubble);
      echoChatLog.scrollTop = echoChatLog.scrollHeight;

      if (id) {
        messageBubbles[id] = bubble;
      }
    });

    document.addEventListener("echo:transcript-delta", function (e) {
      const { id, delta } = e.detail;
      const bubble = messageBubbles[id];

      if (bubble) {
        bubble.textContent += delta;
        echoChatLog.scrollTop = echoChatLog.scrollHeight;
      }
    });

    document.addEventListener("echo:transcript", function (e) {
      const { role, id, text } = e.detail;
      if (!text) return;

      let bubble = id ? messageBubbles[id] : null;

      if (bubble) {
        bubble.textContent = text;
        bubble.classList.remove("is-streaming");
        delete messageBubbles[id];
      } else {
        bubble = document.createElement("div");
        bubble.className = "echo-msg " + (role === "user" ? "is-user" : "is-echo");
        bubble.textContent = text;
        echoChatLog.appendChild(bubble);
      }

      echoChatLog.scrollTop = echoChatLog.scrollHeight;
    });

    /* Microphone Integration — realtime voice mode */
    let isMicOn = false;

    async function toggleMic() {
      isMicOn = !isMicOn;

      if (isMicOn) {
        try {
          await ensureCameraStream();
          App.EchoRealtime.interruptPlayback();
          await App.EchoRealtime.start();
          startContinuousVision();
          micBtn.classList.add("is-active");
          screenGlow.classList.add("is-active");
          animateEdgeGlow();
        } catch (err) {
          console.error("Realtime voice failed:", err);
          isMicOn = false;
        }
      } else {
        stopContinuousVision();
        micBtn.classList.remove("is-active");
        screenGlow.classList.remove("is-active");
        screenGlow.style.boxShadow = "";
        App.EchoRealtime.stop();
      }
    }

    function animateEdgeGlow() {
      if (!isMicOn) return;

      var analyser = App.EchoRealtime.getMicAnalyser();
      var dataArray = App.EchoRealtime.getMicDataArray();
      if (!analyser || !dataArray) return;

      analyser.getByteFrequencyData(dataArray);
      let sum = 0;

      for (let i = 0; i < dataArray.length; i++) {
        sum += dataArray[i];
      }

      const avg = sum / dataArray.length;
      const intensity = avg / 255;

      const spread = 15 + intensity * 40;
      const blur = 2 + intensity * 15;
      const alpha = 0.15 + intensity * 0.35;

      screenGlow.style.boxShadow =
        `inset 0 0 ${spread}px ${blur}px rgba(255, 24, 48, ${alpha})`;

      requestAnimationFrame(animateEdgeGlow);
    }

    micBtn.addEventListener("click", toggleMic);

    robotBtn.addEventListener("click", function () {
      if (App.EchoRobot.isConnected()) {
        App.EchoRobot.disconnect(robotBtn);
      } else {
        App.EchoRobot.connect(robotBtn);
      }
    });

    /* Camera Integration — always on for AI, button only toggles local visibility */
    let camStream = null;
    let desiredCamOn = false;
    let desiredChatOn = false;
    let cameraRequestId = 0;
    let cameraCleanupTimer = null;

    function syncVisualizerDock() {
      visualizerContainer.classList.toggle(
        "is-docked",
        desiredCamOn && !desiredChatOn
      );
      visualizerContainer.classList.toggle("is-chat-mode", desiredChatOn);
    }

    function waitForVideoReady(videoEl) {
      return new Promise((resolve) => {
        if (videoEl.readyState >= 2) {
          resolve();
          return;
        }
        videoEl.addEventListener("loadeddata", () => resolve(), { once: true });
      });
    }

    function showCameraLoadingState() {
      window.clearTimeout(cameraCleanupTimer);
      cameraBtn.classList.add("is-active");
      syncVisualizerDock();
      mainScreen.classList.add("is-camera-loading");
    }

    function hideCameraState() {
      cameraBtn.classList.remove("is-active");
      syncVisualizerDock();
      webcamFrame.classList.remove("is-active");
      mainScreen.classList.remove("is-camera-loading");
    }

    async function ensureCameraStream() {
      if (camStream) return camStream;
      try {
        camStream = await navigator.mediaDevices.getUserMedia({ video: true });
        webcamVideo.srcObject = camStream;
        await waitForVideoReady(webcamVideo);
        await webcamVideo.play();
        if (window.App.ErrorOverlay) window.App.ErrorOverlay.clear('camera');
        return camStream;
      } catch (err) {
        console.error("Camera access denied:", err);
        if (window.App.ErrorOverlay) {
          window.App.ErrorOverlay.report('camera',
            'Camera access denied',
            'Enable camera permissions to use AI vision.',
            '',
            6000
          );
        }
        return null;
      }
    }

    async function showCamera() {
      await ensureCameraStream();
      webcamFrame.classList.add("is-active");
    }

    function hideCamera() {
      webcamFrame.classList.remove("is-active");
    }

    function toggleCamera() {
      desiredCamOn = !desiredCamOn;

      if (desiredCamOn) {
        showCameraLoadingState();
        showCamera().then(function () {
          requestAnimationFrame(function () {
            mainScreen.classList.remove("is-camera-loading");
          });
        });
      } else {
        hideCameraState();
      }
    }

    cameraBtn.addEventListener("click", toggleCamera);

    /* Continuous Vision — silently captures frames and injects into realtime voice */
    let visionTimer = null;
    let lastVisionDesc = '';

    function captureAndSendVision() {
      if (!camStream || !webcamVideo.videoWidth) return;
      if (!App.EchoRealtime.isActive || !App.EchoRealtime.isActive()) return;

      var canvas = document.createElement('canvas');
      canvas.width = 320;
      canvas.height = 240;
      var ctx = canvas.getContext('2d');
      ctx.drawImage(webcamVideo, 0, 0, 320, 240);
      var b64 = canvas.toDataURL('image/jpeg', 0.5).split(',')[1];
      if (!b64) return;

      fetch('/api/vision', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: b64, prompt: 'Describe what the person is doing or holding. One short sentence.' })
      })
        .then(function (r) { return r.json(); })
        .then(function (data) {
          if (data.description && data.description !== lastVisionDesc) {
            lastVisionDesc = data.description;
            if (App.EchoRealtime.setVisionContext) {
              App.EchoRealtime.setVisionContext(data.description);
            }
          }
        })
        .catch(function () {}); // silently fail
    }

    function startContinuousVision() {
      if (visionTimer) return;
      captureAndSendVision();
      visionTimer = window.setInterval(captureAndSendVision, 5000);
    }

    function stopContinuousVision() {
      if (visionTimer) {
        window.clearInterval(visionTimer);
        visionTimer = null;
      }
    }

    /* Chat Integration */
    function setChatActive(active) {
      desiredChatOn = active;

      chatBtn.classList.toggle("is-active", active);
      mainScreen.classList.toggle("is-chat-active", active);
      webcamFrame.classList.toggle("is-docked", active);
      syncVisualizerDock();

      if (active) {
        echoChat.onOpen();
        setTimeout(function () {
          echoChatInput.focus();
        }, 100);
      } else {
        echoChat.onClose();
      }
    }

    function toggleChat() {
      setChatActive(!desiredChatOn);
    }

    chatBtn.addEventListener("click", toggleChat);

    /* Start camera on load — always on for AI, button only toggles local visibility */
    ensureCameraStream();
  });
})();
