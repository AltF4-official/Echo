(function () {
  var overlay = null;
  var dismissTimer = null;
  var activeErrors = {};
  var statusPollTimer = null;

  var ERROR_SVG =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    '<circle cx="12" cy="12" r="10"/>' +
    '<line x1="12" y1="8" x2="12" y2="12"/>' +
    '<line x1="12" y1="16" x2="12.01" y2="16"/>' +
    '</svg>';

  function ensureOverlay() {
    if (overlay) return overlay;

    overlay = document.createElement('div');
    overlay.className = 'error-overlay';
    overlay.innerHTML =
      '<div class="error-overlay-card">' +
        '<div class="error-overlay-header">' +
          '<div class="error-overlay-icon-wrap">' + ERROR_SVG + '</div>' +
          '<div class="error-overlay-header-text">' +
            '<div class="error-overlay-title"></div>' +
            '<div class="error-overlay-status">' +
              '<span class="error-overlay-status-dot"></span>' +
              '<span class="error-overlay-status-text"></span>' +
            '</div>' +
          '</div>' +
        '</div>' +
        '<div class="error-overlay-body">' +
          '<div class="error-overlay-description"></div>' +
          '<a class="error-overlay-link" href="https://status.mistral.ai" target="_blank" rel="noopener"></a>' +
        '</div>' +
        '<div class="error-overlay-footer">' +
          '<span class="error-overlay-retry"></span>' +
          '<span class="error-overlay-checking">' +
            '<span class="error-overlay-checking-dot"></span>' +
            '<span class="error-overlay-checking-dot"></span>' +
            '<span class="error-overlay-checking-dot"></span>' +
            'Checking status' +
          '</span>' +
        '</div>' +
      '</div>';

    document.body.appendChild(overlay);
    return overlay;
  }

  function formatDuration(startedAt) {
    var diff = Date.now() - new Date(startedAt).getTime();
    var mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return mins + 'min';
    var hours = Math.floor(mins / 60);
    var remainMins = mins % 60;
    if (hours < 24) return hours + 'h ' + remainMins + 'min';
    var days = Math.floor(hours / 24);
    return days + 'd ' + (hours % 24) + 'h';
  }

  function showFromStatus(statusData) {
    var el = ensureOverlay();

    if (!statusData || !statusData.incidents || !statusData.incidents.length) {
      clear('mistral');
      return false;
    }

    var incident = statusData.incidents[0];
    var link = el.querySelector('.error-overlay-link');
    var isVoice = (incident.name || '').toLowerCase().indexOf('audio') !== -1 ||
                  (incident.name || '').toLowerCase().indexOf('tts') !== -1 ||
                  (incident.name || '').toLowerCase().indexOf('speech') !== -1;

    el.querySelector('.error-overlay-title').textContent = incident.name || 'Service Degraded';
    el.querySelector('.error-overlay-status-text').textContent =
      incident.status || 'Investigating';
    el.querySelector('.error-overlay-description').textContent =
      incident.description || 'Requests to the endpoint are experiencing degraded service.';

    if (isVoice) {
      link.textContent = 'View on status.mistral.ai';
      link.href = incident.url || 'https://status.mistral.ai';
      link.style.display = '';
    } else {
      link.style.display = 'none';
    }

    el.querySelector('.error-overlay-retry').textContent = 'Auto-refreshing...';
    el.classList.add('is-visible');
    return true;
  }

  function fetchStatus() {
    return fetch('/api/mistral-status')
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var hasIssue = showFromStatus(data);
        if (!hasIssue) clear('mistral');
        return data;
      });
  }

  function show(id, title, message, retryText) {
    var el = ensureOverlay();
    el.querySelector('.error-overlay-title').textContent = title || 'Something went wrong';
    el.querySelector('.error-overlay-status-text').textContent = message || '';
    el.querySelector('.error-overlay-description').textContent = '';
    el.querySelector('.error-overlay-link').style.display = 'none';
    el.querySelector('.error-overlay-retry').textContent = retryText || '';
    el.classList.add('is-visible');
  }

  function hide() {
    if (!overlay) return;
    overlay.classList.remove('is-visible');
  }

  function report(id, title, message, retryText, autoDismissMs) {
    activeErrors[id] = { title: title, message: message, retryText: retryText };
    show(id, title, message, retryText);

    if (dismissTimer) clearTimeout(dismissTimer);
    if (autoDismissMs) {
      dismissTimer = setTimeout(function () { clear(id); }, autoDismissMs);
    }
  }

  function clear(id) {
    delete activeErrors[id];
    if (dismissTimer) { clearTimeout(dismissTimer); dismissTimer = null; }

    var remaining = Object.keys(activeErrors);
    if (remaining.length === 0) {
      hide();
    } else {
      var next = activeErrors[remaining[0]];
      show(remaining[0], next.title, next.message, next.retryText);
    }
  }

  window.App = window.App || {};
  window.App.ErrorOverlay = {
    report: report,
    clear: clear,
    show: show,
    hide: hide,
    fetchStatus: fetchStatus
  };
})();
