/** Only ordinary web addresses reach the device browser, never arbitrary OS schemes. */
function externalWebTarget(value) {
  if (typeof value !== "string" || value.length > 8192 || /[\x00-\x20\x7f]/.test(value)) return null;
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password) return null;
    return url.href;
  } catch { return null; }
}

module.exports = { externalWebTarget };
