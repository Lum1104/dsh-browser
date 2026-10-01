// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import {
  accessibleName,
  collectHiddenForms,
  collectInteractive,
  formControlLabel,
  isVisible,
  mainText,
  truncate,
} from '../src/content/extract.ts'

describe('truncate', () => {
  it('cuts over-budget text and reports the cut count', () => {
    expect(truncate('abc', 5)).toEqual({ text: 'abc', truncated: 0 })
    const result = truncate('abcdefgh', 4)
    expect(result.text).toBe('abcd…')
    expect(result.truncated).toBe(4)
  })
})

describe('isVisible', () => {
  it('treats display:none and visibility:hidden as hidden', () => {
    const hidden = document.createElement('button')
    hidden.style.display = 'none'
    document.body.appendChild(hidden)
    expect(isVisible(hidden)).toBe(false)

    const invisible = document.createElement('button')
    invisible.style.visibility = 'hidden'
    document.body.appendChild(invisible)
    expect(isVisible(invisible)).toBe(false)

    const visible = document.createElement('button')
    visible.textContent = 'ok'
    document.body.appendChild(visible)
    expect(isVisible(visible)).toBe(true)
  })
})

describe('accessibleName', () => {
  it('prefers aria-label over everything else', () => {
    const button = document.createElement('button')
    button.setAttribute('aria-label', '关闭')
    button.textContent = 'X'
    expect(accessibleName(button)).toBe('关闭')
  })

  it('resolves label[for] for inputs', () => {
    const input = document.createElement('input')
    input.id = 'email'
    const label = document.createElement('label')
    label.htmlFor = 'email'
    label.textContent = '邮箱地址'
    document.body.append(label, input)
    expect(accessibleName(input)).toBe('邮箱地址')
  })

  it('resolves a wrapping label for form controls', () => {
    document.body.innerHTML = '<label><input type="checkbox">邮件通知</label>'
    expect(accessibleName(document.querySelector('input')!)).toBe('邮件通知')
  })

  it('falls back to own text then tag name', () => {
    const button = document.createElement('button')
    button.textContent = '  提交  '
    expect(accessibleName(button)).toBe('提交')
    const span = document.createElement('span')
    expect(accessibleName(span)).toBe('span')
  })

  it('resolves multiple aria-labelledby IDs in order and ignores duplicates', () => {
    document.body.innerHTML = `
      <span id="a">名</span><span id="b">称</span>
      <button aria-labelledby="a b a">x</button>
    `
    expect(accessibleName(document.querySelector('button')!)).toBe('名 称')
  })

  it('resolves shadow-scoped aria-labelledby without borrowing an outer ID', () => {
    const outer = document.createElement('span')
    outer.id = 'title'
    outer.textContent = '外层'
    document.body.appendChild(outer)

    const host = document.createElement('div')
    document.body.appendChild(host)
    const shadow = host.attachShadow({ mode: 'open' })
    shadow.innerHTML = `
      <span id="title">标题</span>
      <button aria-labelledby="title">x</button>
    `
    expect(accessibleName(shadow.querySelector('button')!)).toBe('标题')
  })

  it('resolves shadow-scoped label[for]', () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const shadow = host.attachShadow({ mode: 'open' })
    shadow.innerHTML = `
      <label for="email">邮箱</label>
      <input id="email" type="text" />
    `
    expect(accessibleName(shadow.querySelector('input')!)).toBe('邮箱')
  })
})

describe('formControlLabel', () => {
  it('resolves shadow-scoped aria-labelledby for a hidden textarea', () => {
    const outer = document.createElement('span')
    outer.id = 'title'
    outer.textContent = '外层'
    document.body.appendChild(outer)

    const host = document.createElement('div')
    document.body.appendChild(host)
    const shadow = host.attachShadow({ mode: 'open' })
    shadow.innerHTML = `
      <span id="title">标题</span>
      <textarea id="note" aria-labelledby="title" style="width:0;height:0;opacity:0"></textarea>
    `
    expect(formControlLabel(shadow.querySelector('textarea')!)).toBe('标题')
  })

  it('resolves shadow-scoped label[for]', () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const shadow = host.attachShadow({ mode: 'open' })
    shadow.innerHTML = `
      <label for="role">项目角色</label>
      <select id="role" style="display:none"><option>A</option></select>
    `
    expect(formControlLabel(shadow.querySelector('select')!)).toBe('项目角色')
  })
})

describe('collectInteractive', () => {
  it('collects interactive elements in document order, skipping hidden ones', () => {
    document.body.innerHTML = `
      <a href="/a">A</a>
      <button style="display:none">Hidden</button>
      <input type="text" />
      <button>B</button>
    `
    const elements = collectInteractive(document)
    expect(elements.map((entry) => entry.element.tagName.toLowerCase())).toEqual(['a', 'input', 'button'])
    expect(elements.every((entry) => entry.source === 'selector')).toBe(true)
  })

  it('collects pointer-cursor div buttons via heuristic discovery', () => {
    document.body.innerHTML = `
      <div id="add" style="cursor:pointer" aria-label="添加">添加</div>
      <div id="wrap" style="cursor:pointer"><span style="cursor:pointer">嵌套</span></div>
    `
    for (const el of document.querySelectorAll('#add, #wrap, #wrap span')) {
      Object.defineProperty(el, 'getBoundingClientRect', {
        value: () => ({
          width: 40,
          height: 20,
          top: 0,
          left: 0,
          bottom: 20,
          right: 40,
          x: 0,
          y: 0,
          toJSON() { return {} },
        }),
      })
    }
    const collected = collectInteractive(document, {
      hasPointerCursor: (el) => el instanceof HTMLElement && el.style.cursor === 'pointer',
    })
    const heuristic = collected.filter((entry) => entry.source === 'heuristic')
    expect(heuristic.map((entry) => (entry.element as HTMLElement).id || accessibleName(entry.element)))
      .toEqual(expect.arrayContaining(['add', 'wrap']))
    expect(heuristic.some((entry) => (entry.element as HTMLElement).id === 'wrap')).toBe(true)
  })

  it('keeps nested pointer elements with depth so inner triggers stay addressable', () => {
    document.body.innerHTML = `
      <div id="outer" style="cursor:pointer" aria-label="起止时间YYYY-MM">
        <span id="inner" style="cursor:pointer" aria-label="请选择月份">请选择月份</span>
      </div>
    `
    for (const el of document.querySelectorAll('#outer, #inner')) {
      Object.defineProperty(el, 'getBoundingClientRect', {
        value: () => ({
          width: 40,
          height: 20,
          top: 0,
          left: 0,
          bottom: 20,
          right: 40,
          x: 0,
          y: 0,
          toJSON() { return {} },
        }),
      })
    }
    const collected = collectInteractive(document, {
      hasPointerCursor: (el) => el instanceof HTMLElement && el.style.cursor === 'pointer',
    })
    const heuristic = collected.filter((entry) => entry.source === 'heuristic')
    expect(heuristic.map((entry) => (entry.element as HTMLElement).id).sort()).toEqual(['inner', 'outer'])
    expect(heuristic.find((entry) => (entry.element as HTMLElement).id === 'outer')?.depth).toBe(1)
    expect(heuristic.find((entry) => (entry.element as HTMLElement).id === 'inner')?.depth).toBe(2)
  })

  it('skips pointer labels that sit beside a real input', () => {
    document.body.innerHTML = `
      <div>
        <div id="label" style="cursor:pointer">项目名称</div>
        <input id="field" aria-label="项目名称" />
      </div>
      <div id="add" style="cursor:pointer" aria-label="添加">添加</div>
    `
    for (const el of document.querySelectorAll('#label, #field, #add')) {
      Object.defineProperty(el, 'getBoundingClientRect', {
        value: () => ({
          width: 40,
          height: 20,
          top: 0,
          left: 0,
          bottom: 20,
          right: 40,
          x: 0,
          y: 0,
          toJSON() { return {} },
        }),
      })
    }
    const collected = collectInteractive(document, {
      hasPointerCursor: (el) => el instanceof HTMLElement && el.style.cursor === 'pointer',
    })
    const heuristicIds = collected
      .filter((entry) => entry.source === 'heuristic')
      .map((entry) => (entry.element as HTMLElement).id)
    expect(heuristicIds).toEqual(['add'])
    expect(heuristicIds).not.toContain('label')
  })

  it('walks open shadow roots and skips closed ones', () => {
    document.body.innerHTML = ''
    const host = document.createElement('div')
    document.body.appendChild(host)
    const open = host.attachShadow({ mode: 'open' })
    open.innerHTML = '<button id="inside">Shadow</button>'
    const closedHost = document.createElement('div')
    document.body.appendChild(closedHost)
    closedHost.attachShadow({ mode: 'closed' }).innerHTML = '<button>Hidden</button>'
    const inside = open.getElementById('inside')!
    Object.defineProperty(inside, 'getBoundingClientRect', {
      value: () => ({
        width: 40,
        height: 20,
        top: 0,
        left: 0,
        bottom: 20,
        right: 40,
        x: 0,
        y: 0,
        toJSON() { return {} },
      }),
    })

    const collected = collectInteractive(document)
    expect(collected.some((entry) => entry.element.id === 'inside')).toBe(true)
    expect(collected.some((entry) => entry.element.textContent === 'Hidden')).toBe(false)
  })
})

describe('collectHiddenForms', () => {
  it('lists visually hidden inputs separately from visible ones', () => {
    document.body.innerHTML = `
      <input id="visible" value="shown" />
      <input id="faded" style="opacity:0" value="2019-07" />
      <input id="gone" style="visibility:hidden" value="hidden-val" />
      <input type="hidden" value="never" />
    `
    for (const id of ['visible', 'faded', 'gone']) {
      const el = document.getElementById(id)!
      Object.defineProperty(el, 'getBoundingClientRect', {
        value: () => ({
          width: 80,
          height: 20,
          top: 0,
          left: 0,
          bottom: 20,
          right: 80,
          x: 0,
          y: 0,
          toJSON() { return {} },
        }),
      })
    }

    const hidden = collectHiddenForms(document)
    const ids = hidden.map((el) => (el as HTMLElement).id)
    expect(ids).toEqual(expect.arrayContaining(['faded', 'gone']))
    expect(ids).not.toContain('visible')
  })
})

describe('mainText', () => {
  it('prefers article content over the rest of the page', () => {
    document.body.innerHTML = `
      <nav>导航垃圾文字重复重复重复</nav>
      <article><h1>标题</h1><p>第一段正文内容。</p><p>第二段正文内容。</p></article>
    `
    const text = mainText(document)
    expect(text).toContain('第一段正文内容')
    expect(text).not.toContain('导航垃圾')
  })

  it('falls back to body text without an article', () => {
    document.body.innerHTML = '<div>只有一段话的页面。</div>'
    expect(mainText(document)).toContain('只有一段话的页面')
  })

  it('keeps all article cards inside the main landmark', () => {
    document.body.innerHTML = `
      <nav>导航垃圾文字</nav>
      <main>
        <article>Delta 收纳盒</article>
        <article>Cedar 收纳盒</article>
      </main>
    `
    const text = mainText(document)
    expect(text).toContain('Delta 收纳盒')
    expect(text).toContain('Cedar 收纳盒')
    expect(text).not.toContain('导航垃圾')
  })
})
