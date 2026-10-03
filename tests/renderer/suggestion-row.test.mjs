import assert from 'node:assert/strict'
import test from 'node:test'

import { installDom } from './dom.mjs'

installDom()
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const React = await import('react')
const { act } = React
const { createRoot } = await import('react-dom/client')
const { SuggestionRow } = await import('../../desktop/plugin.js')

const ITEM = {
  start: 0, end: 5, text: 'Thiss', code: 'SpellCheck', message: 'Spelling', category: 'spelling',
  lintKind: 'SpellCheck', priority: 63, suggestions: ['This']
}

function mount(engineOverrides = {}) {
  const applied = []
  const ignored = []
  const engine = {
    applyItems: async (items, options) => { applied.push({ items, options }); return { applied: items.length } },
    ignore: item => ignored.push(item),
    ...engineOverrides
  }
  const container = document.createElement('div')
  const root = createRoot(container)
  act(() => root.render(React.createElement(SuggestionRow, { item: ITEM, engine })))
  return { container, applied, ignored, root }
}

test('the correction content is a full-row button and Ignore is a separate sibling', () => {
  const { container, applied, ignored, root } = mount()
  const row = container.querySelector('.hgc-apply-row')
  const ignore = container.querySelector('[aria-label="Ignore this suggestion"]')
  assert.equal(row.tagName, 'BUTTON')
  assert.equal(row.tabIndex, 0)
  assert.equal(row.contains(ignore), false)
  assert.equal(row.textContent.includes('Thiss'), true)
  assert.equal(row.textContent.includes('This'), true)
  assert.equal(row.textContent.includes('Spelling'), true)
  assert.equal(row.textContent.includes('High'), true)
  assert.equal(row.textContent.includes('Apply correction'), false)
  assert.equal(row.getAttribute('aria-label'), "Apply correction: Change 'Thiss' to 'This'")
  act(() => row.click())
  assert.deepEqual(applied[0].items, [ITEM])
  assert.equal(applied[0].options, undefined, 'row apply uses the supported default focus restoration')
  act(() => ignore.click())
  assert.deepEqual(ignored, [ITEM])
  assert.equal(applied.length, 1, 'Ignore does not bubble into applying the row')
  act(() => root.unmount())
})

test('native row button provides Enter and Space keyboard activation', () => {
  const { container, applied, root } = mount()
  const row = container.querySelector('.hgc-apply-row')
  for (const key of ['Enter', ' ']) {
    act(() => {
      row.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true }))
      row.click() // browser default action for a native button
    })
  }
  assert.equal(applied.length, 2)
  act(() => root.unmount())
})
