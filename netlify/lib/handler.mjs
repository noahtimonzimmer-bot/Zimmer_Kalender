// Server side of the calendar. It never sees the password or the entries:
// the browser sends a key derived from the password (only its hash is stored)
// and the entries arrive already encrypted.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

// Hash of the key the browser derives from the initial password "sirralf".
// Used only until the password is changed in the settings.
const DEFAULT_AUTH_HASH = '3c89217be33df350a98fc9b8aa4edbb74f75474d7ab3cd22c7a2de06b7b37c74';

const SESSION_DAYS = 30;
const MAX_FAILS = 5;
const LOCK_MINUTES = 10;
const MAX_CIPHERTEXT = 5_000_000;

const sha256 = (text) => createHash('sha256').update(text).digest('hex');

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

function sameHash(a, b) {
  const x = Buffer.from(a, 'hex');
  const y = Buffer.from(b, 'hex');
  return x.length === y.length && timingSafeEqual(x, y);
}

function isString(value, max) {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

function validVault(body) {
  return isString(body.encSalt, 100) && isString(body.iv, 100)
    && isString(body.ciphertext, MAX_CIPHERTEXT) && Number.isInteger(body.baseVersion);
}

function checkAuthKey(vault, authKey) {
  if (!isString(authKey, 200)) return false;
  const auth = vault && vault.auth;
  return auth
    ? sameHash(sha256(`${auth.salt}:${authKey}`), auth.hash)
    : sameHash(sha256(authKey), DEFAULT_AUTH_HASH);
}

function publicVault(vault) {
  if (!vault) return { version: 0 };
  const { version, encSalt, iv, ciphertext } = vault;
  return { version, encSalt, iv, ciphertext };
}

export function createHandler(getStore) {
  async function readVault(store) {
    const result = await store.getWithMetadata('vault', { type: 'json' });
    return result ? { vault: result.data, etag: result.etag } : { vault: null, etag: null };
  }

  // Writes the vault only if nobody else changed it in the meantime.
  async function writeVault(store, current, etag, body, auth) {
    const currentVersion = current ? current.version : 0;
    if (body.baseVersion !== currentVersion) return null;
    const next = {
      version: currentVersion + 1,
      encSalt: body.encSalt,
      iv: body.iv,
      ciphertext: body.ciphertext,
      auth: auth || (current && current.auth) || null,
    };
    const result = await store.setJSON('vault', next, etag ? { onlyIfMatch: etag } : { onlyIfNew: true });
    if (result && result.modified === false) return null;
    return next;
  }

  async function login(store, body) {
    const now = Date.now();
    const guard = (await store.get('guard', { type: 'json' })) || { fails: 0, lockUntil: 0 };
    if (guard.lockUntil > now) {
      return json({ error: 'locked', minutes: Math.ceil((guard.lockUntil - now) / 60000) }, 429);
    }
    const { vault } = await readVault(store);
    if (!checkAuthKey(vault, body.authKey)) {
      guard.fails += 1;
      if (guard.fails >= MAX_FAILS) {
        guard.fails = 0;
        guard.lockUntil = now + LOCK_MINUTES * 60000;
      }
      await store.setJSON('guard', guard);
      return json({ error: 'wrong password' }, 401);
    }
    if (guard.fails || guard.lockUntil) await store.setJSON('guard', { fails: 0, lockUntil: 0 });

    const token = randomBytes(32).toString('base64url');
    const sessions = (await store.get('sessions', { type: 'json' })) || {};
    for (const [key, expires] of Object.entries(sessions)) if (expires < now) delete sessions[key];
    sessions[sha256(token)] = now + SESSION_DAYS * 86400000;
    await store.setJSON('sessions', sessions);
    return json({ token, vault: publicVault(vault) });
  }

  async function sessionOf(store, req) {
    const match = /^Bearer (.+)$/.exec(req.headers.get('authorization') || '');
    if (!match) return null;
    const key = sha256(match[1]);
    const sessions = (await store.get('sessions', { type: 'json' })) || {};
    return sessions[key] > Date.now() ? key : null;
  }

  async function saveData(store, body) {
    if (!validVault(body)) return json({ error: 'invalid' }, 400);
    const { vault, etag } = await readVault(store);
    const next = await writeVault(store, vault, etag, body);
    if (!next) return json({ error: 'conflict' }, 409);
    return json({ version: next.version });
  }

  async function changePassword(store, body, session) {
    if (!validVault(body) || !isString(body.newAuthKey, 200)) return json({ error: 'invalid' }, 400);
    const { vault, etag } = await readVault(store);
    if (!checkAuthKey(vault, body.oldAuthKey)) return json({ error: 'wrong password' }, 403);
    const salt = randomBytes(16).toString('hex');
    const auth = { salt, hash: sha256(`${salt}:${body.newAuthKey}`) };
    // Entries and password change together in one write, so they always match.
    const next = await writeVault(store, vault, etag, body, auth);
    if (!next) return json({ error: 'conflict' }, 409);
    // Sign out all other devices.
    const sessions = (await store.get('sessions', { type: 'json' })) || {};
    await store.setJSON('sessions', { [session]: sessions[session] });
    return json({ version: next.version });
  }

  async function logout(store, session) {
    const sessions = (await store.get('sessions', { type: 'json' })) || {};
    delete sessions[session];
    await store.setJSON('sessions', sessions);
    return json({ ok: true });
  }

  return async function handler(req) {
    const store = getStore();
    const route = new URL(req.url).pathname.replace(/^\/api\/?/, '');
    try {
      if (req.method === 'POST' && route === 'login') return await login(store, await req.json());
      const session = await sessionOf(store, req);
      if (!session) return json({ error: 'unauthorized' }, 401);
      if (req.method === 'GET' && route === 'data') {
        return json(publicVault((await readVault(store)).vault));
      }
      if (req.method === 'PUT' && route === 'data') return await saveData(store, await req.json());
      if (req.method === 'POST' && route === 'password') {
        return await changePassword(store, await req.json(), session);
      }
      if (req.method === 'POST' && route === 'logout') return await logout(store, session);
      return json({ error: 'not found' }, 404);
    } catch (err) {
      console.error(err);
      return json({ error: 'server error' }, 500);
    }
  };
}
