const VALID_CONFIG_KEY = /^[a-zA-Z][a-zA-Z0-9_]*$/;

/**
 * Deep-sets a dot-notation key on a plain config object.
 * Validates every segment against a strict identifier regex and an explicit
 * deny-list so user-supplied paths cannot reach Object.prototype.
 *
 * Uses Object.defineProperty instead of bracket assignment to avoid
 * prototype-polluting-assignment sinks.
 */
export function setNestedValue(obj, key, value) {
  const parts = key.split('.');
  const last = parts.pop();

  const target = parts.reduce((o, k) => {
    if (k === '__proto__' || k === 'constructor' || k === 'prototype' || !VALID_CONFIG_KEY.test(k)) {
      throw new Error(`Invalid key segment: ${k}`);
    }
    const child =
      Object.prototype.hasOwnProperty.call(o, k) && typeof o[k] === 'object' && o[k] !== null
        ? o[k]
        : {};
    Object.defineProperty(o, k, { value: child, writable: true, enumerable: true, configurable: true });
    return child;
  }, obj);

  if (last === '__proto__' || last === 'constructor' || last === 'prototype' || !VALID_CONFIG_KEY.test(last)) {
    throw new Error(`Invalid key segment: ${last}`);
  }
  Object.defineProperty(target, last, { value, writable: true, enumerable: true, configurable: true });
}

export function getNestedValue(obj, key) {
  const parts = key.split('.');
  for (const part of parts) {
    if (part === '__proto__' || part === 'constructor' || part === 'prototype' || !VALID_CONFIG_KEY.test(part)) {
      throw new Error(`Invalid key segment: ${part}`);
    }
  }
  return parts.reduce((o, k) => o?.[k], obj);
}

export function coerceConfigValue(v) {
  if (v === 'true') return true;
  if (v === 'false') return false;
  const trimmed = v.trim();
  if (trimmed !== '' && !isNaN(trimmed)) return Number(trimmed);
  return v;
}
