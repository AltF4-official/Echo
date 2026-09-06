(function () {
  function formatTime(date) {
    return date.toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    });
  }

  function formatDate(date) {
    return date
      .toLocaleDateString("en-US", {
        weekday: "long",
        month: "long",
        day: "numeric"
      })
      .toUpperCase();
  }

  // Reused offscreen canvas for text measurement (fitDateWidth mode).
  const measureCanvas = document.createElement("canvas");
  const measureCtx = measureCanvas.getContext("2d");

  function getTextWidth(text, font) {
    measureCtx.font = font;
    return measureCtx.measureText(text).width;
  }

  // Binds a live-updating clock to a time/date element pair. With
  // fitDateWidth, the date font size shrinks until its rendered width
  // matches the time element's width (used on the Main Screen clock).
  // Returns an unbind function that stops the interval.
  function bindClock(timeEl, dateEl, options) {
    const fitDateWidth = !!(options && options.fitDateWidth);

    function update() {
      const now = new Date();
      timeEl.textContent = formatTime(now);
      dateEl.textContent = formatDate(now);

      if (fitDateWidth) {
        const timeWidth = timeEl.getBoundingClientRect().width;
        if (timeWidth > 0) {
          let fontSize = 40;
          const fontFamily = window.getComputedStyle(dateEl).fontFamily;

          while (fontSize > 8) {
            const dateWidth = getTextWidth(dateEl.textContent, `${fontSize}px ${fontFamily}`);
            if (dateWidth <= timeWidth) break;
            fontSize -= 0.5;
          }

          dateEl.style.fontSize = `${fontSize}px`;
        }
      }
    }

    update();
    const intervalId = setInterval(update, 1000);
    window.addEventListener("resize", update);

    return function unbind() {
      clearInterval(intervalId);
      window.removeEventListener("resize", update);
    };
  }

  window.App = window.App || {};
  window.App.Clock = { bindClock };
})();