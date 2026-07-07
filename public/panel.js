(function() {
  'use strict';
  if (document.getElementById('ks-root')) return;

  // ====== INLINE SVG ICON (gear — matches Kimi UI style) ======
  var cogSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/></svg>';

  // ====== CREATE ROOT ======
  var root = document.createElement('div');
  root.id = 'ks-root';

  // Button — positioned in sidebar area, styled to match Kimi
  var btn = document.createElement('button');
  btn.id = 'ks-btn';
  btn.title = 'Provider Settings';
  btn.innerHTML = cogSvg + '<span>Provider Settings</span>';
  root.appendChild(btn);

  // Modal
  var modal = document.createElement('div');
  modal.id = 'ks-modal';
  modal.innerHTML =
    '<div id="ks-box">' +
      '<div id="ks-hd">' +
        '<h2>Provider Settings</h2>' +
        '<button onclick="ksC()" aria-label="Close">✕</button>' +
      '</div>' +
      '<div id="ks-bd">' +
        '<div id="ks-st"></div>' +
        '<div id="ks-l"></div>' +
        '<div id="ks-frm">' +
          '<label>Provider ID</label>' +
          '<input id="ks-id" placeholder="e.g. my-provider" spellcheck="false">' +
          '<label>Base URL</label>' +
          '<input id="ks-url" placeholder="https://api.example.com/v1" spellcheck="false">' +
          '<label>API Key</label>' +
          '<input id="ks-key" type="password" placeholder="sk-... (leave blank to keep existing)" spellcheck="false">' +
          '<div class="ks-f">' +
            '<button class="ks-s ks-p" onclick="ksS()">Save Provider</button>' +
            '<button class="ks-s ks-g" onclick="ksCf()">Clear</button>' +
          '</div>' +
        '</div>' +
      '</div>' +
      '<div id="ks-ft">' +
        '<button class="ks-s ks-p" onclick="ksR()">Restart Daemon</button>' +
        '<button class="ks-s ks-g" onclick="ksRef()">Refresh List</button>' +
      '</div>' +
    '</div>';
  root.appendChild(modal);
  document.body.appendChild(root);

  // ====== CLOSE ======
  window.ksC = function() {
    document.getElementById('ks-modal').classList.remove('ks-open');
  };

  // ====== OPEN ======
  btn.onclick = function(e) {
    e.stopPropagation();
    ksRef();
    document.getElementById('ks-modal').classList.add('ks-open');
  };

  // Close on overlay click
  modal.onclick = function(e) {
    if (e.target === this) ksC();
  };

  // Close on Escape
  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape' && modal.classList.contains('ks-open')) ksC();
  });

  // ====== CLEAR FORM ======
  window.ksCf = function() {
    document.getElementById('ks-id').value = '';
    document.getElementById('ks-url').value = '';
    document.getElementById('ks-key').value = '';
    document.getElementById('ks-st').style.display = 'none';
  };

  // ====== STATUS ======
  window.ksSt = function(msg, type) {
    var el = document.getElementById('ks-st');
    el.textContent = msg;
    el.className = type || 'ks-ok';
    el.style.display = 'block';
    if (type !== 'ks-wait') {
      setTimeout(function() { el.style.display = 'none'; }, 5000);
    }
  };

  // ====== REFRESH LIST ======
  window.ksRef = function() {
    var l = document.getElementById('ks-l');
    l.innerHTML = '<div class="ks-wait">Loading providers...</div>';
    fetch('/kimi-admin/providers').then(function(r) { return r.json(); }).then(function(d) {
      if (!d.success || !d.providers) {
        l.innerHTML = '<div class="ks-bad" style="padding:12px;text-align:center;border-radius:6px">Failed to load providers</div>';
        return;
      }
      if (d.providers.length === 0) {
        l.innerHTML = '<div style="color:var(--ks-faint);padding:12px;text-align:center;font-size:13px">No providers configured.</div>';
        return;
      }
      l.innerHTML = d.providers.map(function(p) {
        var canDel = (p.id !== 'opencode-zen' && p.id !== 'omniroute');
        var delBtn = canDel ? '<button class="ks-s ks-d" onclick="ksD(\'' + p.id.replace(/'/g, "\\'") + '\')">Del</button>' : '';
        var keyStatus = p.has_api_key
          ? '✅ ' + (p.api_key_masked || 'Key set')
          : '⚠️ No key';
        return '<div class="ks-r">' +
          '<div class="ks-i">' +
            '<div class="ks-n">' + escHtml(p.id) + '</div>' +
            '<div class="ks-dt">' + escHtml(p.base_url) + '</div>' +
            '<div class="ks-k">' + keyStatus + '</div>' +
          '</div>' +
          '<div class="ks-a">' +
            '<button class="ks-s ks-p" onclick="ksE(\'' + p.id.replace(/'/g, "\\'") + '\')">Edit</button>' +
            delBtn +
          '</div>' +
        '</div>';
      }).join('');
    }).catch(function(e) {
      l.innerHTML = '<div class="ks-bad" style="padding:12px;text-align:center;border-radius:6px">' + escHtml(e.message) + '</div>';
    });
  };

  // HTML escape helper
  function escHtml(s) {
    if (!s) return '';
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // ====== EDIT ======
  window.ksE = function(id) {
    document.getElementById('ks-id').value = id;
    document.getElementById('ks-url').value = '';
    document.getElementById('ks-key').value = '';
    document.getElementById('ks-st').style.display = 'none';
    // Fetch current provider data to fill URL
    fetch('/kimi-admin/providers').then(function(r) { return r.json(); }).then(function(d) {
      if (!d.success || !d.providers) return;
      var p = d.providers.find(function(x) { return x.id === id; });
      if (p) {
        document.getElementById('ks-url').value = p.base_url || '';
        document.getElementById('ks-em').textContent = 'Editing: ' + id;
      }
    }).catch(function() {});
  };

  // ====== SAVE ======
  window.ksS = function() {
    var id = document.getElementById('ks-id').value.trim();
    var url = document.getElementById('ks-url').value.trim();
    var key = document.getElementById('ks-key').value.trim();
    if (!id) { ksSt('Provider ID is required', 'ks-bad'); return; }
    if (!url) { ksSt('Base URL is required', 'ks-bad'); return; }
    var body = JSON.stringify({ id: id, type: 'openai', base_url: url, api_key: key });
    ksSt('Connecting to provider and discovering models...', 'ks-wait');
    fetch('/kimi-admin/providers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body
    }).then(function(r) { return r.json(); }).then(function(d) {
      if (d.success) {
        var msg = d.message || 'Saved! Restart daemon to apply.';
        if (d.models_discovered > 0) {
          msg = d.models_discovered + ' models discovered for "' + id + '". Restart daemon to use them.';
        }
        ksSt(msg, 'ks-ok');
        ksRef();
        ksCf();
      } else {
        ksSt('Error: ' + (d.error || 'Unknown error'), 'ks-bad');
      }
    }).catch(function(e) {
      ksSt('Error: ' + e.message, 'ks-bad');
    });
  };

  // ====== DELETE ======
  window.ksD = function(id) {
    if (!confirm('Delete provider "' + id + '"? This removes its models too.')) return;
    fetch('/kimi-admin/providers/' + encodeURIComponent(id), { method: 'DELETE' })
      .then(function(r) { return r.json(); })
      .then(function(d) {
        if (d.success) { ksSt('Deleted!', 'ks-ok'); ksRef(); }
        else { ksSt('Error: ' + (d.error || '?'), 'ks-bad'); }
      })
      .catch(function(e) { ksSt('Error: ' + e.message, 'ks-bad'); });
  };

  // ====== RESTART DAEMON ======
  window.ksR = function() {
    if (!confirm('Restart daemon? Active chats will briefly disconnect.')) return;
    ksSt('Restarting daemon...', 'ks-wait');
    fetch('/kimi-admin/restart-daemon', { method: 'POST' })
      .then(function(r) { return r.json(); })
      .then(function(d) {
        if (d.success) { ksSt('Restart initiated! Reconnecting...', 'ks-ok'); setTimeout(ksRef, 5000); }
        else { ksSt(d.message || 'Daemon not running', 'ks-bad'); }
      })
      .catch(function(e) { ksSt('Error: ' + e.message, 'ks-bad'); });
  };

  // ====== PERSISTENT SIDEBAR INJECTION ======
  // Kimi is a React SPA — it re-renders the sidebar on route navigation,
  // which removes injected DOM nodes. We keep a permanent MutationObserver
  // AND a periodic timer to re-inject the button whenever it goes missing.

  function isButtonPlaced() {
    var b = document.getElementById('ks-btn');
    return b && b.parentNode && b.parentNode !== root;
  }

  function injectButton() {
    var btn = document.getElementById('ks-btn');
    if (!btn) return false;
    if (btn.parentNode && btn.parentNode !== root) return true; // already placed

    // --- Strategy 1: Find by heading text ---
    var headings = document.querySelectorAll('h1, h2, h3, h4, h5, h6, strong, b, span, label, div');
    for (var i = 0; i < headings.length; i++) {
      var h = headings[i];
      var text = (h.textContent || '').trim();
      if (text === 'Session settings' || text === 'App preferences' || text === 'Sign out') {
        if (h.offsetParent !== null) {
          var parent = h.closest('[class*="content"], [class*="section"], [class*="group"], [class*="body"], [class*="inner"], section, div');
          if (!parent || parent === document.body || parent === document.documentElement) {
            parent = h.parentElement;
          }
          if (text === 'Sign out') {
            parent.parentElement.insertBefore(btn, parent);
          } else {
            parent.insertBefore(btn, parent.firstChild);
          }
          return true;
        }
      }
    }

    // --- Strategy 2: Find container by combined text ---
    var all = document.querySelectorAll('div, section, aside, nav');
    for (var i2 = 0; i2 < all.length; i2++) {
      var el = all[i2];
      if (el.offsetParent === null || el.children.length === 0) continue;
      var childrenText = '';
      for (var j = 0; j < el.children.length; j++) {
        childrenText += el.children[j].textContent || '';
      }
      if (childrenText.indexOf('Session settings') !== -1 && childrenText.indexOf('App preferences') !== -1) {
        el.insertBefore(btn, el.firstChild);
        return true;
      }
    }

    // --- Strategy 3: Class-based selectors ---
    var targets = [
      '[class*="sidebar"]', '[class*="Sidebar"]',
      '[class*="settings"]', '[class*="Settings"]',
      '[class*="panel"]', '[class*="Panel"]',
      '[data-testid*="sidebar"]',
      'nav', 'aside',
      '[class*="menu"]', '[class*="Menu"]',
      '[class*="navigation"]', '[class*="Navigation"]',
      '[class*="rail"]', '[class*="Rail"]'
    ];
    for (var k = 0; k < targets.length; k++) {
      var t = document.querySelector(targets[k]);
      if (t && t.offsetParent !== null) {
        t.appendChild(btn);
        return true;
      }
    }

    return false;
  }

  // Try immediately
  injectButton();

  // === Permanent observer — never disconnects ===
  // React re-renders the sidebar on every route change, which removes
  // our injected button. This observer catches those removals and
  // re-injects the button immediately.
  var permObs = new MutationObserver(function() {
    if (!isButtonPlaced()) {
      injectButton();
    }
    // Also check if modal providers list needs refresh
    if (modal.classList.contains('ks-open') && document.getElementById('ks-l').children.length <= 1) {
      ksRef();
    }
  });
  permObs.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true
  });

  // === Periodic safety net (every 2s) ===
  // Handles edge cases where the MutationObserver might miss a change.
  setInterval(function() {
    if (!isButtonPlaced()) {
      injectButton();
    }
  }, 2000);

  // === Floating fallback after 15s ===
  // If after 15 seconds the button is NOT in the sidebar (injection failed),
  // show it as a fixed floating button so it's always accessible.
  setTimeout(function() {
    if (!isButtonPlaced()) {
      var fb = document.getElementById('ks-btn');
      if (fb && fb.parentNode === root) {
        root.style.position = 'fixed';
        root.style.bottom = '20px';
        root.style.left = '12px';
        root.style.zIndex = '99998';
        root.style.maxWidth = '200px';
      }
    }
  }, 15000);

  // Initial load
  ksRef();
})();
