(function () {
  function initEchoChat(elements) {
    const form = elements.form;
    const input = elements.input;
    const log = elements.log;
    const sendBtn = form.querySelector(".echo-chat-send");

    const Personality = window.App.EchoPersonality;
    let hasGreeted = false;

    function autoResize() {
      input.style.height = 'auto';
      const computed = window.getComputedStyle(input);
      const lineHeight = parseFloat(computed.lineHeight) || 21;
      const maxLines = 5;
      const maxHeight = lineHeight * maxLines;
      const newHeight = Math.min(input.scrollHeight, maxHeight);
      input.style.height = newHeight + 'px';
    }

    function updateSendButton() {
      const hasText = input.value.trim().length > 0;
      sendBtn.disabled = !hasText;
    }

    input.addEventListener('input', function () {
      autoResize();
      updateSendButton();
    });

    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (!sendBtn.disabled) {
          form.requestSubmit();
        }
      }
    });

    function scrollToBottom() {
      requestAnimationFrame(function () {
        log.scrollTop = log.scrollHeight;
      });
    }

    function appendMessage(role, text) {
      const bubble = document.createElement("div");
      bubble.className = "echo-msg " + (role === "user" ? "is-user" : "is-echo");
      bubble.textContent = text;
      log.appendChild(bubble);
      scrollToBottom();
      return bubble;
    }

    function onOpen() {
      // Local-only UI greeting — not sent to the model. There's now a
      // single shared conversation living in the realtime session (see
      // echo-realtime.js), so Echo doesn't need this repeated to it.
      if (!hasGreeted && Personality.personality.greeting) {
        appendMessage("assistant", Personality.personality.greeting);
      }
      hasGreeted = true;
    }

    function onClose() {}

    form.addEventListener("submit", function (e) {
      e.preventDefault();

      const text = input.value.trim();
      if (!text) return;

      input.value = "";
      autoResize();
      updateSendButton();

      // Interrupt any playing TTS before sending
      if (window.App.EchoRealtime) {
        window.App.EchoRealtime.interruptPlayback();
      }

      // Capture a vision frame right before sending, so the AI has
      // fresh visual context for the typed message.
      if (window._captureVisionFrame) {
        window._captureVisionFrame();
      }

      // Goes through the same realtime session voice mode uses, so
      // typed and spoken turns share one conversation — the reply
      // streams back into the log via the shared listener in app.js,
      // exactly like a voice reply does.
      appendMessage("user", text);
      window.App.EchoRealtime.sendText(text).catch(function (err) {
        console.error("Echo send failed:", err);
        appendMessage("assistant", "Couldn't reach Echo — check the realtime connection.");
      });

      input.focus();
    });

    return { onOpen: onOpen, onClose: onClose };
  }

  window.App = window.App || {};
  window.App.EchoChat = { init: initEchoChat };
})();