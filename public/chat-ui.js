(function() {
  'use strict';

  // ====== CONFIG ======
  var API_BASE = '/api/v1';
  var WS_BASE = '/api/v1/ws';
  var AUTH_TOKEN_KEY = 'kimi-chat-auth-token';
  var SESSION_KEY = 'kimi-chat-current-session';

  // ====== DOM REFS ======
  var $root, $login, $app, $sidebar, $chatList, $chatView, $composer, $input, $sendBtn, $newChatBtn, $logoutBtn, $userAvatar, $username, $headerTitle, $emptyState, $messages, $streamingIndicator, $stopBtn, $menuBtn;

  // ====== STATE ======
  var state = {
    sessions: [],
    currentSessionId: null,
    messages: [],
    user: null,
    token: null,
    ws: null,
    wsConnected: false,
    wsClientId: null,
    streaming: false,
    subscribed: false,
    streamBuffer: '',
    streamMsgEl: null,
    reconnectTimer: null,
    wsReconnectAttempts: 0,
    heartbeatTimer: null,
    turnId: null,
  };

  // ====== STYLES INJECTION ======
  function injectStyles() {
    if (document.getElementById('kimi-chat-styles')) return;
    var link = document.createElement('link');
    link.id = 'kimi-chat-styles';
    link.rel = 'stylesheet';
    link.href = '/kimi-admin/chat-ui.css';
    document.head.appendChild(link);
  }

  // ====== HTML TEMPLATES ======
  function buildLoginScreen() {
    return '<div id="kc-login">' +
      '<div class="kc-login-card">' +
        '<div class="kc-logo">' +
          '<svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#6c5ce7" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>' +
        '</div>' +
        '<h1 class="kc-login-title">Kimi Code</h1>' +
        '<p class="kc-login-subtitle">AI-powered coding assistant</p>' +
        '<button id="kc-google-btn" class="kc-google-btn">' +
          '<svg width="18" height="18" viewBox="0 0 24 24"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/></svg>' +
          ' Sign in with Google' +
        '</button>' +
        '<div class="kc-login-divider"><span>or</span></div>' +
        '<div class="kc-token-login">' +
          '<input id="kc-token-input" type="password" placeholder="Enter API token..." spellcheck="false" />' +
          '<button id="kc-token-btn" class="kc-token-btn">Sign In</button>' +
        '</div>' +
        '<p class="kc-login-error" id="kc-login-error"></p>' +
      '</div>' +
    '</div>';
  }

  function getAppShell() {
    return '<div id="kc-app">' +
      '<aside id="kc-sidebar">' +
        '<div class="kc-sidebar-header">' +
          '<button id="kc-new-chat" class="kc-new-chat-btn">' +
            '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>' +
            ' New Chat' +
          '</button>' +
        '</div>' +
        '<div id="kc-chat-list" class="kc-chat-list"></div>' +
        '<div class="kc-sidebar-footer">' +
          '<div id="kc-user-info" class="kc-user-info">' +
            '<img id="kc-avatar" class="kc-avatar" src="" alt="" />' +
            '<span id="kc-username"></span>' +
          '</div>' +
          '<button id="kc-logout" class="kc-logout-btn" title="Sign out">' +
            '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>' +
          '</button>' +
        '</div>' +
      '</aside>' +
      '<main id="kc-main">' +
        '<header id="kc-header" class="kc-header">' +
          '<button id="kc-menu-btn" class="kc-menu-btn">' +
            '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="18" x2="21" y2="18"/></svg>' +
          '</button>' +
          '<span id="kc-header-title" class="kc-header-title">Kimi Code</span>' +
          '<div class="kc-header-right"></div>' +
        '</header>' +
        '<div id="kc-chat-view" class="kc-chat-view">' +
          '<div class="kc-empty-state" id="kc-empty-state">' +
            '<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#6c5ce7" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>' +
            '<h2>Kimi Code</h2>' +
            '<p>Select a chat or start a new conversation</p>' +
          '</div>' +
          '<div id="kc-messages" class="kc-messages"></div>' +
        '</div>' +
        '<div id="kc-composer" class="kc-composer" style="display:none;">' +
          '<textarea id="kc-input" class="kc-input" placeholder="Message Kimi..." rows="1" spellcheck="false"></textarea>' +
          '<button id="kc-send-btn" class="kc-send-btn" disabled>' +
            '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>' +
          '</button>' +
        '</div>' +
        '<div id="kc-streaming-indicator" class="kc-streaming-indicator" style="display:none;">' +
          '<div class="kc-dot-pulse"><span></span><span></span><span></span></div>' +
          '<span>Kimi is thinking...</span>' +
          '<button id="kc-stop-btn" class="kc-stop-btn">Stop</button>' +
        '</div>' +
      '</main>' +
    '</div>';
  }

  // ====== INIT ======
  function init() {
    injectStyles();
    if (document.getElementById('kc-root')) return;

    var root = document.createElement('div');
    root.id = 'kc-root';
    document.body.appendChild(root);
    $root = root;

    root.innerHTML = buildLoginScreen();
    $login = document.getElementById('kc-login');

    var savedToken = localStorage.getItem(AUTH_TOKEN_KEY);
    if (savedToken) {
      state.token = savedToken;
      state.user = JSON.parse(localStorage.getItem('kimi-chat-user') || 'null');
      showApp();
    }

    bindLoginEvents();
  }

  // ====== AUTH ======
  function bindLoginEvents() {
    var googleBtn = document.getElementById('kc-google-btn');
    var tokenBtn = document.getElementById('kc-token-btn');
    var tokenInput = document.getElementById('kc-token-input');

    if (googleBtn) googleBtn.onclick = handleGoogleLogin;
    if (tokenBtn) tokenBtn.onclick = function() {
      var token = tokenInput.value.trim();
      if (token) {
        state.token = token;
        state.user = { name: 'User', email: '', picture: '' };
        localStorage.setItem(AUTH_TOKEN_KEY, token);
        localStorage.setItem('kimi-chat-user', JSON.stringify(state.user));
        showLoginError('');
        showApp();
      }
    };
    if (tokenInput) {
      tokenInput.onkeydown = function(e) {
        if (e.key === 'Enter') tokenBtn.click();
      };
    }
  }

  function handleGoogleLogin() {
    if (typeof firebase !== 'undefined' && firebase.auth) {
      var provider = new firebase.auth.GoogleAuthProvider();
      provider.addScope('profile');
      provider.addScope('email');
      firebase.auth().signInWithPopup(provider)
        .then(function(result) {
          var user = result.user;
          user.getIdToken().then(function(token) {
            state.token = token;
            state.user = { name: user.displayName, email: user.email, picture: user.photoURL };
            localStorage.setItem(AUTH_TOKEN_KEY, state.token);
            localStorage.setItem('kimi-chat-user', JSON.stringify(state.user));
            showLoginError('');
            showApp();
          }).catch(function(err) {
            showLoginError('Failed to get ID token: ' + err.message);
          });
        })
        .catch(function(err) {
          if (err.code === 'auth/popup-blocked') {
            var p = new firebase.auth.GoogleAuthProvider();
            firebase.auth().signInWithRedirect(p);
          } else {
            showLoginError(err.message);
          }
        });
    } else {
      showLoginError('Firebase not loaded. Use token sign-in instead.');
    }
  }

  function showLoginError(msg) {
    var el = document.getElementById('kc-login-error');
    if (el) { el.textContent = msg; el.style.display = msg ? 'block' : 'none'; }
  }

  // ====== UI SWITCHING ======
  function showLogin() {
    $login.style.display = 'flex';
    if ($app) $app.style.display = 'none';
  }

  function showApp() {
    $login.style.display = 'none';
    if (!$app) {
      $root.insertAdjacentHTML('beforeend', getAppShell());
      $app = document.getElementById('kc-app');
      cacheDom();
      bindAppEvents();
    }
    $app.style.display = 'flex';
    updateUserUI();
    loadSessions();
  }

  function cacheDom() {
    $sidebar = document.getElementById('kc-sidebar');
    $chatList = document.getElementById('kc-chat-list');
    $chatView = document.getElementById('kc-chat-view');
    $composer = document.getElementById('kc-composer');
    $input = document.getElementById('kc-input');
    $sendBtn = document.getElementById('kc-send-btn');
    $newChatBtn = document.getElementById('kc-new-chat');
    $logoutBtn = document.getElementById('kc-logout');
    $userAvatar = document.getElementById('kc-avatar');
    $username = document.getElementById('kc-username');
    $headerTitle = document.getElementById('kc-header-title');
    $emptyState = document.getElementById('kc-empty-state');
    $messages = document.getElementById('kc-messages');
    $streamingIndicator = document.getElementById('kc-streaming-indicator');
    $stopBtn = document.getElementById('kc-stop-btn');
    $menuBtn = document.getElementById('kc-menu-btn');
  }

  function bindAppEvents() {
    $newChatBtn.onclick = createNewChat;
    $logoutBtn.onclick = logout;
    $sendBtn.onclick = sendMessage;
    $stopBtn.onclick = stopStreaming;

    $input.oninput = function() {
      this.style.height = 'auto';
      this.style.height = Math.min(this.scrollHeight, 200) + 'px';
      $sendBtn.disabled = !this.value.trim();
    };

    $input.onkeydown = function(e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (this.value.trim()) sendMessage();
      }
    };

    if ($menuBtn) {
      $menuBtn.onclick = function() {
        $sidebar.classList.toggle('kc-sidebar-open');
      };
    }

    document.addEventListener('click', function(e) {
      if (window.innerWidth <= 768 && $sidebar && $sidebar.classList.contains('kc-sidebar-open')) {
        if (e.target.closest('.kc-chat-item')) {
          $sidebar.classList.remove('kc-sidebar-open');
        }
      }
    });
  }

  function updateUserUI() {
    if (state.user) {
      $userAvatar.src = state.user.picture || 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><rect width="32" height="32" rx="16" fill="#6c5ce7"/><text x="16" y="20" text-anchor="middle" fill="white" font-size="14" font-family="sans-serif">' + (state.user.name ? state.user.name.charAt(0).toUpperCase() : 'U') + '</text></svg>');
      $username.textContent = state.user.name || state.user.email || 'User';
    }
  }

  function logout() {
    localStorage.removeItem(AUTH_TOKEN_KEY);
    localStorage.removeItem('kimi-chat-user');
    localStorage.removeItem(SESSION_KEY);
    disconnectWs();
    state.token = null;
    state.user = null;
    state.sessions = [];
    state.currentSessionId = null;
    state.messages = [];
    $app.style.display = 'none';
    $login.style.display = 'flex';
    if ($chatList) $chatList.innerHTML = '';
    if ($messages) $messages.innerHTML = '';
  }

  // ====== API HELPERS ======
  function apiHeaders() {
    var h = { 'Content-Type': 'application/json' };
    if (state.token) h['Authorization'] = 'Bearer ' + state.token;
    return h;
  }

  function apiFetch(path, opts) {
    opts = opts || {};
    opts.headers = Object.assign({}, apiHeaders(), opts.headers || {});
    return fetch(API_BASE + path, opts).then(function(r) {
      if (!r.ok) return r.text().then(function(t) { throw new Error(r.status + ': ' + t.slice(0, 200)); });
      return r.json().then(function(j) {
        if (j.code && j.code !== 0) throw new Error(j.msg || 'API error ' + j.code);
        return j.data || j;
      });
    });
  }

  // ====== SESSIONS ======
  function loadSessions() {
    apiFetch('/sessions?excludeEmpty=true').then(function(sessions) {
      state.sessions = sessions || [];
      renderChatList();
      var savedId = localStorage.getItem(SESSION_KEY);
      if (savedId && state.sessions.some(function(s) { return s.id === savedId; })) {
        selectSession(savedId);
      } else if (state.sessions.length > 0) {
        selectSession(state.sessions[0].id);
      } else {
        showEmptyState();
      }
    }).catch(function(err) {
      console.error('Failed to load sessions:', err);
      state.sessions = [];
      renderChatList();
      showEmptyState();
    });
  }

  function renderChatList() {
    if (!$chatList) return;
    $chatList.innerHTML = '';
    if (!state.sessions || state.sessions.length === 0) {
      $chatList.innerHTML = '<div class="kc-chat-empty">No conversations yet</div>';
      return;
    }
    state.sessions.forEach(function(s) {
      var item = document.createElement('div');
      item.className = 'kc-chat-item' + (s.id === state.currentSessionId ? ' active' : '');
      item.dataset.id = s.id;

      var title = s.summary || s.lastPrompt || s.id.slice(0, 8) || 'Chat';
      var preview = s.lastPrompt ? (s.lastPrompt.length > 40 ? s.lastPrompt.slice(0, 40) + '...' : s.lastPrompt) : 'Empty chat';
      var time = s.updatedAt ? timeAgo(s.updatedAt) : '';

      item.innerHTML =
        '<div class="kc-chat-item-info">' +
          '<div class="kc-chat-item-title">' + escapeHtml(title) + '</div>' +
          '<div class="kc-chat-item-preview">' + escapeHtml(preview) + '</div>' +
        '</div>' +
        '<div class="kc-chat-item-meta">' +
          '<span class="kc-chat-item-time">' + time + '</span>' +
          '<button class="kc-chat-item-del" data-id="' + s.id + '">' +
            '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>' +
          '</button>' +
        '</div>';

      item.querySelector('.kc-chat-item-info').onclick = function() { selectSession(s.id); };
      item.querySelector('.kc-chat-item-del').onclick = function(e) {
        e.stopPropagation();
        deleteSession(s.id);
      };

      $chatList.appendChild(item);
    });
  }

  function selectSession(sessionId) {
    state.currentSessionId = sessionId;
    localStorage.setItem(SESSION_KEY, sessionId);
    renderChatList();
    loadMessages(sessionId);
  }

  function createNewChat() {
    apiFetch('/sessions', { method: 'POST', body: JSON.stringify({}) }).then(function(session) {
      state.sessions.unshift(session);
      state.currentSessionId = session.id;
      localStorage.setItem(SESSION_KEY, session.id);
      renderChatList();
      showChatView();
      $messages.innerHTML = '';
      $composer.style.display = 'flex';
      $emptyState.style.display = 'none';
      $input.focus();
      connectWs(session.id);
    }).catch(function(err) {
      console.error('Failed to create session:', err);
    });
  }

  function deleteSession(sessionId) {
    if (!confirm('Delete this conversation?')) return;
    apiFetch('/sessions/' + sessionId, { method: 'DELETE' }).then(function() {
      state.sessions = state.sessions.filter(function(s) { return s.id !== sessionId; });
      if (state.currentSessionId === sessionId) {
        state.currentSessionId = null;
        localStorage.removeItem(SESSION_KEY);
        if (state.sessions.length > 0) selectSession(state.sessions[0].id);
        else showEmptyState();
      }
      renderChatList();
    }).catch(function(err) {
      console.error('Failed to delete session:', err);
    });
  }

  // ====== MESSAGES ======
  function loadMessages(sessionId) {
    showChatView();
    $messages.innerHTML = '<div class="kc-loading">Loading messages...</div>';
    $composer.style.display = 'none';

    apiFetch('/sessions/' + sessionId + '/messages').then(function(msgs) {
      state.messages = msgs || [];
      renderMessages();
      $composer.style.display = 'flex';
      connectWs(sessionId);
    }).catch(function(err) {
      console.error('Failed to load messages:', err);
      $messages.innerHTML = '<div class="kc-loading kc-error">Failed to load messages. Try again.</div>';
      $composer.style.display = 'flex';
      connectWs(sessionId);
    });
  }

  function renderMessages() {
    if (!$messages) return;
    $messages.innerHTML = '';
    if (!state.messages || state.messages.length === 0) {
      $messages.innerHTML = '<div class="kc-welcome-msg">Start a conversation with Kimi</div>';
      scrollToBottom();
      return;
    }
    state.messages.forEach(function(m) {
      appendMessage(m);
    });
    scrollToBottom();
  }

  function appendMessage(msg) {
    var div = document.createElement('div');
    div.className = 'kc-msg kc-msg-' + (msg.role === 'user' ? 'user' : 'assistant');
    div.dataset.id = msg.id || '';
    var content = '';
    if (msg.content && Array.isArray(msg.content)) {
      content = msg.content.map(function(c) { return c.text || ''; }).join('');
    } else {
      content = msg.content || msg.text || '';
    }
    div.innerHTML = msg.role === 'user'
      ? '<div class="kc-msg-content">' + escapeHtml(content) + '</div>'
      : '<div class="kc-msg-content kc-msg-markdown">' + renderMarkdown(content) + '</div>';
    $messages.appendChild(div);
    scrollToBottom();
  }

  function scrollToBottom() {
    requestAnimationFrame(function() {
      if ($chatView) $chatView.scrollTop = $chatView.scrollHeight;
    });
  }

  function showEmptyState() {
    if ($messages) $messages.innerHTML = '';
    if ($emptyState) $emptyState.style.display = 'flex';
    if ($composer) $composer.style.display = 'none';
    if ($streamingIndicator) $streamingIndicator.style.display = 'none';
    disconnectWs();
  }

  function showChatView() {
    if ($emptyState) $emptyState.style.display = 'none';
  }

  // ====== WEBSOCKET ======
  function disconnectWs() {
    if (state.reconnectTimer) {
      clearTimeout(state.reconnectTimer);
      state.reconnectTimer = null;
    }
    if (state.heartbeatTimer) {
      clearInterval(state.heartbeatTimer);
      state.heartbeatTimer = null;
    }
    if (state.ws) {
      try { state.ws.onclose = null; state.ws.close(); } catch(e) {}
      state.ws = null;
    }
    state.wsConnected = false;
    state.subscribed = false;
    state.wsReconnectAttempts = 0;
  }

  function connectWs(sessionId) {
    disconnectWs();

    // Use a persistent client_id stored in localStorage so the proxy can properly
    // close the old daemon TCP connection before opening a new one.
    // This prevents "WebSocket error" from multiple stale connections to the daemon.
    var clientId = localStorage.getItem('kimi-ws-client-id');
    if (!clientId) {
      clientId = 'chat-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
      localStorage.setItem('kimi-ws-client-id', clientId);
    }
    state.wsClientId = clientId;

    // Build WS URL with client_id so proxy can manage daemon connections
    var protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    var wsUrl = protocol + '//' + window.location.host + WS_BASE + '?client_id=' + encodeURIComponent(clientId);

    var ws = new WebSocket(wsUrl);
    state.ws = ws;

    ws.onopen = function() {
      state.wsConnected = true;
      state.wsReconnectAttempts = 0; // reset on successful connect
      // Send client_hello to initiate connection
      sendWs({
        type: 'client_hello',
        id: clientId + '-hello',
        payload: {
          client_id: clientId,
          subscriptions: ['sessions'],
          cursors: {}
        }
      });
    };

    ws.onmessage = function(event) {
      handleWsMessage(event.data, sessionId);
    };

    ws.onerror = function() {
      state.wsConnected = false;
    };

    ws.onclose = function() {
      state.wsConnected = false;
      state.subscribed = false;
      if (state.currentSessionId === sessionId) {
        // Exponential backoff: 2s, 4s, 8s, 16s, max 30s
        state.wsReconnectAttempts = (state.wsReconnectAttempts || 0) + 1;
        var delay = Math.min(2000 * Math.pow(2, state.wsReconnectAttempts - 1), 30000);
        state.reconnectTimer = setTimeout(function() { connectWs(sessionId); }, delay);
      }
    };
  }

  function sendHello() {
    if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return;
    state.ws.send(JSON.stringify({
      type: 'client_hello',
      id: state.wsClientId + '-hello',
      payload: {
        client_id: state.wsClientId,
        subscriptions: ['sessions'],
        cursors: {}
      }
    }));
    state.helloSent = true;
  }

  function subscribeToSession(sessionId) {
    if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return;
    state.ws.send(JSON.stringify({
      type: 'subscribe',
      id: state.wsClientId + '-sub-' + sessionId,
      payload: {
        session_ids: [sessionId],
        cursors: {}
      }
    }));
    state.subscribed = true;
  }

  function sendWsMessage(msg) {
    if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return;
    state.ws.send(JSON.stringify(msg));
  }

  function handleWsMessage(data, sessionId) {
    try {
      var msg = JSON.parse(data);
    } catch(e) {
      return;
    }

    // Handle system/control messages
    if (msg.type === 'server_hello') {
      // Server acknowledged our connection, now subscribe to the current session
      var heartbeatMs = msg.payload && msg.payload.heartbeat_ms;
      if (heartbeatMs) {
        // Set up ping interval — respond only to daemon pings with nonce
        state.heartbeatTimer = setInterval(function() {
          // Daemon sends actual ping messages, we respond in the 'ping' handler below
          // This interval just keeps the WS alive if daemon expects periodic activity
        }, Math.max(heartbeatMs - 1000, 10000));
      }
      if (state.currentSessionId) {
        subscribeToSession(state.currentSessionId);
      }
      return;
    }

    if (msg.type === 'ping') {
      var nonce = msg.payload && msg.payload.nonce;
      sendWsMessage({
        type: 'pong',
        id: state.wsClientId + '-pong',
        payload: { nonce: nonce || '' }
      });
      return;
    }

    if (msg.type === 'ack') {
      // Subscription acknowledged — got the session events
      return;
    }

    if (msg.type === 'error') {
      console.error('WS error:', msg.payload);
      return;
    }

    if (msg.type === 'resync_required') {
      // Session recreated, resubscribe
      if (state.currentSessionId) subscribeToSession(state.currentSessionId);
      return;
    }

    // Session events have session_id
    var sid = msg.session_id;
    if (sid && sid !== state.currentSessionId) return;

    // Handle streaming events
    var eventType = msg.type;
    var payload = msg.payload || {};

    if (eventType === 'turn.started') {
      // Turn started — user prompt was accepted
      state.turnId = payload.turnId;
      startStreaming();
      return;
    }

    if (eventType === 'assistant.delta') {
      if (payload.delta) {
        handleStreamText(payload.delta);
      }
      return;
    }

    if (eventType === 'thinking.delta') {
      // Show thinking text in assistant message
      if (payload.delta && state.streaming) {
        handleStreamText('[thinking] ' + payload.delta + ' [/thinking]');
      }
      return;
    }

    if (eventType === 'turn.ended') {
      finishStreaming();
      // Reload sessions and messages to get the final state
      setTimeout(function() {
        if (state.currentSessionId) {
          loadMessages(state.currentSessionId);
        }
      }, 500);
      return;
    }

    if (eventType === 'event.session.status_changed') {
      var status = payload.status;
      if (status === 'idle' && state.streaming) {
        // Session went idle — turn ended
        finishStreaming();
      }
      return;
    }

    if (eventType === 'session.error' || eventType === 'error') {
      if (state.streaming) finishStreaming();
      appendError(payload.msg || payload.error || 'Session error');
      return;
    }
  }

  // ====== STREAMING ======
  function startStreaming() {
    state.streaming = true;
    state.streamBuffer = '';
    state.streamMsgEl = null;
    $sendBtn.disabled = true;
    $input.disabled = true;
    $streamingIndicator.style.display = 'flex';
  }

  function handleStreamText(text) {
    if (!text) return;
    state.streamBuffer += text;

    if (!state.streamMsgEl) {
      state.streamMsgEl = document.createElement('div');
      state.streamMsgEl.className = 'kc-msg kc-msg-assistant kc-msg-streaming';
      state.streamMsgEl.innerHTML = '<div class="kc-msg-content kc-msg-markdown"></div>';
      if ($messages) $messages.appendChild(state.streamMsgEl);
    }

    var contentEl = state.streamMsgEl.querySelector('.kc-msg-content');
    if (contentEl) {
      contentEl.innerHTML = renderMarkdown(state.streamBuffer);
    }
    scrollToBottom();
  }

  function finishStreaming() {
    state.streaming = false;
    state.turnId = null;
    $sendBtn.disabled = false;
    $input.disabled = false;
    $streamingIndicator.style.display = 'none';
    if ($input) $input.focus();

    if (state.streamMsgEl) {
      state.streamMsgEl.classList.remove('kc-msg-streaming');
      state.streamMsgEl = null;
    }
    state.streamBuffer = '';
  }

  function stopStreaming() {
    // Abort the prompt via REST
    if (state.currentSessionId) {
      apiFetch('/sessions/' + state.currentSessionId + '/prompts', {}).then(function(data) {
        var active = data && data.active;
        if (active && active.prompt_id) {
          apiFetch('/sessions/' + state.currentSessionId + '/prompts/' + active.prompt_id + ':abort', {
            method: 'POST',
            body: JSON.stringify({})
          }).catch(function(e) {
            console.error('Failed to abort:', e);
          });
        }
      }).catch(function() {});
    }
    finishStreaming();
  }

  // ====== SEND MESSAGE ======
  function sendMessage() {
    var text = $input.value.trim();
    if (!text || state.streaming) return;

    $input.value = '';
    $input.style.height = 'auto';
    $sendBtn.disabled = true;

    // Add user message to UI immediately
    var userMsg = { role: 'user', content: [{ type: 'text', text: text }] };
    state.messages.push(userMsg);
    appendMessage(userMsg);

    // Send via REST POST /sessions/{id}/prompts
    apiFetch('/sessions/' + state.currentSessionId + '/prompts', {
      method: 'POST',
      body: JSON.stringify({
        content: [{ type: 'text', text: text }]
      })
    }).then(function(result) {
      // Prompt submitted successfully — streaming events will arrive via WS
      console.log('Prompt submitted:', result);
    }).catch(function(err) {
      if (!state.streaming) {
        appendError('Failed to send: ' + err.message);
        $sendBtn.disabled = false;
        $input.disabled = false;
      }
    });
  }

  function appendError(text) {
    var div = document.createElement('div');
    div.className = 'kc-msg kc-msg-error';
    div.innerHTML = '<div class="kc-msg-content">⚠️ ' + escapeHtml(text) + '</div>';
    if ($messages) {
      $messages.appendChild(div);
      scrollToBottom();
    }
  }

  // ====== MARKDOWN RENDERER ======
  function renderMarkdown(text) {
    if (!text) return '';
    var html = escapeHtml(text);

    // Code blocks (```...```)
    html = html.replace(/```(\w*)\n?([\s\S]*?)```/g, function(m, lang, code) {
      lang = lang || '';
      return '<pre class="kc-code-block"><code class="lang-' + escapeHtml(lang) + '">' + escapeHtml(code.trim()) + '</code></pre>';
    });

    // Inline code
    html = html.replace(/`([^`]+)`/g, '<code class="kc-inline-code">$1</code>');

    // Bold
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

    // Italic
    html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');

    // Links
    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');

    // Headers
    html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
    html = html.replace(/^## (.+)$/gm, '<h3>$1</h3>');
    html = html.replace(/^# (.+)$/gm, '<h3>$1</h3>');

    // Unordered lists
    html = html.replace(/^[\*\-]\s+(.+)$/gm, '<li>$1</li>');
    html = html.replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>');

    // Ordered lists
    html = html.replace(/^\d+\.\s+(.+)$/gm, '<li>$1</li>');

    // Blockquotes
    html = html.replace(/^>\s+(.+)$/gm, '<blockquote>$1</blockquote>');

    // Line breaks
    html = html.replace(/\n{2,}/g, '</p><p>');
    html = html.replace(/\n/g, '<br>');

    return '<p>' + html + '</p>';
  }

  // ====== UTILITIES ======
  function escapeHtml(str) {
    if (!str) return '';
    var div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function timeAgo(ts) {
    var now = Date.now();
    var diff = now - (typeof ts === 'number' ? ts : new Date(ts).getTime());
    var mins = Math.floor(diff / 60000);
    if (mins < 1) return 'now';
    if (mins < 60) return mins + 'm';
    var hrs = Math.floor(mins / 60);
    if (hrs < 24) return hrs + 'h';
    var days = Math.floor(hrs / 24);
    return days + 'd';
  }

  // ====== BOOT ======
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  window.__kimiChat = { state: state };
})();