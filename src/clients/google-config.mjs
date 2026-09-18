import { intakeError } from './intake-store.mjs'

export const GOOGLE_ACCOUNT_ENV = 'CHIMERA_GOOGLE_ACCOUNT'
export const GOOGLE_FORM_ID_ENV = 'CHIMERA_GOOGLE_FORM_ID'

export const validGoogleAccount = value => typeof value === 'string' && value.length <= 254
  && /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,}$/.test(value)
export const validGoogleFormId = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && /^[A-Za-z0-9_-]+$/.test(value)

function envText(env, name) {
  if (!Object.hasOwn(env ?? {}, name) || env[name] === undefined || env[name] === '') return ''
  if (typeof env[name] !== 'string') throw intakeError('GOOGLE_CONFIG_INVALID')
  return env[name].trim()
}

export function googleFormIdFromEnv(env = process.env) {
  const formId = envText(env, GOOGLE_FORM_ID_ENV)
  if (!formId) return null
  if (!validGoogleFormId(formId)) throw intakeError('GOOGLE_CONFIG_INVALID')
  return formId
}

export function googleConfigFromEnv(env = process.env) {
  const account = envText(env, GOOGLE_ACCOUNT_ENV).toLowerCase()
  const formId = googleFormIdFromEnv(env)
  if (!account && !formId) return null
  if (account && !validGoogleAccount(account)) throw intakeError('GOOGLE_CONFIG_INVALID')
  return { account: account || null, formId }
}
