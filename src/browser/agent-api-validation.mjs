export function exactAgentBody(body, fields, code, required = fields) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)
    || Object.getPrototypeOf(body) !== Object.prototype
    || Object.keys(body).some((key) => !fields.includes(key))
    || required.some((key) => !Object.hasOwn(body, key))) {
    throw Object.assign(new TypeError(code), { code })
  }
  return body
}
