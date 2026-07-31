export function safeReturnPath(value: unknown, fallback = '/') {
  if (typeof value !== 'string' || !value.startsWith('/') || value.length > 2_048) return fallback
  if (/[\\\u0000-\u001f\u007f]/.test(value)) return fallback

  try {
    const decoded = decodeURIComponent(value)
    if (decoded.startsWith('//') || /[\\\u0000-\u001f\u007f]/.test(decoded)) return fallback
    const base = new URL('https://journey-unfinished.invalid')
    const target = new URL(value, base)
    if (target.origin !== base.origin) return fallback
    return `${target.pathname}${target.search}${target.hash}`
  } catch {
    return fallback
  }
}
