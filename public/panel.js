(function() {
  'use strict';
  if (document.getElementById('ks-injected')) return;

  var KS_ID = 'ks-injected';
  var modal = null;
  var currentProviders = [];

  // ====== SVG ICONS ======
  var cogSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/></svg>';

  // ====== MARK INJECTED ======
  var mark = document.createElement('meta');
  mark.id = KS_ID;
  document.head.appendChild(mark);

  // ====== BUILD MODAL ======
  function buildModal() {
    if (modal && modal.parentNode) return modal;
    modal = document.createElement('div');
    modal.id = 'ks-modal';
    modal.style.cssText = 'position:fixed;inset:0;z-index:99999;display:none;align-items:center;justify-content:center;background:rgba(0,0,0,0.5);backdrop-filter:blur(2px);';
    modal.innerHTML =
      '<div id="ks-box" style="background:var(--color-surface-raised, #1c2128);border:1px solid var(--color-line, #2d333b);border-radius:var(--radius-xl, 12px);box-shadow:var(--shadow-xl, 0 8px 32px rgba(0,0,0,0.5));width:min(440px,calc(100vw-32px));max-height:min(420px,calc(100vh-40px));display:flex;flex-direction:column;color:var(--color-text,#c9cdd4);font-family:var(--font-family,-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif);overflow:hidden;animation:ks-fade-in 0.15s ease;">' +
        '<div style="display:flex;align-items:center;justify-content:space-between;padding:10px 14px 6px;border-bottom:1px solid var(--color-line,#2d333b);flex-shrink:0;">' +
          '<h2 style="margin:0;font-size:13px;font-weight:600;color:var(--color-text,#c9cdd4);">Provider Settings</h2>' +
          '<button onclick="ksC()" aria-label="Close" style="background:none;border:none;color:var(--color-text-faint,#6b7280);font-size:14px;cursor:pointer;padding:2px 6px;border-radius:var(--radius-md,6px);line-height:1;">✕</button>' +
        '</div>' +
        '<div style="padding:8px 10px 8px;overflow-y:auto;flex:1;min-height:0;">' +
          '<div id="ks-st" style="font-size:10px;padding:4px 6px;border-radius:4px;margin-bottom:6px;display:none;line-height:1.2;"></div>' +
          '<div id="ks-l" style="display:flex;flex-direction:column;gap:3px;margin-bottom:6px;overflow-y:auto;max-height:120px;flex-shrink:0;"></div>' +
          '<div id="ks-frm" style="flex-shrink:0;">' +
            '<label style="display:block;margin:0 0 2px;font-size:9px;font-weight:500;color:var(--color-text-muted,#9aa0a8);text-transform:uppercase;letter-spacing:0.04em;">Provider ID</label>' +
            '<input id="ks-id" placeholder="e.g. my-provider" spellcheck="false" style="width:100%;padding:5px 7px;margin-bottom:5px;border:1px solid var(--color-line,#2d333b);border-radius:4px;background:var(--color-surface,#161b22);color:var(--color-text,#c9cdd4);font-size:11px;box-sizing:border-box;outline:none;">' +
            '<label style="display:block;margin:0 0 2px;font-size:9px;font-weight:500;color:var(--color-text-muted,#9aa0a8);text-transform:uppercase;letter-spacing:0.04em;">Base URL</label>' +
            '<input id="ks-url" placeholder="https://api.example.com/v1" spellcheck="false" style="width:100%;padding:5px 7px;margin-bottom:5px;border:1px solid var(--color-line,#2d333b);border-radius:4px;background:var(--color-surface,#161b22);color:var(--color-text,#c9cdd4);font-size:11px;box-sizing:border-box;outline:none;">' +
            '<label style="display:block;margin:0 0 2px;font-size:9px;font-weight:500;color:var(--color-text-muted,#9aa0a8);text-transform:uppercase;letter-spacing:0.04em;">API Key</label>' +
            '<input id="ks-key" type="password" placeholder="sk-... (leave blank to keep existing)" spellcheck="false" style="width:100%;padding:5px 7px;margin-bottom:5px;border:1px solid var(--color-line,#2d333b);border-radius:4px;background:var(--color-surface,#161b22);color:var(--color-text,#c9cdd4);font-size:11px;box-sizing:border-box;outline:none;">' +
            '<div style="display:flex;gap:4px;margin-top:2px;">' +
              '<button class="ks-s ks-p" onclick="ksS()" style="flex:1;padding:5px;font-size:10px;font-weight:600;text-align:center;background:var(--color-accent,#58a6ff);color:#fff;border:none;border-radius:4px;cursor:pointer;">Save Provider</button>' +
              '<button class="ks-s ks-g" onclick="ksCf()" style="flex:1;padding:5px;font-size:10px;font-weight:600;text-align:center;background:var(--color-line,#2d333b);color:var(--color-text,#c9cdd4);border:1px solid var(--color-line,#3d444d);border-radius:4px;cursor:pointer;">Clear</button>' +
            '</div>' +
          '</div>' +
        '</div>' +
        '<div style="display:flex;gap:3px;padding:6px 10px 8px;border-top:1px solid var(--color-line,#2d333b);">' +
          '<button class="ks-s ks-p" onclick="ksR()" style="flex:1;padding:5px 8px;font-size:10px;font-weight:500;text-align:center;background:var(--color-accent,#58a6ff);color:#fff;border:none;border-radius:4px;cursor:pointer;">Restart Daemon</button>' +
          '<button class="ks-s ks-g" onclick="ksRef()" style="flex:1;padding:5px 8px;font-size:10px;font-weight:500;text-align:center;background:var(--color-line,#2d333b);color:var(--color-text,#c9cdd4);border:1px solid var(--color-line,#3d444d);border-radius:4px;cursor:pointer;">Refresh List</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(modal);

    // Close on overlay click
    modal.onclick = function(e) {
      if (e.target === this) ksC();
    };

    // Close on Escape
    document.addEventListener('keydown', function(e) {
      if (e.key === 'Escape' && modal.style.display === 'flex') ksC();
    });

    return modal;
  }

  // ====== INJECT ROW INTO SETTINGS PANEL ======
  function injectSettingsRow() {
    // Remove any existing injected row first
    var existing = document.getElementById('ks-srow');
    if (existing) existing.remove();

    // Find "Sign out" element — look for it by text content (robust)
    var allNodes = document.querySelectorAll('button, a, div, span, label, [class*="acct"], [class*="sign"], [class*="out"]');
    var signOutEl = null;
    for (var i = 0; i < allNodes.length; i++) {
      var el = allNodes[i];
      var txt = (el.textContent || '').trim();
      if (txt === 'Sign out' || txt === 'Sign Out') {
        signOutEl = el;
        break;
      }
    }

    if (!signOutEl) return false;

    // If we found a leaf text element, climb up to a reasonable parent row
    var parent = signOutEl.closest('button, a, [role="menuitem"], [class*="acct"], [class*="srow"]');
    if (parent && parent !== signOutEl) signOutEl = parent;

    // Create provider settings row matching Kimi's row style
    var row = document.createElement('div');
    row.id = 'ks-srow';
    row.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:8px 16px;cursor:pointer;border-top:1px solid var(--color-line,#2d333b);transition:background 0.15s;';

    var left = document.createElement('div');
    left.style.cssText = 'flex:1;min-width:0;';
    left.innerHTML = '<div style="font-size:13px;font-weight:500;color:var(--color-text,#c9cdd4);">Provider Settings</div>' +
      '<div style="font-size:11px;color:var(--color-text-muted,#9aa0a8);margin-top:1px;">Manage custom LLM providers</div>';

    var right = document.createElement('div');
    right.style.cssText = 'display:flex;align-items:center;gap:4px;color:var(--color-text-faint,#6b7280);font-size:13px;';
    right.innerHTML = cogSvg;

    row.appendChild(left);
    row.appendChild(right);

    row.onclick = function(e) {
      e.stopPropagation();
      e.preventDefault();
      buildModal();
      modal.style.display = 'flex';
      ksRef();
    };

    row.onmouseenter = function() { this.style.background = 'var(--color-surface,#161b22)'; };
    row.onmouseleave = function() { this.style.background = 'transparent'; };

    // Insert before Sign out
    signOutEl.parentNode.insertBefore(row, signOutEl);
    return true;
  }

  // ====== TRY INJECTION — immediate + observer + retry ======
  function tryInject() {
    if (injectSettingsRow()) return true;

    // MutationObserver — catches SolidJS re-renders
    if (!window._ksObs) {
      window._ksObs = new MutationObserver(function() {
        if (!document.getElementById('ks-srow')) {
          injectSettingsRow();
        }
      });
      window._ksObs.observe(document.body, { childList: true, subtree: true });
    }

    // Also retry periodically for 10s
    var retries = 0;
    var maxRetries = 10;
    var iv = setInterval(function() {
      retries++;
      if (injectSettingsRow() || retries >= maxRetries) {
        clearInterval(iv);
      }
    }, 500);

    return false;
  }

  // Try immediately on page load
  tryInject();

  // Also try whenever user clicks anywhere (catches settings panel opening)
  document.addEventListener('click', function(e) {
    // Skip if click is inside our modal
    if (modal && modal.style.display === 'flex' && modal.contains(e.target)) return;
    setTimeout(function() {
      if (!document.getElementById('ks-srow')) {
        injectSettingsRow();
      }
    }, 800);
  }, true);

  // Periodic injection check for 30s after page load (handles SPA re-renders)
  (function periodicInject() {
    var checks = 0;
    var maxChecks = 15;
    var iv2 = setInterval(function() {
      checks++;
      if (!document.getElementById('ks-srow')) {
        injectSettingsRow();
      }
      if (checks >= maxChecks) clearInterval(iv2);
    }, 2000);
  })();

  // ====== CLOSE ======
  window.ksC = function() {
    if (modal) modal.style.display = 'none';
  };

  // ====== CLEAR FORM ======
  window.ksCf = function() {
    document.getElementById('ks-id').value = '';
    document.getElementById('ks-url').value = '';
    document.getElementById('ks-key').value = '';
    var st = document.getElementById('ks-st');
    if (st) st.style.display = 'none';
  };

  // ====== STATUS ======
  window.ksSt = function(msg, type) {
    var el = document.getElementById('ks-st');
    if (!el) return;
    el.textContent = msg;
    el.className = type || 'ks-ok';
    el.style.display = 'block';
    if (type === 'ks-ok') {
      el.style.background = 'rgba(63,185,80,0.1)';
      el.style.color = 'var(--color-success,#3fb950)';
      el.style.border = '1px solid rgba(63,185,80,0.25)';
    } else if (type === 'ks-bad') {
      el.style.background = 'rgba(248,81,73,0.1)';
      el.style.color = 'var(--color-danger,#f85149)';
      el.style.border = '1px solid rgba(248,81,73,0.25)';
    } else if (type === 'ks-wait') {
      el.style.background = 'transparent';
      el.style.color = 'var(--color-text-muted,#9aa0a8)';
      el.style.border = 'none';
      el.style.textAlign = 'center';
      el.style.padding = '20px';
    } else {
      el.style.background = 'rgba(63,185,80,0.1)';
      el.style.color = 'var(--color-success,#3fb950)';
      el.style.border = '1px solid rgba(63,185,80,0.25)';
    }
    if (type !== 'ks-wait') {
      setTimeout(function() { el.style.display = 'none'; }, 5000);
    }
  };

  // ====== REFRESH LIST ======
  window.ksRef = function() {
    var l = document.getElementById('ks-l');
    if (!l) return;
    l.innerHTML = '<div style="color:var(--color-text-muted,#9aa0a8);text-align:center;padding:20px;font-size:13px;">Loading providers...</div>';
    fetch('/kimi-admin/providers').then(function(r) { return r.json(); }).then(function(d) {
      if (!d.success || !d.providers) {
        l.innerHTML = '<div style="background:rgba(248,81,73,0.1);color:var(--color-danger,#f85149);padding:12px;text-align:center;border-radius:6px;border:1px solid rgba(248,81,73,0.25);font-size:13px;">Failed to load providers</div>';
        return;
      }
      currentProviders = d.providers;
      if (d.providers.length === 0) {
        l.innerHTML = '<div style="color:var(--color-text-faint,#6b7280);padding:12px;text-align:center;font-size:13px;">No providers configured. Add one below.</div>';
        return;
      }
      l.innerHTML = d.providers.map(function(p) {
        var canDel = (p.id !== 'opencode-zen' && p.id !== 'omniroute');
        var delBtn = canDel ? '<button onclick="ksD(\'' + p.id.replace(/'/g, "\\'") + '\')" style="padding:4px 8px;border:none;border-radius:6px;font-size:11px;font-weight:500;cursor:pointer;background:var(--color-danger,#f85149);color:#fff;font-family:inherit;">Del</button>' : '';
        var keyStatus = p.has_api_key
          ? '✅ ' + (p.api_key_masked || 'Key set')
          : '⚠️ No key';
        return '<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 10px;border:1px solid var(--color-line,#2d333b);border-radius:8px;background:var(--color-surface,#161b22);">' +
          '<div style="flex:1;min-width:0;">' +
            '<div style="font-size:13px;font-weight:600;color:var(--color-text,#c9cdd4);">' + escHtml(p.id) + '</div>' +
            '<div style="font-size:11px;color:var(--color-text-faint,#6b7280);margin-top:1px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + escHtml(p.base_url) + '</div>' +
            '<div style="font-size:11px;color:var(--color-text-muted,#9aa0a8);margin-top:1px;">' + keyStatus + '</div>' +
          '</div>' +
          '<div style="display:flex;gap:4px;flex-shrink:0;">' +
            '<button onclick="ksE(\'' + p.id.replace(/'/g, "\\'") + '\')" style="padding:4px 8px;border:none;border-radius:6px;font-size:11px;font-weight:500;cursor:pointer;background:var(--color-accent,#58a6ff);color:#fff;font-family:inherit;">Edit</button>' +
            delBtn +
          '</div>' +
        '</div>';
      }).join('');
    }).catch(function(e) {
      l.innerHTML = '<div style="background:rgba(248,81,73,0.1);color:var(--color-danger,#f85149);padding:12px;text-align:center;border-radius:6px;border:1px solid rgba(248,81,73,0.25);font-size:13px;">' + escHtml(e.message) + '</div>';
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
    var st = document.getElementById('ks-st');
    if (st) st.style.display = 'none';
    // Find URL from current providers
    for (var i = 0; i < currentProviders.length; i++) {
      if (currentProviders[i].id === id) {
        document.getElementById('ks-url').value = currentProviders[i].base_url || '';
        break;
      }
    }
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
    if (!confirm('Restart daemon to pick up new models? Active chats will briefly disconnect.')) return;
    ksSt('Restarting daemon... Page will reload automatically.', 'ks-wait');
    fetch('/kimi-admin/restart-daemon', { method: 'POST' })
      .then(function(r) { return r.json(); })
      .then(function(d) {
        if (d.success) {
          ksSt('Restart initiated! Reloading page in 6s...', 'ks-ok');
          setTimeout(function() { location.reload(); }, 6000);
        } else {
          ksSt(d.message || 'Daemon not running', 'ks-bad');
        }
      })
      .catch(function(e) { ksSt('Error: ' + e.message, 'ks-bad'); });
  };

  // ====== ADD FOCUS STYLE FOR INPUTS ======
  document.addEventListener('focusin', function(e) {
    if (e.target.matches('#ks-frm input, #ks-frm input')) {
      e.target.style.borderColor = 'var(--color-accent,#58a6ff)';
    }
  });
  document.addEventListener('focusout', function(e) {
    if (e.target.matches('#ks-frm input, #ks-frm input')) {
      e.target.style.borderColor = 'var(--color-line,#2d333b)';
    }
  });

  // Initial load
  ksRef();
})();
