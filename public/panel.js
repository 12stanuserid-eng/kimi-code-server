(function() {
  'use strict';
  if (document.getElementById('ks-injected')) return;

  var KS_ID = 'ks-injected';
  var page = null;
  var currentProviders = [];

  // ====== SVG ICONS ======
  var backSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5"/><path d="M12 19l-7-7 7-7"/></svg>';
  var cogSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/></svg>';
  var plusSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>';

  // ====== MARK INJECTED ======
  var mark = document.createElement('meta');
  mark.id = KS_ID;
  document.head.appendChild(mark);

  // ====== BUILD FULL-PAGE VIEW ======
  function buildPage() {
    if (page && page.parentNode) return page;
    page = document.createElement('div');
    page.id = 'ks-page';
    page.style.cssText = 'position:fixed;inset:0;z-index:99999;display:none;flex-direction:column;background:var(--color-bg, #0d1117);color:var(--color-text,#c9cdd4);font-family:var(--font-family,-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif);overflow:hidden;';
    page.innerHTML =
      /* ===== HEADER ===== */
      '<div style="display:flex;align-items:center;gap:12px;padding:16px 20px;border-bottom:1px solid var(--color-line,#2d333b);flex-shrink:0;background:var(--color-surface, #0d1117);">' +
        '<button onclick="ksBack()" aria-label="Back" style="display:flex;align-items:center;justify-content:center;width:36px;height:36px;border-radius:var(--radius-md,8px);border:1px solid var(--color-line,#2d333b);background:var(--color-surface-raised,#161b22);color:var(--color-text,#c9cdd4);cursor:pointer;transition:all 0.15s ease;flex-shrink:0;" onmouseenter="this.style.borderColor=\'var(--color-accent,#58a6ff)\';this.style.background=\'var(--color-accent,#58a6ff)\';this.style.color=\'#fff\'" onmouseleave="this.style.borderColor=\'var(--color-line,#2d333b)\';this.style.background=\'var(--color-surface-raised,#161b22)\';this.style.color=\'var(--color-text,#c9cdd4)\'">' + backSvg + '</button>' +
        '<div style="flex:1;min-width:0;">' +
          '<div style="font-size:16px;font-weight:600;color:var(--color-text,#c9cdd4);letter-spacing:-0.01em;">Provider Settings</div>' +
          '<div style="font-size:12px;color:var(--color-text-faint,#6b7280);margin-top:2px;">Manage custom LLM providers and API keys</div>' +
        '</div>' +
        '<button onclick="ksR()" style="display:flex;align-items:center;gap:6px;padding:8px 14px;border-radius:var(--radius-md,8px);border:1px solid var(--color-line,#2d333b);background:var(--color-surface-raised,#161b22);color:var(--color-text,#c9cdd4);font-size:13px;font-weight:500;cursor:pointer;transition:all 0.15s ease;flex-shrink:0;font-family:inherit;" onmouseenter="this.style.borderColor=\'var(--color-accent,#58a6ff)\'" onmouseleave="this.style.borderColor=\'var(--color-line,#2d333b)\'">' +
          '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 11-2.12-9.36L23 10"/></svg>' +
          'Restart' +
        '</button>' +
      '</div>' +

      /* ===== SCROLLABLE CONTENT ===== */
      '<div style="flex:1;overflow-y:auto;padding:20px;min-height:0;">' +

        /* -- Status Message -- */
        '<div id="ks-st" style="font-size:13px;padding:12px 16px;border-radius:var(--radius-md,8px);margin-bottom:20px;display:none;line-height:1.5;"></div>' +

        /* -- Existing Providers Section -- */
        '<div style="margin-bottom:28px;">' +
          '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;">' +
            '<div style="font-size:13px;font-weight:600;color:var(--color-text,#c9cdd4);text-transform:uppercase;letter-spacing:0.05em;opacity:0.8;">Active Providers</div>' +
            '<button onclick="ksRef()" style="font-size:12px;color:var(--color-accent,#58a6ff);background:none;border:none;cursor:pointer;padding:4px 8px;border-radius:6px;transition:background 0.15s;font-family:inherit;" onmouseenter="this.style.background=\'var(--color-surface-raised,#161b22)\'" onmouseleave="this.style.background=\'none\'">Refresh</button>' +
          '</div>' +
          '<div id="ks-l" style="display:flex;flex-direction:column;gap:8px;"></div>' +
        '</div>' +

        /* -- Add / Edit Provider Section -- */
        '<div id="ks-frm">' +
          '<div style="display:flex;align-items:center;gap:8px;margin-bottom:16px;">' +
            '<div style="width:28px;height:28px;border-radius:var(--radius-md,8px);background:var(--color-accent,#58a6ff);display:flex;align-items:center;justify-content:center;color:#fff;flex-shrink:0;">' + plusSvg + '</div>' +
            '<div style="font-size:13px;font-weight:600;color:var(--color-text,#c9cdd4);text-transform:uppercase;letter-spacing:0.05em;opacity:0.8;">Add Provider</div>' +
          '</div>' +

          /* -- Form Card -- */
          '<div style="background:var(--color-surface-raised,#161b22);border:1px solid var(--color-line,#2d333b);border-radius:var(--radius-lg,12px);padding:20px;">' +

            '<div style="margin-bottom:18px;">' +
              '<label style="display:block;margin:0 0 8px;font-size:12px;font-weight:500;color:var(--color-text-faint,#8b949e);letter-spacing:0.02em;">Provider ID</label>' +
              '<input id="ks-id" placeholder="e.g. nvidia, openai, custom" spellcheck="false" style="width:100%;padding:12px 14px;border:1px solid var(--color-line,#2d333b);border-radius:var(--radius-md,8px);background:var(--color-bg,#0d1117);color:var(--color-text,#c9cdd4);font-size:14px;font-weight:400;box-sizing:border-box;outline:none;transition:all 0.2s ease;caret-color:var(--color-accent,#58a6ff);font-family:inherit;" onfocus="this.style.borderColor=\'var(--color-accent,#58a6ff)\';this.style.boxShadow=\'0 0 0 3px rgba(88,166,255,0.15)\'" onblur="this.style.borderColor=\'var(--color-line,#2d333b)\';this.style.boxShadow=\'none\'">' +
            '</div>' +

            '<div style="margin-bottom:18px;">' +
              '<label style="display:block;margin:0 0 8px;font-size:12px;font-weight:500;color:var(--color-text-faint,#8b949e);letter-spacing:0.02em;">Base URL</label>' +
              '<input id="ks-url" placeholder="https://integrate.api.nvidia.com/v1" spellcheck="false" style="width:100%;padding:12px 14px;border:1px solid var(--color-line,#2d333b);border-radius:var(--radius-md,8px);background:var(--color-bg,#0d1117);color:var(--color-text,#c9cdd4);font-size:14px;font-weight:400;box-sizing:border-box;outline:none;transition:all 0.2s ease;caret-color:var(--color-accent,#58a6ff);font-family:inherit;" onfocus="this.style.borderColor=\'var(--color-accent,#58a6ff)\';this.style.boxShadow=\'0 0 0 3px rgba(88,166,255,0.15)\'" onblur="this.style.borderColor=\'var(--color-line,#2d333b)\';this.style.boxShadow=\'none\'">' +
            '</div>' +

            '<div style="margin-bottom:20px;">' +
              '<label style="display:block;margin:0 0 8px;font-size:12px;font-weight:500;color:var(--color-text-faint,#8b949e);letter-spacing:0.02em;">API Key</label>' +
              '<input id="ks-key" type="password" placeholder="sk-... (leave blank to keep existing)" spellcheck="false" style="width:100%;padding:12px 14px;border:1px solid var(--color-line,#2d333b);border-radius:var(--radius-md,8px);background:var(--color-bg,#0d1117);color:var(--color-text,#c9cdd4);font-size:14px;font-weight:400;box-sizing:border-box;outline:none;transition:all 0.2s ease;caret-color:var(--color-accent,#58a6ff);font-family:inherit;" onfocus="this.style.borderColor=\'var(--color-accent,#58a6ff)\';this.style.boxShadow=\'0 0 0 3px rgba(88,166,255,0.15)\'" onblur="this.style.borderColor=\'var(--color-line,#2d333b)\';this.style.boxShadow=\'none\'">' +
            '</div>' +

            '<div style="display:flex;gap:10px;">' +
              '<button onclick="ksS()" style="flex:1;padding:11px 16px;font-size:14px;font-weight:600;text-align:center;background:var(--color-accent,#58a6ff);color:#fff;border:none;border-radius:var(--radius-md,8px);cursor:pointer;transition:all 0.15s ease;font-family:inherit;" onmouseenter="this.style.opacity=\'0.9\'" onmouseleave="this.style.opacity=\'1\'" onmousedown="this.style.transform=\'scale(0.98)\'" onmouseup="this.style.transform=\'scale(1)\'">Save Provider</button>' +
              '<button onclick="ksCf()" style="flex:1;padding:11px 16px;font-size:14px;font-weight:500;text-align:center;background:transparent;color:var(--color-text,#c9cdd4);border:1px solid var(--color-line,#3d444d);border-radius:var(--radius-md,8px);cursor:pointer;transition:all 0.15s ease;font-family:inherit;" onmouseenter="this.style.background=\'var(--color-surface-raised,#161b22)\';this.style.borderColor=\'var(--color-accent,#58a6ff)\'" onmouseleave="this.style.background=\'transparent\';this.style.borderColor=\'var(--color-line,#3d444d)\'">Clear Form</button>' +
            '</div>' +

          '</div>' +
        '</div>' +

      '</div>';

    document.body.appendChild(page);

    // Close on Escape
    document.addEventListener('keydown', function(e) {
      if (e.key === 'Escape' && page.style.display === 'flex') ksBack();
    });

    return page;
  }

  // ====== INJECT ROW INTO SETTINGS PANEL ======
  function injectSettingsRow() {
    var existing = document.getElementById('ks-srow');
    if (existing) existing.remove();

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

    var parent = signOutEl.closest('button, a, [role="menuitem"], [class*="acct"], [class*="srow"]');
    if (parent && parent !== signOutEl) signOutEl = parent;

    var row = document.createElement('div');
    row.id = 'ks-srow';
    row.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:8px 16px;cursor:pointer;border-top:1px solid var(--color-line,#2d333b);transition:background 0.15s;';

    var left = document.createElement('div');
    left.style.cssText = 'flex:1;min-width:0;';
    left.innerHTML = '<div style="font-size:14px;font-weight:400;color:var(--color-text,#c9cdd4);">Provider Settings</div>' +
      '<div style="font-size:11px;color:var(--color-text,#c9cdd4);margin-top:1px;opacity:0.8;">Manage custom LLM providers</div>';

    var right = document.createElement('div');
    right.style.cssText = 'display:flex;align-items:center;gap:6px;color:var(--color-text-faint,#6b7280);font-size:14px;';
    right.innerHTML = cogSvg;

    row.appendChild(left);
    row.appendChild(right);

    row.onclick = function(e) {
      e.stopPropagation();
      e.preventDefault();
      buildPage();
      // Hide main app content
      var app = document.querySelector('[class*="app"], main, #root, #app');
      if (app) app.style.display = 'none';
      page.style.display = 'flex';
      ksRef();
    };

    row.onmouseenter = function() { this.style.background = 'var(--color-surface,#161b22)'; };
    row.onmouseleave = function() { this.style.background = 'transparent'; };

    signOutEl.parentNode.insertBefore(row, signOutEl);
    return true;
  }

  // ====== TRY INJECTION ======
  function tryInject() {
    if (injectSettingsRow()) return true;

    if (!window._ksObs) {
      window._ksObs = new MutationObserver(function() {
        if (!document.getElementById('ks-srow')) {
          injectSettingsRow();
        }
      });
      window._ksObs.observe(document.body, { childList: true, subtree: true });
    }

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

  tryInject();

  document.addEventListener('click', function(e) {
    if (page && page.style.display === 'flex' && page.contains(e.target)) return;
    setTimeout(function() {
      if (!document.getElementById('ks-srow')) {
        injectSettingsRow();
      }
    }, 800);
  }, true);

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

  // ====== BACK BUTTON ======
  window.ksBack = function() {
    if (page) page.style.display = 'none';
    // Restore main app
    var app = document.querySelector('[class*="app"], main, #root, #app');
    if (app) app.style.display = '';
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
    el.style.borderRadius = 'var(--radius-md,8px)';
    el.style.lineHeight = '1.5';
    if (type === 'ks-ok') {
      el.style.background = 'rgba(63,185,80,0.1)';
      el.style.color = 'var(--color-success,#3fb950)';
      el.style.border = '1px solid rgba(63,185,80,0.25)';
    } else if (type === 'ks-bad') {
      el.style.background = 'rgba(248,81,73,0.1)';
      el.style.color = 'var(--color-danger,#f85149)';
      el.style.border = '1px solid rgba(248,81,73,0.25)';
    } else if (type === 'ks-wait') {
      el.style.background = 'var(--color-surface-raised,#161b22)';
      el.style.color = 'var(--color-text-muted,#9aa0a8)';
      el.style.border = '1px solid var(--color-line,#2d333b)';
      el.style.textAlign = 'center';
      el.style.padding = '20px';
      el.style.display = 'flex';
      el.style.alignItems = 'center';
      el.style.justifyContent = 'center';
      el.style.gap = '10px';
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
    l.innerHTML = '<div style="color:var(--color-text-faint,#6b7280);text-align:center;padding:32px;font-size:14px;">Loading providers...</div>';
    fetch('/kimi-admin/providers').then(function(r) { return r.json(); }).then(function(d) {
      if (!d.success || !d.providers) {
        l.innerHTML = '<div style="background:rgba(248,81,73,0.08);color:var(--color-danger,#f85149);padding:16px;text-align:center;border-radius:var(--radius-md,8px);border:1px solid rgba(248,81,73,0.2);font-size:14px;">Failed to load providers</div>';
        return;
      }
      currentProviders = d.providers;
      if (d.providers.length === 0) {
        l.innerHTML = '<div style="background:var(--color-surface-raised,#161b22);border:1px dashed var(--color-line,#2d333b);border-radius:var(--radius-md,8px);padding:32px;text-align:center;color:var(--color-text-faint,#6b7280);font-size:14px;">No providers configured yet.<br><span style="font-size:12px;opacity:0.7;margin-top:4px;display:block;">Add your first provider below</span></div>';
        return;
      }
      l.innerHTML = d.providers.map(function(p) {
        var canDel = (p.id !== 'opencode-zen' && p.id !== 'omniroute');
        var delBtn = canDel ? '<button onclick="ksD(\'' + p.id.replace(/'/g, "\\'") + '\')" style="padding:5px 10px;border:none;border-radius:var(--radius-sm,6px);font-size:12px;font-weight:500;cursor:pointer;background:rgba(248,81,73,0.15);color:var(--color-danger,#f85149);transition:all 0.15s;font-family:inherit;" onmouseenter="this.style.background=\'rgba(248,81,73,0.25)\'" onmouseleave="this.style.background=\'rgba(248,81,73,0.15)\'">Delete</button>' : '';
        var keyStatus = p.has_api_key
          ? '<span style="color:var(--color-success,#3fb950);">● Key set</span>' + (p.api_key_masked ? ' <span style="opacity:0.5;">(' + escHtml(p.api_key_masked) + ')</span>' : '')
          : '<span style="color:var(--color-danger,#f85149);">● No key</span>';
        return '<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 16px;border:1px solid var(--color-line,#2d333b);border-radius:var(--radius-md,8px);background:var(--color-surface-raised,#161b22);transition:border-color 0.15s;" onmouseenter="this.style.borderColor=\'var(--color-accent,#58a6ff)\'" onmouseleave="this.style.borderColor=\'var(--color-line,#2d333b)\'">' +
          '<div style="flex:1;min-width:0;">' +
            '<div style="font-size:14px;font-weight:600;color:var(--color-text,#c9cdd4);margin-bottom:3px;">' + escHtml(p.id) + '</div>' +
            '<div style="font-size:12px;color:var(--color-text-faint,#6b7280);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-bottom:3px;">' + escHtml(p.base_url) + '</div>' +
            '<div style="font-size:12px;">' + keyStatus + '</div>' +
          '</div>' +
          '<div style="display:flex;gap:6px;flex-shrink:0;">' +
            '<button onclick="ksE(\'' + p.id.replace(/'/g, "\\'") + '\')" style="padding:5px 10px;border:none;border-radius:var(--radius-sm,6px);font-size:12px;font-weight:500;cursor:pointer;background:rgba(88,166,255,0.15);color:var(--color-accent,#58a6ff);transition:all 0.15s;font-family:inherit;" onmouseenter="this.style.background=\'rgba(88,166,255,0.25)\'" onmouseleave="this.style.background=\'rgba(88,166,255,0.15)\'">Edit</button>' +
            delBtn +
          '</div>' +
        '</div>';
      }).join('');
    }).catch(function(e) {
      l.innerHTML = '<div style="background:rgba(248,81,73,0.08);color:var(--color-danger,#f85149);padding:16px;text-align:center;border-radius:var(--radius-md,8px);border:1px solid rgba(248,81,73,0.2);font-size:14px;">' + escHtml(e.message) + '</div>';
    });
  };

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
    for (var i = 0; i < currentProviders.length; i++) {
      if (currentProviders[i].id === id) {
        document.getElementById('ks-url').value = currentProviders[i].base_url || '';
        break;
      }
    }
    // Scroll to form
    var frm = document.getElementById('ks-frm');
    if (frm) frm.scrollIntoView({ behavior: 'smooth', block: 'start' });
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
})();
