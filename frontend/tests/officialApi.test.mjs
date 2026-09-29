import assert from 'node:assert/strict'
import test from 'node:test'

import { findingLabel, officialApi } from '../src/officialApi.ts'

test('technical non-completion is never presented as a negative result', () => {
  assert.equal(findingLabel(null, 'not_run'), 'не выполнялось')
  assert.equal(findingLabel(null, 'error'), 'техническая ошибка')
})

test('candidate stays a candidate until inspector confirms it', () => {
  assert.equal(findingLabel('CANDIDATE', 'completed'), 'кандидат для проверки')
  assert.equal(findingLabel('CONFIRMED_VIOLATION', 'completed'), 'подтверждено инспектором')
})

test('inspector clarification is a separate visible decision', () => {
  assert.equal(findingLabel('CLARIFICATION_REQUIRED', 'completed'), 'запрошено уточнение')
})

test('evidence image URL uses the server REST route', () => {
  assert.equal(officialApi.pageImageUrl(17, 4), '/api/v1/documents/17/pages/4/image')
})
