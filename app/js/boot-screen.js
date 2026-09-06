(function () {
  // Wires the Boot Screen's clock and dismiss interaction (click, tap, or
  // Enter/Space for keyboard users). Calls onDismiss exactly once.
  function initBootScreen(options) {
    const onDismiss = options.onDismiss;
    const bootScreen = document.getElementById("boot-screen");
    const timeEl = document.getElementById("boot-time");
    const dateEl = document.getElementById("boot-date");

    const unbindClock = App.Clock.bindClock(timeEl, dateEl);

    let dismissed = false;
    function handleDismiss() {
      if (dismissed) return;
      dismissed = true;
      unbindClock();
      bootScreen.removeEventListener("click", handleDismiss);
      bootScreen.removeEventListener("keydown", handleKeydown);
      onDismiss();
    }

    function handleKeydown(e) {
      if (e.key === "Enter" || e.key === " " || e.key === "Spacebar") {
        e.preventDefault();
        handleDismiss();
      }
    }

    bootScreen.addEventListener("click", handleDismiss);
    bootScreen.addEventListener("keydown", handleKeydown);
  }

  window.App = window.App || {};
  window.App.BootScreen = { initBootScreen };
})();