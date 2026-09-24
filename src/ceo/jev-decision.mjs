import { validateModelRouter } from './model-router.mjs'

const ENDPOINT = 'https://api.typesafe.ai/v1/systemone'
const DEFAULT_CONFIDENCE = 0.75

function bounded(value, max = 4096) {
  return typeof value === 'string' && value.length > 0 && value.length <= max
}

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function probability(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
}

function invalid(code) {
  return Object.assign(new TypeError(code), { code })
}

async function boundedResponseJson(response) {
  if (!response.body || typeof response.body[Symbol.asyncIterator] !== 'function') {
    const data = await response.json()
    if (Buffer.byteLength(JSON.stringify(data)) > 65_536) throw invalid('JEV_RESPONSE_INVALID')
    return data
  }
  const chunks = []
  let size = 0
  for await (const chunk of response.body) {
    size += chunk.byteLength
    if (size > 65_536) throw invalid('JEV_RESPONSE_INVALID')
    chunks.push(Buffer.from(chunk))
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function validateQuestions(questions) {
  if (!record(questions) || Object.keys(questions).length < 1 || Object.keys(questions).length > 8) {
    throw invalid('JEV_QUESTIONS_INVALID')
  }
  for (const [key, question] of Object.entries(questions)) {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(key) || !record(question)
      || !bounded(question.instructions, 512)) throw invalid('JEV_QUESTIONS_INVALID')
    if (question.type === 'choice') {
      const criteria = question.criteria
      if (!record(criteria) || Object.keys(criteria).length < 2 || Object.keys(criteria).length > 8
        || Object.entries(criteria).some(([id, description]) => !/^[a-z][a-z0-9_]{0,63}$/.test(id)
          || (description !== null && !bounded(description, 512)))) throw invalid('JEV_QUESTIONS_INVALID')
    } else if (question.type === 'score') {
      if (!Array.isArray(question.criteria) || question.criteria.length < 2 || question.criteria.length > 8
        || question.criteria.some((item) => !bounded(item, 512))) throw invalid('JEV_QUESTIONS_INVALID')
    } else if (question.type !== 'noul' || question.criteria !== undefined) {
      throw invalid('JEV_QUESTIONS_INVALID')
    }
  }
  return questions
}

function validateAnswer(question, answer) {
  if (!record(answer) || answer.type !== question.type) throw invalid('JEV_RESPONSE_INVALID')
  if (question.type === 'choice') {
    if (!Object.hasOwn(question.criteria, answer.choice) || !probability(answer.confidence)
      || !record(answer.probabilities)
      || !probability(answer.probabilities[answer.choice])
      || Object.keys(answer.probabilities).some((key) => !Object.hasOwn(question.criteria, key)
        || !probability(answer.probabilities[key]))) throw invalid('JEV_RESPONSE_INVALID')
    return { type: 'choice', choice: answer.choice, confidence: answer.confidence,
      probabilities: structuredClone(answer.probabilities) }
  }
  if (question.type === 'score') {
    if (typeof answer.score !== 'number' || !Number.isFinite(answer.score)
      || answer.score < 0 || answer.score > question.criteria.length - 1
      || !probability(answer.confidence) || !record(answer.probabilities)
      || Object.keys(answer.probabilities).some((key) => !/^\d+$/.test(key)
        || Number(key) >= question.criteria.length || !probability(answer.probabilities[key]))) {
      throw invalid('JEV_RESPONSE_INVALID')
    }
    return { type: 'score', score: answer.score, confidence: answer.confidence,
      probabilities: structuredClone(answer.probabilities) }
  }
  if (!probability(answer.noul)) throw invalid('JEV_RESPONSE_INVALID')
  return { type: 'noul', noul: answer.noul }
}

// This provider only makes typed decision calls. It cannot generate text or run tools.
// The caller wraps it in Chimera's gateway and durable model-call ledger.
export function createJevModelRouter({ apiKey, apiKeyForCall = null, fetchImpl = globalThis.fetch,
  timeoutMs = 5000, model = 'jev-latest' } = {}) {
  if ((!bounded(apiKey, 16_384) && typeof apiKeyForCall !== 'function') || typeof fetchImpl !== 'function'
    || !Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30_000
    || !bounded(model, 128)) throw invalid('JEV_CONFIG_INVALID')
  return validateModelRouter(Object.freeze({
    routerId: 'model-fabric:jev-decision',
    descriptor: Object.freeze({ providerId: 'typesafe', model, protocol: 'systemone' }),
    async route(prompt) {
      let request
      try { request = JSON.parse(prompt) } catch { throw invalid('JEV_REQUEST_INVALID') }
      if (!record(request) || !bounded(request.state, 8192)) throw invalid('JEV_REQUEST_INVALID')
      const questions = validateQuestions(request.questions)
      const currentKey = apiKeyForCall ? apiKeyForCall() : apiKey
      if (!bounded(currentKey, 16_384)) throw invalid('JEV_NOT_CONFIGURED')
      let response
      try {
        response = await fetchImpl(ENDPOINT, {
          method: 'POST',
          headers: { Authorization: `Bearer ${currentKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model, state: request.state, questions }),
          signal: AbortSignal.timeout(timeoutMs),
        })
      } catch { throw Object.assign(new Error('JEV_TRANSPORT_FAILED'), { code: 'JEV_TRANSPORT_FAILED' }) }
      if (!response?.ok) throw Object.assign(new Error('JEV_PROVIDER_FAILED'), { code: 'JEV_PROVIDER_FAILED' })
      let data
      try { data = await boundedResponseJson(response) } catch { throw invalid('JEV_RESPONSE_INVALID') }
      if (!record(data?.answers)) throw invalid('JEV_RESPONSE_INVALID')
      return Object.fromEntries(Object.entries(questions).map(([key, question]) =>
        [key, validateAnswer(question, data.answers[key])]))
    },
  }))
}

export function createJevDecisionService({ router, audit, now = () => Date.now(),
  minConfidence = DEFAULT_CONFIDENCE } = {}) {
  validateModelRouter(router)
  if (!audit?.append || !probability(minConfidence) || typeof now !== 'function') throw invalid('JEV_CONFIG_INVALID')
  let unavailableUntil = 0

  async function decide({ state, questions, taskId = 'unknown', use = 'bounded' }) {
    if (!bounded(state, 8192) || !bounded(taskId, 512) || !bounded(use, 64)) throw invalid('JEV_REQUEST_INVALID')
    validateQuestions(questions)
    if (now() < unavailableUntil) throw Object.assign(new Error('JEV_COOLDOWN'), { code: 'JEV_COOLDOWN' })
    let answers
    try {
      answers = await router.route(JSON.stringify({ state, questions }), { taskId, decisionUse: use })
    } catch (error) {
      unavailableUntil = now() + 30_000
      throw error
    }
    const validated = Object.fromEntries(Object.entries(questions).map(([key, question]) =>
      [key, validateAnswer(question, answers?.[key])]))
    const projected = Object.fromEntries(Object.entries(validated).map(([key, answer]) => {
      const certainty = answer.type === 'noul' ? Math.max(answer.noul, 1 - answer.noul) : answer.confidence
      return [key, { ...answer, ...(answer.type === 'noul' ? { certainty } : {}),
        usable: certainty >= minConfidence }]
    }))
    audit.append({ kind: 'jev.decision.completed', taskId, use,
      questionTypes: Object.values(questions).map((question) => question.type),
      usableCount: Object.values(projected).filter((answer) => answer.usable).length,
      at: new Date(now()).toISOString() })
    return { answers: projected }
  }

  async function choose({ state, criteria, taskId, use }) {
    const answer = (await decide({ state, taskId, use, questions: {
      selected: { type: 'choice', instructions: 'Choose the best eligible option for this task. Use the option descriptions and task requirements.', criteria },
    } })).answers.selected
    return answer.usable ? answer : null
  }

  return Object.freeze({ decide, choose, minConfidence })
}
