(function() {
  'use strict';
  if (document.getElementById('ks-injected')) return;

  var KS_ID = 'ks-injected';
  var currentProviders = [];
  var sidebarOpen = false;

  // ====== MARK INJECTED ======
  var mark = document.createElement('meta');
  mark.id = KS_ID;
  document.head.appendChild(mark);

  // ====== CSS VARIABLES (match Kimi Code native) ======
  function getVar(name, fallback) {
    return 'var(--' + name + ', ' + fallback + ')';
  }

  // ====== BUILD PROVIDER SETTINGS SUB-PAGE ======
  function buildProviderPage() {
    var existing = document.getElementById('ks-provider-page');
    if (existing) existing.remove();

    var page = document.createElement('div');
    page.id = 'ks-provider-page';
    page.style.cssText = 'position:fixed;inset:0;z-index:99998;display:none;flex-direction:column;background:' + getVar('color-bg', '#0d1117') + ';color:' + getVar('color-text', '#c9cdd4') + ';font-family:' + getVar('font-family', '-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif') + ';overflow:hidden;';

    page.innerHTML =
      // HEADER
      '<div style="display:flex;align-items:center;gap:12px;padding:14px 16px;border-bottom:1px solid ' + getVar('color-line', '#2d333b') + ';flex-shrink:0;background:' + getVar('color-surface', '#0d1117') + ';">' +
        '<button id="ks-back-btn" style="display:flex;align-items:center;justify-content:center;width:32px;height:32px;border-radius:8px;border:1px solid ' + getVar('color-line', '#2d333b') + ';background:' + getVar('color-surface-raised', '#161b22') + ';color:' + getVar('color-text', '#c9cdd4') + ';cursor:pointer;transition:all 0.15s ease;flex-shrink:0;font-size:16px;">' +
          '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5"/><path d="M12 19l-7-7 7-7"/></svg>' +
        '</button>' +
        '<div style="flex:1;min-width:0;">' +
          '<div style="font-size:14px;font-weight:600;color:' + getVar('color-text', '#c9cdd4') + ';">Provider Settings</div>' +
          '<div style="font-size:11px;color:' + getVar('color-text-faint', '#6b7280') + ';margin-top:1px;">Manage custom LLM providers</div>' +
        '</div>' +
        '<button id="ks-restart-btn" style="display:flex;align-items:center;gap:5px;padding:6px 12px;border-radius:8px;border:1px solid ' + getVar('color-line', '#2d333b') + ';background:' + getVar('color-surface-raised', '#161b22') + ';color:' + getVar('color-text', '#c9cdd4') + ';font-size:12px;font-weight:500;cursor:pointer;transition:all 0.15s ease;flex-shrink:0;">' +
          '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 11-2.12-9.36L23 10"/></svg>' +
          'Restart' +
        '</button>' +
      '</div>' +

      // SCROLLABLE CONTENT
      '<div style="flex:1;overflow-y:auto;padding:16px;min-height:0;">' +

        // Status Message
        '<div id="ks-st" style="font-size:12px;padding:10px 14px;border-radius:8px;margin-bottom:16px;display:none;line-height:1.5;"></div>' +

        // Active Providers Section
        '<div style="margin-bottom:24px;">' +
          '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;">' +
            '<div style="font-size:11px;font-weight:600;color:' + getVar('color-text-faint', '#6b7280') + ';text-transform:uppercase;letter-spacing:0.06em;">Active Providers</div>' +
            '<button id="ks-refresh-btn" style="font-size:11px;color:' + getVar('color-accent', '#58a6ff') + ';background:none;border:none;cursor:pointer;padding:3px 6px;border-radius:4px;transition:background 0.15s;">Refresh</button>' +
          '</div>' +
          '<div id="ks-l" style="display:flex;flex-direction:column;gap:6px;"></div>' +
        '</div>' +

        // Add Provider Section
        '<div id="ks-frm">' +
          '<div style="display:flex;align-items:center;gap:6px;margin-bottom:12px;">' +
            '<div style="width:24px;height:24px;border-radius:6px;background:' + getVar('color-accent', '#58a6ff') + ';display:flex;align-items:center;justify-content:center;color:#fff;flex-shrink:0;font-size:14px;">+</div>' +
            '<div style="font-size:11px;font-weight:600;color:' + getVar('color-text-faint', '#6b7280') + ';text-transform:uppercase;letter-spacing:0.06em;">Add Provider</div>' +
          '</div>' +

          // Form Card
          '<div style="background:' + getVar('color-surface-raised', '#161b22') + ';border:1px solid ' + getVar('color-line', '#2d333b') + ';border-radius:10px;padding:16px;">' +

            '<div style="margin-bottom:14px;">' +
              '<label style="display:block;margin:0 0 6px;font-size:11px;font-weight:500;color:' + getVar('color-text-faint', '#8b949e') + ';letter-spacing:0.02em;">Provider ID</label>' +
              '<input id="ks-id" placeholder="e.g. nvidia, openai, custom" spellcheck="false" style="width:100%;padding:10px 12px;border:1px solid ' + getVar('color-line', '#2d333b') + ';border-radius:8px;background:' + getVar('color-bg', '#0d1117') + ';color:' + getVar('color-text', '#c9cdd4') + ';font-size:13px;box-sizing:border-box;outline:none;transition:all 0.2s ease;font-family:inherit;" onfocus="this.style.borderColor=\'' + getVar('color-accent', '#58a6ff') + '\';this.style.boxShadow=\'0 0 0 2px rgba(88,166,255,0.12)\'" onblur="this.style.borderColor=\'' + getVar('color-line', '#2d333b') + '\';this.style.boxShadow=\'none\'">' +
            '</div>' +

            '<div style="margin-bottom:14px;">' +
              '<label style="display:block;margin:0 0 6px;font-size:11px;font-weight:500;color:' + getVar('color-text-faint', '#8b949e') + ';letter-spacing:0.02em;">Base URL</label>' +
              '<input id="ks-url" placeholder="https://integrate.api.nvidia.com/v1" spellcheck="false" style="width:100%;padding:10px 12px;border:1px solid ' + getVar('color-line', '#2d333b') + ';border-radius:8px;background:' + getVar('color-bg', '#0d1117') + ';color:' + getVar('color-text', '#c9cdd4') + ';font-size:13px;box-sizing:border-box;outline:none;transition:all 0.2s ease;font-family:inherit;" onfocus="this.style.borderColor=\'' + getVar('color-accent', '#58a6ff') + '\';this.style.boxShadow=\'0 0 0 2px rgba(88,166,255,0.12)\'" onblur="this.style.borderColor=\'' + getVar('color-line', '#2d333b') + '\';this.style.boxShadow=\'none\'">' +
            '</div>' +

            '<div style="margin-bottom:16px;">' +
              '<label style="display:block;margin:0 0 6px;font-size:11px;font-weight:500;color:' + getVar('color-text-faint', '#8b949e') + ';letter-spacing:0.02em;">API Key</label>' +
              '<input id="ks-key" type="password" placeholder="sk-... (leave blank to keep existing)" spellcheck="false" style="width:100%;padding:10px 12px;border:1px solid ' + getVar('color-line', '#2d333b') + ';border-radius:8px;background:' + getVar('color-bg', '#0d1117') + ';color:' + getVar('color-text', '#c9cdd4') + ';font-size:13px;box-sizing:border-box;outline:none;transition:all 0.2s ease;font-family:inherit;" onfocus="this.style.borderColor=\'' + getVar('color-accent', '#58a6ff') + '\';this.style.boxShadow=\'0 0 0 2px rgba(88,166,255,0.12)\'" onblur="this.style.borderColor=\'' + getVar('color-line', '#2d333b') + '\';this.style.boxShadow=\'none\'">' +
            '</div>' +

            '<div style="display:flex;gap:8px;">' +
              '<button id="ks-save-btn" style="flex:1;padding:9px 14px;font-size:13px;font-weight:600;text-align:center;background:' + getVar('color-accent', '#58a6ff') + ';color:#fff;border:none;border-radius:8px;cursor:pointer;transition:all 0.15s ease;font-family:inherit;">Save Provider</button>' +
              '<button id="ks-clear-btn" style="flex:1;padding:9px 14px;font-size:13px;font-weight:500;text-align:center;background:transparent;color:' + getVar('color-text', '#c9cdd4') + ';border:1px solid ' + getVar('color-line', '#3d444d') + ';border-radius:8px;cursor:pointer;transition:all 0.15s ease;font-family:inherit;">Clear</button>' +
            '</div>' +

          '</div>' +
        '</div>' +

      '</div>';

    document.body.appendChild(page);

    // Event listeners
    document.getElementById('ks-back-btn').onclick = closeProviderPage;
    document.getElementById('ks-restart-btn').onclick = restartDaemon;
    document.getElementById('ks-refresh-btn').onclick = loadProviders;
    document.getElementById('ks-save-btn').onclick = saveProvider;
    document.getElementById('ks-clear-btn').onclick = clearForm;

    // Close on Escape
    document.addEventListener('keydown', function(e) {
      if (e.key === 'Escape' && page.style.display === 'flex') closeProviderPage();
    });

    return page;
  }

  // ====== OPEN/CLOSE PROVIDER PAGE ======
  function openProviderPage() {
    var page = buildProviderPage();
    page.style.display = 'flex';
    loadProviders();
  }

  function closeProviderPage() {
    var page = document.getElementById('ks-provider-page');
    if (page) page.style.display = 'none';
  }

  // ====== INJECT INTO SIDEBAR ======
  function injectSidebarItem() {
    var existing = document.getElementById('ks-sidebar-item');
    if (existing) existing.remove();

    // Find the settings sidebar - look for "Sign out" button
    var allNodes = document.querySelectorAll('button, a, div, span, label');
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

    // Get the parent row of Sign out
    var parent = signOutEl.closest('button, a, [role="menuitem"], [class*="acct"], [class*="srow"]');
    if (parent && parent !== signOutEl) signOutEl = parent;

    // Create the menu item - matches Kimi Code's native sidebar items
    var item = document.createElement('div');
    item.id = 'ks-sidebar-item';
    item.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:8px 16px;cursor:pointer;border-top:1px solid ' + getVar('color-line', '#2d333b') + ';transition:background 0.15s;font-family:inherit;';

    item.innerHTML =
      '<div style="flex:1;min-width:0;">' +
        '<div style="font-size:14px;font-weight:400;color:' + getVar('color-text', '#c9cdd4') + ';display:flex;align-items:center;gap:8px;">' +
          '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="opacity:0.7;"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/></svg>' +
          'Provider Settings' +
        '</div>' +
        '<div style="font-size:11px;color:' + getVar('color-text-faint', '#6b7280') + ';margin-top:1px;opacity:0.7;">Manage custom LLM providers</div>' +
      '</div>' +
      '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color:' + getVar('color-text-faint', '#6b7280') + ';flex-shrink:0;opacity:0.5;"><path d="M9 18l6-6-6-6"/></svg>';

    item.onclick = function(e) {
      e.stopPropagation();
      e.preventDefault();
      openProviderPage();
    };

    item.onmouseenter = function() { this.style.background = getVar('color-surface', '#161b22'); };
    item.onmouseleave = function() { this.style.background = 'transparent'; };

    signOutEl.parentNode.insertBefore(item, signOutEl);
    return true;
  }

  // ====== TRY INJECTION ======
  function tryInject() {
    if (injectSidebarItem()) return true;

    if (!window._ksObs) {
      window._ksObs = new MutationObserver(function() {
        if (!document.getElementById('ks-sidebar-item')) {
          injectSidebarItem();
        }
      });
      window._ksObs.observe(document.body, { childList: true, subtree: true });
    }

    var retries = 0;
    var maxRetries = 10;
    var iv = setInterval(function() {
      retries++;
      if (injectSidebarItem() || retries >= maxRetries) {
        clearInterval(iv);
      }
    }, 500);

    return false;
  }

  tryInject();

  // Re-inject after settings panel opens/closes
  document.addEventListener('click', function(e) {
    setTimeout(function() {
      if (!document.getElementById('ks-sidebar-item')) {
        injectSidebarItem();
      }
    }, 500);
  }, true);

  // Periodic re-injection for SPA navigation
  (function periodicInject() {
    var checks = 0;
    var maxChecks = 20;
    var iv2 = setInterval(function() {
      checks++;
      if (!document.getElementById('ks-sidebar-item')) {
        injectSidebarItem();
      }
      if (checks >= maxChecks) clearInterval(iv2);
    }, 2000);
  })();

  // ====== HELPERS ======
  function escHtml(s) {
    if (!s) return '';
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function showStatus(msg, type) {
    var el = document.getElementById('ks-st');
    if (!el) return;
    el.textContent = msg;
    el.style.display = 'block';
    el.style.borderRadius = '8px';
    el.style.lineHeight = '1.5';
    if (type === 'ok') {
      el.style.background = 'rgba(63,185,80,0.1)';
      el.style.color = getVar('color-success', '#3fb950');
      el.style.border = '1px solid rgba(63,185,80,0.25)';
    } else if (type === 'bad') {
      el.style.background = 'rgba(248,81,73,0.1)';
      el.style.color = getVar('color-danger', '#f85149');
      el.style.border = '1px solid rgba(248,81,73,0.25)';
    } else if (type === 'wait') {
      el.style.background = getVar('color-surface-raised', '#161b22');
      el.style.color = getVar('color-text-muted', '#9aa0a8');
      el.style.border = '1px solid ' + getVar('color-line', '#2d333b');
      el.style.textAlign = 'center';
      el.style.padding = '16px';
    } else {
      el.style.background = 'rgba(63,185,80,0.1)';
      el.style.color = getVar('color-success', '#3fb950');
      el.style.border = '1px solid rgba(63,185,80,0.25)';
    }
    if (type !== 'wait') {
      setTimeout(function() { el.style.display = 'none'; }, 5000);
    }
  }

  // ====== LOAD PROVIDERS ======
  function loadProviders() {
    var l = document.getElementById('ks-l');
    if (!l) return;
    l.innerHTML = '<div style="color:' + getVar('color-text-faint', '#6b7280') + ';text-align:center;padding:24px;font-size:12px;">Loading providers...</div>';
    fetch('/kimi-admin/providers').then(function(r) { return r.json(); }).then(function(d) {
      if (!d.success || !d.providers) {
        l.innerHTML = '<div style="background:rgba(248,81,73,0.08);color:' + getVar('color-danger', '#f85149') + ';padding:12px;text-align:center;border-radius:8px;border:1px solid rgba(248,81,73,0.2);font-size:12px;">Failed to load providers</div>';
        return;
      }
      currentProviders = d.providers;
      if (d.providers.length === 0) {
        l.innerHTML = '<div style="background:' + getVar('color-surface-raised', '#161b22') + ';border:1px dashed ' + getVar('color-line', '#2d333b') + ';border-radius:8px;padding:24px;text-align:center;color:' + getVar('color-text-faint', '#6b7280') + ';font-size:12px;">No providers configured yet.<br><span style="font-size:11px;opacity:0.7;margin-top:4px;display:block;">Add your first provider below</span></div>';
        return;
      }
      l.innerHTML = d.providers.map(function(p) {
        var canDel = (p.id !== 'opencode-zen' && p.id !== 'omniroute');
        var delBtn = canDel ? '<button data-action="delete" data-id="' + escHtml(p.id) + '" style="padding:4px 8px;border:none;border-radius:4px;font-size:11px;font-weight:500;cursor:pointer;background:rgba(248,81,73,0.15);color:' + getVar('color-danger', '#f85149') + ';transition:all 0.15s;">Delete</button>' : '';
        var keyStatus = p.has_api_key
          ? '<span style="color:' + getVar('color-success', '#3fb950') + ';font-size:11px;">● Key set</span>' + (p.api_key_masked ? ' <span style="opacity:0.5;font-size:10px;">(' + escHtml(p.api_key_masked) + ')</span>' : '')
          : '<span style="color:' + getVar('color-danger', '#f85149') + ';font-size:11px;">● No key</span>';
        var modelCount = p.model_count || 0;
        var modelBadge = modelCount > 0
          ? '<span style="display:inline-flex;align-items:center;gap:3px;padding:1px 6px;border-radius:10px;font-size:10px;font-weight:500;background:rgba(88,166,255,0.1);color:' + getVar('color-accent', '#58a6ff') + ';border:1px solid rgba(88,166,255,0.2);">' + modelCount + ' model' + (modelCount !== 1 ? 's' : '') + '</span>'
          : '<span style="display:inline-flex;align-items:center;gap:3px;padding:1px 6px;border-radius:10px;font-size:10px;font-weight:500;background:rgba(248,81,73,0.08);color:' + getVar('color-danger', '#f85149') + ';border:1px solid rgba(248,81,73,0.15);">No models</span>';
        return '<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;padding:10px 12px;border:1px solid ' + getVar('color-line', '#2d333b') + ';border-radius:8px;background:' + getVar('color-surface-raised', '#161b22') + ';transition:border-color 0.15s;" onmouseenter="this.style.borderColor=\'' + getVar('color-accent', '#58a6ff') + '\'" onmouseleave="this.style.borderColor=\'' + getVar('color-line', '#2d333b') + '\'">' +
          '<div style="flex:1;min-width:0;">' +
            '<div style="font-size:13px;font-weight:600;color:' + getVar('color-text', '#c9cdd4') + ';margin-bottom:2px;display:flex;align-items:center;gap:6px;">' + escHtml(p.id) + modelBadge + '</div>' +
            '<div style="font-size:11px;color:' + getVar('color-text-faint', '#6b7280') + ';overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-bottom:2px;">' + escHtml(p.base_url) + '</div>' +
            '<div style="font-size:11px;">' + keyStatus + '</div>' +
          '</div>' +
          '<div style="display:flex;gap:4px;flex-shrink:0;">' +
            '<button data-action="rediscover" data-id="' + escHtml(p.id) + '" title="Rediscover models" style="padding:4px 8px;border:none;border-radius:4px;font-size:11px;font-weight:500;cursor:pointer;background:rgba(63,185,80,0.12);color:' + getVar('color-success', '#3fb950') + ';transition:all 0.15s;display:flex;align-items:center;gap:3px;">↻ Rediscover</button>' +
            '<button data-action="edit" data-id="' + escHtml(p.id) + '" style="padding:4px 8px;border:none;border-radius:4px;font-size:11px;font-weight:500;cursor:pointer;background:rgba(88,166,255,0.15);color:' + getVar('color-accent', '#58a6ff') + ';transition:all 0.15s;">Edit</button>' +
            delBtn +
          '</div>' +
        '</div>';
      }).join('');

      // Attach event delegation
      l.onclick = function(e) {
        var btn = e.target.closest('[data-action]');
        if (!btn) return;
        var action = btn.getAttribute('data-action');
        var id = btn.getAttribute('data-id');
        if (action === 'delete') deleteProvider(id);
        else if (action === 'edit') editProvider(id);
        else if (action === 'rediscover') rediscoverModels(id);
      };
    }).catch(function(e) {
      l.innerHTML = '<div style="background:rgba(248,81,73,0.08);color:' + getVar('color-danger', '#f85149') + ';padding:12px;text-align:center;border-radius:8px;border:1px solid rgba(248,81,73,0.2);font-size:12px;">' + escHtml(e.message) + '</div>';
    });
  }

  // ====== EDIT ======
  function editProvider(id) {
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
    var frm = document.getElementById('ks-frm');
    if (frm) frm.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // ====== SAVE ======
  function saveProvider() {
    var id = document.getElementById('ks-id').value.trim();
    var url = document.getElementById('ks-url').value.trim();
    var key = document.getElementById('ks-key').value.trim();
    if (!id) { showStatus('Provider ID is required', 'bad'); return; }
    if (!url) { showStatus('Base URL is required', 'bad'); return; }
    var body = JSON.stringify({ id: id, type: 'openai', base_url: url, api_key: key });
    showStatus('Connecting to provider and discovering models...', 'wait');
    var saveBtn = document.getElementById('ks-save-btn');
    if (saveBtn) saveBtn.disabled = true;
    fetch('/kimi-admin/providers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body
    }).then(function(r) { return r.json(); }).then(function(d) {
      if (saveBtn) saveBtn.disabled = false;
      if (d.success) {
        clearForm();
        var msg = 'Saved!';
        if (d.models_discovered > 0) {
          msg += ' ' + d.models_discovered + ' models discovered.';
        } else if (d.model_fetch_error) {
          msg += ' Model discovery failed — click Rediscover to retry.';
        } else {
          msg += ' No models found — click Rediscover to retry.';
        }
        if (d.daemon_restarting) {
          msg += ' Daemon restarting — refreshing in 5s...';
          showStatus(msg, 'ok');
          setTimeout(function() { loadProviders(); }, 5000);
        } else {
          showStatus(msg, 'ok');
          loadProviders();
        }
      } else {
        showStatus('Error: ' + (d.error || 'Unknown error'), 'bad');
      }
    }).catch(function(e) {
      if (saveBtn) saveBtn.disabled = false;
      showStatus('Error: ' + e.message, 'bad');
    });
  }

  // ====== DELETE ======
  function deleteProvider(id) {
    if (!confirm('Delete provider "' + id + '"? This removes its models too.')) return;
    fetch('/kimi-admin/providers/' + encodeURIComponent(id), { method: 'DELETE' })
      .then(function(r) { return r.json(); })
      .then(function(d) {
        if (d.success) {
          if (d.daemon_restarting) {
            showStatus('Deleted! Daemon restarting — refreshing in 5s...', 'ok');
            setTimeout(function() { loadProviders(); }, 5000);
          } else {
            loadProviders();
            showStatus('Deleted!', 'ok');
          }
        } else {
          showStatus('Error: ' + (d.error || '?'), 'bad');
        }
      })
      .catch(function(e) { showStatus('Error: ' + e.message, 'bad'); });
  }

  // ====== REDISCOVER ======
  function rediscoverModels(id) {
    showStatus('Rediscovering models for "' + id + '"... This may take up to 30s.', 'wait');
    // Find and disable the rediscover button for this provider
    var allBtns = document.querySelectorAll('[data-action="rediscover"]');
    var targetBtn = null;
    for (var i = 0; i < allBtns.length; i++) {
      if (allBtns[i].getAttribute('data-id') === id) {
        targetBtn = allBtns[i];
        targetBtn.disabled = true;
        targetBtn.textContent = '⏳ Discovering...';
        break;
      }
    }
    fetch('/kimi-admin/providers/' + encodeURIComponent(id) + '/rediscover', { method: 'POST' })
      .then(function(r) { return r.json(); })
      .then(function(d) {
        if (targetBtn) { targetBtn.disabled = false; targetBtn.textContent = '↻ Rediscover'; }
        if (d.success) {
          if (d.models_discovered > 0) {
            if (d.daemon_restarting) {
              showStatus('Rediscovered ' + d.models_discovered + ' models for "' + id + '"! Daemon restarting — refreshing in 5s...', 'ok');
              setTimeout(function() { loadProviders(); }, 5000);
            } else {
              loadProviders();
              showStatus('✅ Rediscovered ' + d.models_discovered + ' models for "' + id + '"!', 'ok');
            }
          } else {
            showStatus(d.message || 'No models found. Check API key and base URL.', 'bad');
            loadProviders();
          }
        } else {
          showStatus('Error: ' + (d.error || 'Unknown error'), 'bad');
        }
      })
      .catch(function(e) {
        if (targetBtn) { targetBtn.disabled = false; targetBtn.textContent = '↻ Rediscover'; }
        showStatus('Error: ' + e.message, 'bad');
      });
  }

  // ====== CLEAR FORM ======
  function clearForm() {
    var idEl = document.getElementById('ks-id');
    var urlEl = document.getElementById('ks-url');
    var keyEl = document.getElementById('ks-key');
    if (idEl) idEl.value = '';
    if (urlEl) urlEl.value = '';
    if (keyEl) keyEl.value = '';
    var st = document.getElementById('ks-st');
    if (st) st.style.display = 'none';
  }

  // ====== RESTART DAEMON ======
  function restartDaemon() {
    if (!confirm('Restart daemon to apply changes? Active chats will briefly disconnect.')) return;
    showStatus('Restarting daemon...', 'wait');
    fetch('/kimi-admin/restart-daemon', { method: 'POST' })
      .then(function(r) { return r.json(); })
      .then(function(d) {
        if (d.success) {
          showStatus('Restarting! Reloading in 6s...', 'ok');
          setTimeout(function() { location.reload(); }, 6000);
        } else {
          showStatus(d.message || 'Daemon not running', 'bad');
        }
      })
      .catch(function(e) { showStatus('Error: ' + e.message, 'bad'); });
  }
})();
