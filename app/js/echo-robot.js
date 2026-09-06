(function () {
  var port = null;
  var writer = null;
  var connected = false;
  var lastSentAt = 0;
  var lastAngle = 76;

  function setStatus(button, text, active) {
    if (!button) return;
    button.title = text;
    button.setAttribute('aria-label', text);
    button.classList.toggle('is-active', !!active);
  }

  function send(command) {
    if (!writer) return Promise.resolve();
    var bytes = new TextEncoder().encode(command + '\n');
    return writer.write(bytes).catch(function (error) {
      console.error('Echo robot write failed:', error);
      disconnect();
    });
  }

  async function connect(button) {
    if (!('serial' in navigator)) {
      setStatus(button, 'Serial is unavailable in this browser', false);
      return false;
    }

    try {
      port = await navigator.serial.requestPort();
      await port.open({ baudRate: 115200 });
      writer = port.writable.getWriter();
      connected = true;
      setStatus(button, 'Echo robot connected', true);
      await send('STATUS');
      return true;
    } catch (error) {
      console.error('Echo robot connection failed:', error);
      setStatus(button, 'Connect Echo robot', false);
      return false;
    }
  }

  async function disconnect(button) {
    if (writer) {
      await send('JAW AUTO');
      writer.releaseLock();
      writer = null;
    }
    if (port) {
      try { await port.close(); } catch (_) {}
      port = null;
    }
    connected = false;
    setStatus(button, 'Connect Echo robot', false);
  }

  function driveFromAnalyser(analyser, dataArray, playback) {
    if (!connected || !analyser || !dataArray) return;

    var timeData = new Uint8Array(analyser.fftSize);
    var active = true;

    function update() {
      if (!active || !connected) return;
      analyser.getByteTimeDomainData(timeData);

      var sum = 0;
      for (var i = 0; i < timeData.length; i++) {
        var sample = (timeData[i] - 128) / 128;
        sum += sample * sample;
      }

      var rms = Math.sqrt(sum / timeData.length);
      var openness = Math.min(1, rms * 5.5);
      var angle = 76 + openness * 30;
      var now = performance.now();

      if (now - lastSentAt >= 40 && Math.abs(angle - lastAngle) >= 0.5) {
        lastSentAt = now;
        lastAngle = angle;
        send('JAW ' + angle.toFixed(1));
      }

      if (playback && playback.paused) {
        active = false;
        send('JAW AUTO');
        return;
      }

      requestAnimationFrame(update);
    }

    update();
  }

  window.App = window.App || {};
  window.App.EchoRobot = {
    connect: connect,
    disconnect: disconnect,
    driveFromAnalyser: driveFromAnalyser,
    isConnected: function () { return connected; }
  };
})();