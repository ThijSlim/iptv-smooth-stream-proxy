const secrets = new Set();
let debugEnabled = false;

export function setDebug(on) {
  debugEnabled = on;
}

export const isDebug = () => debugEnabled;

export function addSecret(value) {
  if (value && value.length >= 3) secrets.add(value);
}

// Hides provider credentials in URLs before they reach the console.
export function redact(text) {
  let out = String(text)
    .replace(/([?&](?:username|password|user|pass|token)=)[^&#\s"]*/gi, '$1***')
    .replace(/\/(live|movie|series|timeshift)\/[^/\s]+\/[^/\s]+\//gi, '/$1/***/***/')
    .replace(/\/\/[^/@\s]+@/g, '//***@');
  for (const secret of secrets) out = out.split(secret).join('***');
  return out;
}

export function log(message) {
  console.log(`${new Date().toISOString()} ${redact(message)}`);
}

export function debug(message) {
  if (debugEnabled) console.log(`${new Date().toISOString()} [debug] ${redact(message)}`);
}

export function describeError(err) {
  const cause = err.cause;
  return cause ? `${err.message} (${cause.code ?? cause.message})` : err.message;
}

// In debug mode returns a snippet of an error response body, e.g. a provider's "max connections" message.
export async function errorDetail(res) {
  if (!debugEnabled) {
    res.body?.cancel().catch(() => {});
    return '';
  }
  const text = await res.text().catch(() => '');
  return text ? `: ${JSON.stringify(text.slice(0, 200))}` : '';
}

export async function tracedFetch(url, init = {}) {
  if (!debugEnabled) return fetch(url, init);
  const started = Date.now();
  debug(`upstream => ${init.method ?? 'GET'} ${url}`);
  try {
    const res = await fetch(url, init);
    const redirect = res.redirected ? ` (redirected to ${res.url})` : '';
    debug(`upstream <= ${res.status} ${res.headers.get('content-type') ?? '-'} ${Date.now() - started}ms ${url}${redirect}`);
    return res;
  } catch (err) {
    debug(`upstream <= failed after ${Date.now() - started}ms ${url}: ${describeError(err)}`);
    throw err;
  }
}
