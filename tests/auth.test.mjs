// The auth-expiry banner and the Renew button.
//
// Renew was broken for months and failed SILENTLY: the click disabled the
// button, nothing opened, the button quietly relabelled itself, and the banner
// stayed. There was no way to tell a renew that worked from one that did
// nothing. Nothing in the other suites could catch it, because every name
// involved was defined and every file parsed.
//
// js/auth.js is a bare script sharing one global scope with the other pages, so
// it is wrapped here with the globals it expects and driven directly.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, '..', 'js', 'auth.js'), 'utf8');

let fails = 0;
const ok = (c, l, d = '') => { if (!c) fails++; console.log(`  ${c ? 'OK  ' : 'FAIL'} ${l}${d ? '  ' + d : ''}`); };

// ─── HARNESS ─────────────────────────────────────────────────────────────────

function fakeElement(id) {
  return {
    id,
    _listeners: {},
    style: { display: id === 'auth-expired-banner' ? 'none' : '' },
    classList: {
      _set: new Set(),
      add(...c) { c.forEach(x => this._set.add(x)); },
      remove(...c) { c.forEach(x => this._set.delete(x)); },
      toggle(c, on) { on ? this._set.add(c) : this._set.delete(c); },
      contains(c) { return this._set.has(c); }
    },
    textContent: '',
    innerHTML: '',
    disabled: false,
    addEventListener(ev, fn) { (this._listeners[ev] ||= []).push(fn); },
    async click() {
      for (const fn of (this._listeners.click || [])) await fn();
    }
  };
}

// Builds a fresh world and runs js/auth.js inside it.
function boot({ expiresInMs = null, googleReady = true } = {}) {
  const store = new Map();
  if (expiresInMs !== null) {
    store.set('googleAccessToken', 'saved-token');
    store.set('tokenExpiry', String(Date.now() + expiresInMs));
  }

  const els = new Map();
  for (const id of ['auth-expired-banner', 'auth-expired-text', 'auth-expired-signin-btn',
                    'signInBtn', 'authSection']) {
    els.set(id, fakeElement(id));
  }

  const calls = { requestAccessToken: 0, enableUpload: 0, reload: 0 };
  let tokenClientConfig = null;

  const doc = {
    _listeners: {},
    getElementById: (id) => els.get(id) || null,
    addEventListener(ev, fn) { (this._listeners[ev] ||= []).push(fn); },
    querySelector: () => null,
    querySelectorAll: () => [],
    body: fakeElement('body')
  };

  const google = googleReady ? {
    accounts: {
      oauth2: {
        initTokenClient(cfg) {
          tokenClientConfig = cfg;
          return { requestAccessToken: () => { calls.requestAccessToken++; } };
        }
      }
    }
  } : undefined;

  const win = { addEventListener() {}, showAuthExpiredBanner: null };

  // The globals auth.js reads from the other scripts, plus the two `let`s that
  // live in core.js.
  const preamble = `
    let accessToken = null;
    let tokenClient = null;
    const config = { clientId: 'test-client-id' };
    function enableUpload() { __calls.enableUpload++; }
    function showPage() {}
    function showMonthlyV2024() {}
  `;
  const epilogue = `
    return {
      initializeGoogleAuth, showAuthBanner, checkAuthExpiry, authEnsureTokenClient,
      authResetBannerButton, signOut,
      get tokenClient() { return tokenClient; },
      get accessToken() { return accessToken; }
    };
  `;

  const factory = new Function(
    'document', 'window', 'localStorage', 'google', 'setInterval', 'setTimeout',
    'clearTimeout', 'console', 'location', '__calls',
    `${preamble}\n${src}\n${epilogue}`
  );

  const api = factory(
    doc, win,
    { getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k) },
    google,
    () => 0,                                  // setInterval: never tick
    (fn, ms) => globalThis.setTimeout(fn, ms),
    (t) => globalThis.clearTimeout(t),
    console,
    { reload: () => { calls.reload++; } },
    calls
  );

  return { api, els, doc, win, calls, store, tokenConfig: () => tokenClientConfig,
           fireReady: async () => {
             for (const fn of (doc._listeners.DOMContentLoaded || [])) await fn();
           } };
}

const settle = () => new Promise(r => globalThis.setTimeout(r, 30));

// ─── THE BUG ─────────────────────────────────────────────────────────────────

console.log('\nTOKEN CLIENT  — created whether or not a valid token is stored');

{
  // The exact state Renew exists for: signed in, five minutes left. The old
  // code took an early return here and never built the client.
  const w = boot({ expiresInMs: 4 * 60 * 1000 });
  w.api.initializeGoogleAuth();
  ok(w.api.tokenClient !== null,
     'a still-valid token no longer skips building the token client',
     'this is the bug: Renew only ever runs while the token is still valid');
  ok(w.api.accessToken === 'saved-token', 'and the saved token is still adopted');
}

{
  const w = boot({ expiresInMs: -1000 });
  w.api.initializeGoogleAuth();
  ok(w.api.tokenClient !== null, 'an expired token builds it too');
  ok(w.api.accessToken === null, 'without adopting a token that has expired');
}

{
  const w = boot({});
  w.api.initializeGoogleAuth();
  ok(w.api.tokenClient !== null, 'and so does no token at all');
}

{
  const w = boot({ expiresInMs: 4 * 60 * 1000 });
  w.api.initializeGoogleAuth();
  const first = w.api.tokenClient;
  w.api.initializeGoogleAuth();
  ok(w.api.tokenClient === first,
     'calling it again reuses the client rather than replacing it',
     'the poll that waits for Google calls this repeatedly');
}

console.log('\nRENEW  — the click has to actually open something');

{
  const w = boot({ expiresInMs: 4 * 60 * 1000 });
  await w.fireReady();
  w.api.showAuthBanner('warn');
  const btn = w.els.get('auth-expired-signin-btn');
  ok(btn.textContent === 'Renew', 'the warning banner offers Renew');

  await btn.click();
  await settle();
  ok(w.calls.requestAccessToken === 1,
     'clicking it asks Google for a token',
     'it used to disable the button and do nothing at all');
}

{
  // Google's script had not arrived yet when the page loaded.
  const w = boot({ expiresInMs: 4 * 60 * 1000, googleReady: false });
  await w.fireReady();
  w.api.showAuthBanner('warn');
  const btn = w.els.get('auth-expired-signin-btn');
  await btn.click();
  await settle();
  ok(btn.disabled === false,
     'when the library never loads the button is given back',
     'it used to stay disabled on "Opening..." forever');
  ok(btn.textContent === 'Renew',
     'still labelled Renew, because the token has not expired',
     'the old fallback always wrote "Sign In", which read as a worse state');
  ok(/did not load/i.test(w.els.get('auth-expired-text').textContent),
     'and the banner says why');
}

console.log('\nOUTCOMES  — success and failure have to look different');

{
  const w = boot({ expiresInMs: 4 * 60 * 1000 });
  await w.fireReady();
  w.api.showAuthBanner('warn');
  const banner = w.els.get('auth-expired-banner');
  const text = w.els.get('auth-expired-text');

  w.tokenConfig().callback({ access_token: 'fresh-token' });
  ok(banner.classList.contains('done') && /renewed/i.test(text.textContent),
     'a renew confirms on screen before the banner goes',
     'a banner that just vanishes looks the same as one that did nothing');
  ok(w.api.accessToken === 'fresh-token' &&
     Number(w.store.get('tokenExpiry')) > Date.now() + 3000000,
     'and the new token is stored with a fresh hour on it');
  ok(w.calls.enableUpload > 0,
     'and the signed-in state is restored',
     'triggerCurrentPageLoad is defined inside auth.js, so it cannot be counted here');
}

{
  // The same callback runs on a FIRST sign-in, with no banner up.
  const w = boot({});
  await w.fireReady();
  const banner = w.els.get('auth-expired-banner');
  w.tokenConfig().callback({ access_token: 'fresh-token' });
  ok(!banner.classList.contains('done') && banner.style.display === 'none',
     'a first sign-in does not claim to have renewed anything',
     'there was no banner to clear, so a green confirmation would be a small lie');
}

{
  const w = boot({ expiresInMs: 4 * 60 * 1000 });
  await w.fireReady();
  w.api.showAuthBanner('warn');
  const btn = w.els.get('auth-expired-signin-btn');
  await btn.click();
  await settle();
  ok(btn.disabled === true, 'the button stays disabled while the popup is open');

  w.tokenConfig().error_callback({ type: 'popup_closed' });
  ok(btn.disabled === false && btn.textContent === 'Renew',
     'closing the popup gives the button back',
     'without an error_callback this state was unrecoverable without a reload');
  ok(/closed/i.test(w.els.get('auth-expired-text').textContent),
     'and says what happened');
}

{
  const w = boot({ expiresInMs: -1000 });
  await w.fireReady();
  w.api.showAuthBanner('expired');
  const btn = w.els.get('auth-expired-signin-btn');
  ok(btn.textContent === 'Sign In', 'an expired banner offers Sign In');
  w.api.authResetBannerButton('something went wrong');
  ok(btn.textContent === 'Sign In',
     'and a failure there keeps that label',
     'the label follows the token, not whichever path reset the button');
}

console.log('\nBANNER STATES');

{
  const w = boot({ expiresInMs: 4 * 60 * 1000 });
  w.api.checkAuthExpiry();
  const banner = w.els.get('auth-expired-banner');
  ok(banner.style.display === 'flex' && banner.classList.contains('warn'),
     'under five minutes raises the warning');
}

{
  const w = boot({ expiresInMs: 30 * 60 * 1000 });
  w.api.checkAuthExpiry();
  ok(w.els.get('auth-expired-banner').style.display === 'none',
     'half an hour out shows nothing');
}

{
  const w = boot({ expiresInMs: -1000 });
  w.api.checkAuthExpiry();
  const banner = w.els.get('auth-expired-banner');
  ok(banner.style.display === 'flex' && !banner.classList.contains('warn'),
     'past expiry drops the warning colour for the expired one');
}

{
  const w = boot({});
  w.api.checkAuthExpiry();
  ok(w.els.get('auth-expired-banner').style.display === 'none',
     'and never signed in shows nothing at all');
}

{
  // The 30-second check must not wipe a confirmation that is still up.
  const w = boot({ expiresInMs: 4 * 60 * 1000 });
  await w.fireReady();
  w.api.showAuthBanner('warn');
  w.tokenConfig().callback({ access_token: 'fresh-token' });
  w.api.checkAuthExpiry();
  ok(w.els.get('auth-expired-banner').classList.contains('done'),
     'the periodic check leaves a confirmation alone while it is showing');
}

console.log(fails === 0 ? '\nauth: all assertions pass\n' : `\nauth: ${fails} FAILED\n`);
process.exit(fails === 0 ? 0 : 1);
