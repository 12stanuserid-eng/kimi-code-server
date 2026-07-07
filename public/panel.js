(function() {
  if (document.getElementById('ks-btn')) return;

  var css = document.createElement('link');
  css.rel = 'stylesheet';
  css.href = '/kimi-admin/panel.css';
  document.head.appendChild(css);

  var d = document.createElement('div');
  d.id = 'ks-root';
  d.innerHTML =
    '<button id="ks-btn" title="Provider Settings">&#x2699;&#xFE0F;</button>' +
    '<div id="ks-modal">' +
      '<div id="ks-box">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">' +
          '<h2 style="margin:0;color:#6c5ce7">Provider Settings</h2>' +
          '<button onclick="ksC()" style="background:none;border:none;color:#888;font-size:22px;cursor:pointer">&#x2716;</button>' +
        '</div>' +
        '<div id="ks-st"></div>' +
        '<div id="ks-l"><div class="ks-wait">Loading...</div></div>' +
        '<hr style="border-color:#333;margin:16px 0">' +
        '<div style="text-align:right;font-size:12px;color:#555" id="ks-em"></div>' +
        '<label>Provider ID</label>' +
        '<input id="ks-id" placeholder="e.g. my-provider">' +
        '<label>Base URL</label>' +
        '<input id="ks-url" placeholder="https://api.example.com/v1">' +
        '<label>API Key</label>' +
        '<input id="ks-key" type="password" placeholder="sk-...">' +
        '<label>Type</label>' +
        '<select id="ks-typ" onchange="ksTp()">' +
          '<option value="openai">OpenAI Compatible</option>' +
          '<option value="anthropic">Anthropic</option>' +
          '<option value="google">Gemini</option>' +
          '<option value="custom">Custom</option>' +
        '</select>' +
        '<input id="ks-ctyp" placeholder="e.g. ollama, vllm, together" style="display:none;margin-top:-4px">' +
        '<div class="ks-f">' +
          '<button class="ks-p" style="flex:2" onclick="ksS()">Save</button>' +
          '<button class="ks-g" onclick="ksCf()" style="flex:1">Clear</button>' +
        '</div>' +
        '<hr style="border-color:#333;margin:16px 0">' +
        '<div class="ks-f">' +
          '<button class="ks-p" onclick="ksR()">Restart Daemon</button>' +
          '<button class="ks-g" onclick="ksRef()">Refresh</button>' +
          '<button class="ks-g" onclick="ksC()">Close</button>' +
        '</div>' +
      '</div>' +
    '</div>';
  document.body.appendChild(d);

  window.ksC = function() { document.getElementById('ks-modal').style.display = 'none'; };

  document.getElementById('ks-btn').onclick = function() {
    ksRef();
    document.getElementById('ks-modal').style.display = 'flex';
  };

  document.getElementById('ks-modal').onclick = function(e) {
    if (e.target === this) ksC();
  };

  window.ksCf = function() {
    document.getElementById('ks-id').value = '';
    document.getElementById('ks-url').value = '';
    document.getElementById('ks-key').value = '';
    document.getElementById('ks-typ').value = 'openai';
    document.getElementById('ks-em').textContent = '';
    var ct = document.getElementById('ks-ctyp');
    if (ct) { ct.style.display = 'none'; ct.value = ''; }
  };

  window.ksTp = function() {
    var t = document.getElementById('ks-typ').value;
    var ct = document.getElementById('ks-ctyp');
    if (t === 'custom') { ct.style.display = 'block'; ct.focus(); }
    else { ct.style.display = 'none'; ct.value = ''; }
  };

  window.ksSt = function(m, t) {
    var x = document.getElementById('ks-st');
    x.textContent = m;
    x.className = t || 'ks-ok';
    x.style.display = 'block';
    if (t !== 'ks-wait') setTimeout(function() { x.style.display = 'none'; }, 4000);
  };

  window.ksRef = function() {
    var l = document.getElementById('ks-l');
    l.innerHTML = '<div class="ks-wait">Loading...</div>';
    fetch('/kimi-admin/providers').then(function(r) { return r.json(); }).then(function(d) {
      if (!d.success || !d.providers) { l.innerHTML = '<div class="ks-bad" style="padding:12px">Failed</div>'; return; }
      if (d.providers.length === 0) { l.innerHTML = '<div style="color:#888;padding:12px;text-align:center">No providers.</div>'; return; }
      l.innerHTML = d.providers.map(function(p) {
        var del = (p.id !== 'opencode-zen' && p.id !== 'omniroute') ? '<button class="ks-s ks-d" onclick="ksD(\'' + p.id + '\')">Del</button>' : '';
        return '<div class="ks-r"><div class="ks-i"><div class="ks-n">' + p.id + '</div><div class="ks-dt">' + p.type + ' &middot; ' + p.base_url + '</div><div class="ks-k">' + (p.has_api_key ? '&#x2705; ' + p.api_key_masked : '&#x26A0;&#xFE0F; No key') + '</div></div><div class="ks-a"><button class="ks-s ks-p" onclick="ksE(\'' + p.id + '\',\'' + p.type + '\',\'' + p.base_url.replace(/'/g, '') + '\')">Edit</button>' + del + '</div></div>';
      }).join('');
    }).catch(function(e) { l.innerHTML = '<div class="ks-bad" style="padding:12px">' + e.message + '</div>'; });
  };

  window.ksE = function(id, type, url) {
    document.getElementById('ks-id').value = id;
    document.getElementById('ks-url').value = url;
    document.getElementById('ks-key').value = '';
    var sel = document.getElementById('ks-typ');
    var ct = document.getElementById('ks-ctyp');
    var known = ['openai', 'anthropic', 'google'];
    if (known.indexOf(type) === -1) { sel.value = 'custom'; ct.value = type; ct.style.display = 'block'; }
    else { sel.value = type || 'openai'; ct.style.display = 'none'; ct.value = ''; }
    document.getElementById('ks-em').textContent = 'Editing: ' + id + ' (leave key blank to keep)';
  };

  window.ksS = function() {
    var id = document.getElementById('ks-id').value.trim();
    var url = document.getElementById('ks-url').value.trim();
    var key = document.getElementById('ks-key').value.trim();
    var typ = document.getElementById('ks-typ').value;
    if (typ === 'custom') { var ct = document.getElementById('ks-ctyp').value.trim(); if (ct) typ = ct; else { ksSt('Enter custom type name', 'ks-bad'); return; } }
    if (!id || !url) { ksSt('ID and URL required', 'ks-bad'); return; }
    var b = JSON.stringify({ id: id, type: typ, base_url: url, api_key: key });
    fetch('/kimi-admin/providers', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: b }).then(function(r) { return r.json(); }).then(function(d) {
      if (d.success) { ksSt('Saved! Restart to apply.', 'ks-ok'); ksRef(); ksCf(); } else { ksSt('Error: ' + (d.error || '?'), 'ks-bad'); }
    }).catch(function(e) { ksSt('Error: ' + e.message, 'ks-bad'); });
  };

  window.ksD = function(id) {
    if (!confirm('Delete provider "' + id + '"? This removes its models too.')) return;
    fetch('/kimi-admin/providers/' + encodeURIComponent(id), { method: 'DELETE' }).then(function(r) { return r.json(); }).then(function(d) {
      if (d.success) { ksSt('Deleted!', 'ks-ok'); ksRef(); } else { ksSt('Error: ' + (d.error || '?'), 'ks-bad'); }
    }).catch(function(e) { ksSt('Error: ' + e.message, 'ks-bad'); });
  };

  window.ksR = function() {
    if (!confirm('Restart daemon? Disconnects active chats briefly.')) return;
    ksSt('Restarting...', 'ks-wait');
    document.getElementById('ks-st').style.display = 'block';
    fetch('/kimi-admin/restart-daemon', { method: 'POST' }).then(function(r) { return r.json(); }).then(function(d) {
      if (d.success) { ksSt('Restart initiated! Reconnecting...', 'ks-ok'); setTimeout(ksRef, 5000); } else { ksSt(d.message || 'Not running', 'ks-bad'); }
    }).catch(function(e) { ksSt('Error: ' + e.message, 'ks-bad'); });
  };

  // Re-observe in case app removes our button
  var obs = new MutationObserver(function() {
    if (!document.getElementById('ks-btn')) {
      // Button was removed, re-add it (but not the whole panel)
      var btn = document.createElement('button');
      btn.id = 'ks-btn';
      btn.title = 'Provider Settings';
      btn.innerHTML = '&#x2699;&#xFE0F;';
      btn.onclick = function() { ksRef(); document.getElementById('ks-modal').style.display = 'flex'; };
      document.body.appendChild(btn);
    }
  });
  obs.observe(document.body, { childList: true, subtree: true });
})();
