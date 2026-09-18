const MAX_PROMPT_BYTES = 64 * 1024

function isBoundedString(value, maximum = 256) {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum
}

export function validateModelRouter(router) {
  if (!router || typeof router !== 'object') throw new TypeError('model router is required')
  if (!isBoundedString(router.routerId)) throw new TypeError('model router id is required')
  if (typeof router.route !== 'function') throw new TypeError('model router requires route()')
  return router
}

export function createDeterministicModelRouter({
  routerId = 'deterministic-test-router',
  responder,
} = {}) {
  if (!isBoundedString(routerId)) throw new TypeError('model router id is required')
  if (typeof responder !== 'function') throw new TypeError('deterministic router requires responder()')

  const calls = []
  return validateModelRouter(Object.freeze({
    routerId,
    async route(prompt, context = {}) {
      if (!isBoundedString(prompt, MAX_PROMPT_BYTES)) throw new TypeError('model prompt is invalid')
      const call = Object.freeze({ prompt, context: structuredClone(context) })
      calls.push(call)
      const response = await responder(prompt, structuredClone(context))
      if (response === undefined) throw new TypeError('model response is required')
      return structuredClone(response)
    },
    calls() {
      return structuredClone(calls)
    },
  }))
}
