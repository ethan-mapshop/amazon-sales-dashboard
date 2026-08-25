import { kv } from '@vercel/kv';
import { createHash, timingSafeEqual } from 'crypto';

// ─── SHARED AUTH ─────────────────────────────────────────────────────────────
// Lives outside api/ deliberately: only files under api/ become serverless
// functions, and Vercel's Hobby plan caps a deployment at 12 of them.
//
// WHAT THIS REPLACES. Every endpoint used to authenticate by asking Google
// "is this token live?" and discarding the answer — never checking which app
// minted it or whose account it belongs to. Any valid Google OAuth token, from
// any app, for any user, passed everything.
//
// The check here is CONJUNCTIVE, and each clause closes a different hole:
//
//   aud    — the token was minted for THIS app. Without it, a token any other
//            OAuth app issued for the same Google account still carries the
//            right email and sails through. Email alone is a confused deputy.
//   scope  — the token actually carries the email claim we're about to trust.
//   email_verified + allowlist — it's a specific person, not merely someone.
//
// ROLLOUT. AUTH_MODE=shadow (the default) computes the full verdict, logs it,
// and then applies the OLD behaviour. That makes the per-file swap a pure
// substitution with zero behaviour change, so `shadow` is a known-good
// rollback rather than a guess. Flip to `enforce` only after reading the logs
// (or ?action=whoami) and confirming the exact strings Google returns.
//
// Env:
//   GOOGLE_CLIENT_ID  must equal DEFAULT_CLIENT_ID in js/core.js
//   ALLOWED_EMAILS    comma-separated. UNSET DENIES — never fail open.
//   AUTH_MODE         'shadow' | 'enforce'   (default 'shadow')
//   CRON_SECRET       for Vercel cron callers

const TOKENINFO_URL = 'https://oauth2.googleapis.com/tokeninfo';
const VERDICT_TTL_MAX = 300;   // seconds
const EMAIL_SCOPES = [
  'https://www.googleapis.com/auth/userinfo.email',
  'email'
];

export function authMode() {
  return String(process.env.AUTH_MODE || 'shadow').toLowerCase() === 'enforce'
    ? 'enforce' : 'shadow';
}

function allowedEmails() {
  return String(process.env.ALLOWED_EMAILS || '')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
}

const DENY = (code, status, message) => ({ ok: false, code, status, message });

// ─── VERIFY ──────────────────────────────────────────────────────────────────

export async function verifyUser(req) {
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (!token) return { ...DENY('no_token', 401, 'No access token provided'), tokenLive: false };

  const cacheKey = `auth:verdict:${createHash('sha256').update(token).digest('hex')}`;
  try {
    const cached = await kv.get(cacheKey);
    if (cached) return { ...cached, cached: true };
  } catch { /* cache is an optimisation, never a gate */ }

  const info = await fetchTokenInfo(token);

  // A Google outage must NOT read as "your token is bad". Once the frontend
  // clears tokens on 401, conflating the two turns a transient blip into a
  // forced sign-out loop.
  if (info.transport === 'error' || info.status >= 500) {
    return { ...DENY('auth_unavailable', 503, 'Could not reach Google to verify sign-in'), tokenLive: false };
  }
  if (info.status !== 200) {
    return { ...DENY('invalid_token', 401, 'Invalid access token'), tokenLive: false };
  }

  const body = info.body || {};
  const aud = String(body.aud || body.azp || '');
  const email = String(body.email || '').trim().toLowerCase();
  const scopes = String(body.scope || '').split(/\s+/).filter(Boolean);
  // tokeninfo returns email_verified as the STRING "true", not a boolean.
  const emailVerified = body.email_verified === true || body.email_verified === 'true';

  const base = { tokenLive: true, aud, email, scopes, expiresIn: Number(body.expires_in) || 0 };

  const expectedAud = String(process.env.GOOGLE_CLIENT_ID || '').trim();
  const audMatches = !!expectedAud && (aud === expectedAud);

  let verdict;
  if (!expectedAud) {
    verdict = { ...base, ...DENY('client_unconfigured', 500, 'GOOGLE_CLIENT_ID is not configured'), audMatches };
  } else if (!audMatches) {
    verdict = { ...base, ...DENY('wrong_client', 401, 'Token was not issued for this application'), audMatches };
  } else if (!scopes.some(s => EMAIL_SCOPES.includes(s))) {
    verdict = { ...base, ...DENY('insufficient_scope', 401, 'Token is missing the email scope'), audMatches };
  } else if (!email || !emailVerified) {
    verdict = { ...base, ...DENY('insufficient_scope', 401, 'Token carries no verified email'), audMatches };
  } else {
    const allow = allowedEmails();
    if (!allow.length) {
      // Deny rather than allow: a dropped env var in a new environment must
      // not silently restore the hole this file exists to close.
      verdict = { ...base, ...DENY('allowlist_unconfigured', 403, 'Access control is not configured'), audMatches };
    } else if (!allow.includes(email)) {
      verdict = { ...base, ...DENY('not_allowed', 403, 'This Google account is not authorized'), audMatches };
    } else {
      verdict = { ...base, ok: true, code: 'ok', status: 200, audMatches };
    }
  }

  try {
    const ttl = Math.max(30, Math.min(VERDICT_TTL_MAX, verdict.expiresIn || VERDICT_TTL_MAX));
    await kv.set(cacheKey, verdict, { ex: ttl });
  } catch { /* non-fatal */ }

  return verdict;
}

// Google's tokeninfo takes the token in the query string, which writes a live
// credential into Google's logs and any intermediary. Try a form POST first and
// fall back, so we stop doing that wherever Google allows it.
async function fetchTokenInfo(token) {
  try {
    const post = await fetch(TOKENINFO_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ access_token: token }).toString()
    });
    if (post.status === 200) {
      return { status: 200, body: await post.json().catch(() => ({})), via: 'post' };
    }
    // 400 here can mean "bad token" OR "this endpoint wants a GET" — the GET
    // below settles it rather than guessing.
    if (post.status >= 500) return { status: post.status, body: null, via: 'post' };
  } catch { /* fall through to GET */ }

  try {
    const get = await fetch(`${TOKENINFO_URL}?access_token=${encodeURIComponent(token)}`);
    return {
      status: get.status,
      body: get.status === 200 ? await get.json().catch(() => ({})) : null,
      via: 'get'
    };
  } catch (err) {
    return { transport: 'error', status: 0, body: null, error: err.message };
  }
}

// ─── GATES ───────────────────────────────────────────────────────────────────

// Returns the verdict on success, or null after having already sent a response.
// The x-auth-error header is what the frontend's fetch interceptor reads — the
// body keeps the existing { error } shape so no current error rendering breaks.
export async function requireUser(req, res) {
  const verdict = await verifyUser(req);
  const mode = authMode();

  if (mode === 'enforce') {
    if (!verdict.ok) {
      res.setHeader('x-auth-error', verdict.code);
      res.status(verdict.status).json({ error: verdict.message });
      return null;
    }
    return verdict;
  }

  // Shadow: report what WOULD have happened, then apply the old behaviour
  // exactly — token merely live.
  console.log('[AUTH shadow]', JSON.stringify({
    ok: verdict.ok, code: verdict.code, email: verdict.email || null,
    audMatches: verdict.audMatches === true, path: req.url
  }));
  if (!verdict.tokenLive) {
    res.setHeader('x-auth-error', verdict.code === 'auth_unavailable' ? 'auth_unavailable' : 'invalid_token');
    res.status(verdict.code === 'auth_unavailable' ? 503 : 401)
       .json({ error: verdict.message || 'Invalid access token' });
    return null;
  }
  return verdict;
}

// Vercel only sends this header when CRON_SECRET existed AT DEPLOY TIME.
// Set the variable and redeploy BEFORE adding this check to a cron handler, or
// the daily pipelines fail silently and you find out days later as missing data.
export function verifyCron(req) {
  const expected = String(process.env.CRON_SECRET || '');
  if (!expected) return false;
  const got = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (!got || got.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(got), Buffer.from(expected));
  } catch {
    return false;
  }
}

// For handlers reachable by both a cron and a signed-in user.
export async function requireCronOrUser(req, res) {
  if (verifyCron(req)) return { ok: true, code: 'cron', actor: 'cron' };
  return requireUser(req, res);
}
