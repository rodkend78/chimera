import assert from 'node:assert/strict'
import test from 'node:test'
import {
  modelOutputSchema,
  modelResponseInstruction,
  parseAskModelResponse,
} from '../src/ceo/structured-model-output.mjs'

test('Ask structured output is answer-only and rejects tool/task-shaped responses', () => {
  assert.deepEqual(modelOutputSchema('ask'), {
    type: 'object',
    properties: { answer: { type: 'string', minLength: 1, maxLength: 16_384 } },
    required: ['answer'],
    additionalProperties: false,
  })
  assert.match(modelResponseInstruction('ask'), /only.*JSON/i)
  assert.match(modelResponseInstruction('ask'), /answer/i)
  assert.deepEqual(parseAskModelResponse('{"answer":"A bounded answer."}'), { answer: 'A bounded answer.' })
  assert.throws(() => parseAskModelResponse('{"answer":"ok","toolCall":{"name":"bash"}}'), /MODEL_RESPONSE_INVALID_SCHEMA/)
  assert.throws(() => parseAskModelResponse('{"tasks":[]}'), /MODEL_RESPONSE_INVALID_SCHEMA/)
})
