const trustedInferenceLeaves = new WeakSet()
const trustedInferenceRouters = new WeakSet()

export function markInferenceOnlyLeaf(router) {
  if (!router || (typeof router !== 'object' && typeof router !== 'function')) throw new TypeError('inference leaf router is required')
  trustedInferenceLeaves.add(router)
  return router
}

export function isInferenceOnlyLeaf(router) {
  return Boolean(router && (typeof router === 'object' || typeof router === 'function') && trustedInferenceLeaves.has(router))
}

export function markInferenceOnlyRouter(router) {
  if (!router || (typeof router !== 'object' && typeof router !== 'function')) throw new TypeError('inference router is required')
  trustedInferenceRouters.add(router)
  return router
}

export function isInferenceOnlyRouter(router) {
  return Boolean(router && (typeof router === 'object' || typeof router === 'function') && trustedInferenceRouters.has(router))
}
