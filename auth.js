// auth.js — asks for the app password once, remembers it in this browser,
// and adds it (header x-app-password) to every call this page makes to its
// own /api routes. Calls to other websites never get the password.
(function () {
  var KEY = 'forgeAppPassword';
  var realFetch = window.fetch.bind(window);
  var pending = null;

  function load() { try { return localStorage.getItem(KEY) || ''; } catch (e) { return ''; } }
  function save(v) { try { v ? localStorage.setItem(KEY, v) : localStorage.removeItem(KEY); } catch (e) {} }
  var password = load();

  function needsPassword(url) {
    try {
      var u = new URL(url, location.href);
      var p = u.pathname.toLowerCase();
      return u.origin === location.origin && p.indexOf('/api/') === 0 && p !== '/api/health';
    } catch (e) { return false; }
  }

  function withPassword(input, init, pw) {
    var opts = Object.assign({}, init || {});
    var base = opts.headers || (input && typeof input === 'object' && input.headers) || undefined;
    var headers = new Headers(base);
    headers.set('x-app-password', pw);
    opts.headers = headers;
    return opts;
  }

  function ask(note) {
    if (pending) return pending;
    pending = new Promise(function (resolve) {
      function build() {
        var box = document.createElement('div');
        box.id = 'forge-lock';
        box.setAttribute('style', 'position:fixed;inset:0;z-index:2147483647;background:rgba(10,12,16,.92);display:flex;align-items:center;justify-content:center;padding:16px;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif');
        box.innerHTML =
          '<form style="background:#fff;color:#111;max-width:340px;width:100%;border-radius:14px;padding:22px;box-shadow:0 10px 40px rgba(0,0,0,.4)">' +
          '<div style="font-size:18px;font-weight:700;margin-bottom:6px">🔒 App password</div>' +
          '<div id="forge-lock-msg" style="font-size:14px;color:#555;margin-bottom:12px"></div>' +
          '<input id="forge-lock-input" type="password" autocomplete="current-password" placeholder="Password" ' +
          'style="width:100%;box-sizing:border-box;font-size:16px;padding:10px 12px;border:1px solid #ccc;border-radius:8px;background:#fff;color:#111">' +
          '<button type="submit" style="margin-top:12px;width:100%;font-size:16px;padding:10px;border:0;border-radius:8px;background:#111;color:#fff;cursor:pointer">Unlock</button>' +
          '</form>';
        document.body.appendChild(box);
        var msg = box.querySelector('#forge-lock-msg');
        var input = box.querySelector('#forge-lock-input');
        msg.textContent = note || 'Enter the password once. This browser will remember it.';
        input.focus();
        box.querySelector('form').addEventListener('submit', function (ev) {
          ev.preventDefault();
          var tryPw = input.value;
          if (!tryPw) return;
          msg.textContent = 'Checking…';
          realFetch('/api/auth/check', { headers: { 'x-app-password': tryPw } }).then(function (r) {
            if (r.ok) {
              password = tryPw; save(tryPw);
              box.remove(); pending = null; resolve(tryPw);
            } else if (r.status === 429) {
              msg.textContent = 'Too many wrong tries. Wait 15 minutes, then try again.';
            } else if (r.status === 503) {
              msg.textContent = 'This app is locked: APP_PASSWORD is not set in Railway yet.';
            } else {
              msg.textContent = 'Wrong password. Try again.';
              input.value = ''; input.focus();
            }
          }).catch(function () { msg.textContent = 'Could not reach the server. Check your connection.'; });
        });
      }
      if (document.body) build(); else document.addEventListener('DOMContentLoaded', build);
    });
    return pending;
  }

  window.fetch = function (input, init) {
    var url = typeof input === 'string' ? input : (input && input.url) || String(input);
    if (!needsPassword(url)) return realFetch(input, init);
    var start = password ? Promise.resolve(password) : ask();
    return start.then(function (pw) {
      return realFetch(input, withPassword(input, init, pw)).then(function (r) {
        if (r.status !== 401) return r;
        password = ''; save('');
        return ask('Password needed (it may have changed). Enter it again.').then(function (pw2) {
          return realFetch(input, withPassword(input, init, pw2));
        });
      });
    });
  };

  // Ask straight away on the front page if this browser has no password yet.
  if (!password) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { if (!password) ask(); });
    else ask();
  }
})();
