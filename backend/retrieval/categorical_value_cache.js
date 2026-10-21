const cache = new Map();

function keyFor(sourceId, table, column) {
  return [sourceId, table, column].map(value => String(value || "").trim().toLowerCase()).join("\u0000");
}

export function getCategoricalValues(sourceId, table, column, now = Date.now()) {
  const key = keyFor(sourceId, table, column);
  const item = cache.get(key);
  if (!item || item.expires_at <= now) {
    cache.delete(key);
    return null;
  }
  return [...item.values];
}

export function setCategoricalValues(sourceId, table, column, values, ttlMs = 30_000, now = Date.now()) {
  const key = keyFor(sourceId, table, column);
  const unique = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    if (value === null || value === undefined) continue;
    const text = String(value).trim();
    if (!text) continue;
    const normalized = text.toLocaleLowerCase();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    unique.push(text);
  }
  cache.set(key, { values: unique.slice(0, 200), expires_at: now + Math.max(1, Number(ttlMs) || 30_000) });
  return [...unique.slice(0, 200)];
}

export function clearCategoricalValueCache() {
  cache.clear();
}

export function categoricalValueCacheSize() {
  return cache.size;
}

export default {
  getCategoricalValues,
  setCategoricalValues,
  clearCategoricalValueCache,
  categoricalValueCacheSize
};
