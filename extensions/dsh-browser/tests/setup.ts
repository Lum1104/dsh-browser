/**
 * jsdom test setup: jsdom has no layout engine, so getBoundingClientRect
 * returns all zeros (which the visibility filter reads as hidden), and it
 * does not implement CSS.escape. Stub both with browser-equivalent behavior.
 */

const FAKE_RECT: DOMRect = {
  x: 0,
  y: 0,
  top: 0,
  left: 0,
  right: 200,
  bottom: 40,
  width: 200,
  height: 40,
  toJSON: () => ({}),
}

Object.defineProperty(Element.prototype, 'getBoundingClientRect', {
  configurable: true,
  value: function getBoundingClientRect(this: Element): DOMRect {
    return FAKE_RECT
  },
})

Object.defineProperty(Element.prototype, 'scrollIntoView', {
  configurable: true,
  writable: true,
  value: function scrollIntoView(): void {
    // jsdom has no layout; production code may call this after resolving a target.
  },
})

Object.defineProperty(globalThis, 'CSS', {
  configurable: true,
  value: {
    escape(value: string): string {
      return value.replace(/[^a-zA-Z0-9_-]/g, (ch) => `\\${ch}`)
    },
  },
})
