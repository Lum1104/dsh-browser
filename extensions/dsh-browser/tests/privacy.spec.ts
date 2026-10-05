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
    for (const id of ['password', 'cardNumber', 'cvv2', 'credit_card', 'token_secret']) {
      const input = document.createElement('input')
      input.id = id
      expect(isSensitiveField(input)).toBe(true)
    }
  })

  it('flags the raw attribute when the IDL getter blanks the value (Chrome)', () => {
    // Chrome's `input.autocomplete` IDL getter is limited to known values:
    // it returns '' for token lists it cannot parse (e.g. 'cc-number foo',
    // 'bogus cc-number'). The mask must read the content attribute, or those
    // markup variants leak. Emulate the Chrome getter on the instance while
    // the content attribute keeps the real value.
    for (const value of ['cc-number foo', 'bogus cc-number', 'section-x billing cc-csc extra']) {
      const input = document.createElement('input')
      input.id = 'field1'
      input.setAttribute('autocomplete', value)
      Object.defineProperty(input, 'autocomplete', { get: () => '' })
      expect(isSensitiveField(input), value).toBe(true)
    }
  })

  it('flags multi-token cc autocomplete values (HTML token lists)', () => {
    // Real checkout markup: `autocomplete="section-checkout billing cc-number"`.
    // Neutral id so ONLY the autocomplete token can flag the field. Set the
    // CONTENT attribute, as production markup does.
    for (const value of ['section-checkout billing cc-number', 'shipping cc-csc', 'billing cc-exp']) {
      const input = document.createElement('input')
      input.id = 'field1'
      input.setAttribute('autocomplete', value)
      expect(isSensitiveField(input), value).toBe(true)
    }
  })

  it('matches cc autocomplete tokens case-insensitively', () => {
    const input = document.createElement('input')
    input.id = 'field1'
    input.setAttribute('autocomplete', 'CC-Number')
    expect(isSensitiveField(input)).toBe(true)
  })

  it('leaves multi-token autocomplete without a cc token alone', () => {
    const input = document.createElement('input')
    input.id = 'field1'
    input.setAttribute('autocomplete', 'section-contact billing email')
    expect(isSensitiveField(input)).toBe(false)
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
