// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('panel layout styles', () => {
  it('keeps the settings view within the viewport so overflowing content scrolls', () => {
    const styles = readFileSync(`${process.cwd()}/src/panel/styles.css`, 'utf8')
    const settingsRule = styles.match(/\.settings\s*\{([^}]*)\}/)?.[1]

    expect(settingsRule).toBeDefined()
    expect(settingsRule).toMatch(/(?:^|\n)\s*height:\s*100vh;/)
    expect(settingsRule).toMatch(/(?:^|\n)\s*height:\s*100dvh;/)
    expect(settingsRule).toMatch(/(?:^|\n)\s*overflow-y:\s*auto;/)
    expect(settingsRule).toMatch(/(?:^|\n)\s*overscroll-behavior:\s*contain;/)
  })

  it('keeps settings sections at their natural height so the view can overflow', () => {
    const styles = readFileSync(`${process.cwd()}/src/panel/styles.css`, 'utf8')
    const settingsChildrenRule = styles.match(/\.settings\s*>\s*\*\s*\{([^}]*)\}/)?.[1]

    expect(settingsChildrenRule).toBeDefined()
    expect(settingsChildrenRule).toMatch(/(?:^|\n)\s*flex-shrink:\s*0;/)
  })

  it('places an upward model menu on its own row under the composer', () => {
    const styles = readFileSync(`${process.cwd()}/src/panel/styles.css`, 'utf8')
    const modelRule = styles.match(/\.composer-model\s*\{([^}]*)\}/)?.[1]
    const menuRule = styles.match(/\.composer-model-menu\s*\{([^}]*)\}/)?.[1]

    expect(modelRule).toBeDefined()
    expect(modelRule).toMatch(/(?:^|\n)\s*position:\s*relative;/)
    expect(modelRule).toMatch(/(?:^|\n)\s*margin-top:\s*8px;/)
    expect(menuRule).toBeDefined()
    expect(menuRule).toMatch(/(?:^|\n)\s*position:\s*absolute;/)
    expect(menuRule).toMatch(/(?:^|\n)\s*bottom:\s*calc\(100% \+ 6px\);/)
  })
})
