// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { isSensitiveField, maskValue } from '../src/content/privacy.ts'

describe('isSensitiveField', () => {
  it('flags password inputs', () => {
    const input = document.createElement('input')
    input.type = 'password'
    expect(isSensitiveField(input)).toBe(true)
  })

  it('flags credit-card autocomplete fields', () => {
    const input = document.createElement('input')
    input.autocomplete = 'cc-number'
    expect(isSensitiveField(input)).toBe(true)
    const credit = document.createElement('input')
    ;(credit as { autocomplete: string }).autocomplete = 'credit-card'
    expect(isSensitiveField(credit)).toBe(true)
  })

  it('flags fields named like secrets', () => {
    for (const id of ['password', 'cardNumber', 'cvv2', 'credit_card', 'token_secret', 'otp', 'apiKey', 'bearerToken']) {
      const input = document.createElement('input')
      input.id = id
      expect(isSensitiveField(input)).toBe(true)
    }
  })

  it('leaves ordinary fields alone', () => {
    const input = document.createElement('input')
    input.id = 'email'
    expect(isSensitiveField(input)).toBe(false)
    expect(isSensitiveField(document.createElement('textarea'))).toBe(false)
  })
})

describe('maskValue', () => {
  it('masks non-empty values and keeps empty values empty', () => {
    expect(maskValue('hunter2')).toBe('••••')
    expect(maskValue('')).toBe('')
  })
})
