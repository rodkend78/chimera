// Serialized by chrome.scripting: self-contained, fixed code only.
export function inspectDocument(mode, expectedUrl, expiresAt) {
  if (expiresAt !== undefined && (!Number.isFinite(expiresAt) || expiresAt <= Date.now())) return { error: 'expired' }
  const url = new URL(location.href)
  const host = url.hostname.toLowerCase()
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !host.includes('.') || host.endsWith('.') || /[:\[\]]/.test(host) || /^[\d.]+$/.test(host) || /(?:^|\.)(?:localhost|local|internal|lan|home|test|invalid)$/.test(host)) return { error: 'human-action-required' }
  let pathname
  try { pathname = decodeURIComponent(url.pathname) } catch { return { error: 'human-action-required' } }
  if (/(^|\.)(accounts\.google\.com|login\.microsoftonline\.com|login\.live\.com|appleid\.apple\.com|auth0\.com|okta\.com)$/.test(host) || /(?:^|\/)(?:login|log-in|signin|sign-in|signup|sign-up|auth|oauth|oauth2|sso|recover\w*|reset\w*|consent|authorize|verify|mfa|payment|checkout)(?:\/|$|[._-])/i.test(pathname)) return { error: 'authentication' }
  // Check hidden authentication controls too; never inspect a field's value.
  const scan = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_ELEMENT)
  let node; let count = 0
  while ((node = scan.nextNode())) {
    if (++count > 10000) return { error: 'human-action-required' }
    if (node.matches('input[type="password"], [autocomplete~="one-time-code"], [autocomplete~="webauthn"]') || /(?:password|passwd|otp|passkey|captcha|verification.?code|security.?code)/i.test([node.getAttribute('name'), node.id, node.getAttribute('autocomplete'), node.getAttribute('aria-label')].join(' '))) return { error: 'authentication' }
  }
  if (mode !== 'read') return { url: url.href, origin: url.origin }
  // The exact expected URL is nonsecret process-local state, never transmitted
  // to the host. This synchronous comparison fences same-document navigation.
  if (expectedUrl !== undefined && url.href !== expectedUrl) return { error: 'stale' }
  const excluded = 'input,textarea,select,option,form,[contenteditable]:not([contenteditable="false"]),script,style,template,noscript,iframe,object,embed,[hidden],[aria-hidden="true"]'
  const root = document.body || document.documentElement
  if (root.closest(excluded) || [root, document.documentElement].some(n => { const s = getComputedStyle(n); return s.display === 'none' || s.visibility !== 'visible' || Number(s.opacity) === 0 })) return { url: url.href, origin: url.origin, text: '' }
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, { acceptNode(n) {
    if (n.nodeType === Node.ELEMENT_NODE) {
      const style = getComputedStyle(n)
      if (n.matches(excluded) || style.display === 'none' || style.visibility !== 'visible' || Number(style.opacity) === 0) return NodeFilter.FILTER_REJECT
      return NodeFilter.FILTER_SKIP
    }
    return NodeFilter.FILTER_ACCEPT
  } })
  const encoder = new TextEncoder(); let text = ''; let bytes = 0; count = 0
  while ((node = walker.nextNode())) {
    if (++count > 10000) break
    const value = node.textContent.slice(0, 131072).replace(/\s+/g, ' ').trim()
    if (!value) continue
    const range = document.createRange(); range.selectNodeContents(node)
    if (!Array.from(range.getClientRects()).some(r => r.width > 0 && r.height > 0)) continue
    for (const char of (text ? '\n' : '') + value) {
      const size = encoder.encode(char).length
      if (bytes + size > 32768) return { url: url.href, origin: url.origin, text }
      text += char; bytes += size
    }
  }
  return { url: url.href, origin: url.origin, text }
}
