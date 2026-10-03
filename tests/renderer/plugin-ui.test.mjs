import assert from 'node:assert/strict'
import test from 'node:test'

import { installDom } from './dom.mjs'

installDom()
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const React = await import('react')
const { act } = React
const { createRoot } = await import('react-dom/client')
const { default: plugin } = await import('../../desktop/plugin.js')
const { composer, host, popoverAutoFocusLog } = await import('@hermes/plugin-sdk')

const suggestions = [
  { start: 0, end: 5, text: 'Thiss', code: 's1', message: 'Spelling', category: 'spelling', priority: 63, suggestions: ['This'] },
  { start: 11, end: 17, text: 'mistke', code: 's2', message: 'Spelling', category: 'spelling', priority: 63, suggestions: ['mistake'] }
]

async function setup({ draft = 'Thiss is a mistke.', result = suggestions, display = 'popover', surfaces = 1, correctOnSend, technicalSuppressed = 0 } = {}) {
  composer.reset(draft)
  const contributions = []
  const restCalls = []
  const savedSettings = { suggestionDisplay: display }
  if (correctOnSend !== undefined) savedSettings.correctOnSend = correctOnSend
  const storage = new Map([['settings', savedSettings]])
  const persisted = correctOnSend ?? false
  host.request = async method => method === 'plugins.manage'
    ? { plugins: [{ key: 'harper-grammar-coach', settings_schema: [{ key: 'correct_on_send', value: persisted }] }] }
    : {}
  plugin.register({
    storage: { get: (key, fallback) => storage.has(key) ? storage.get(key) : fallback, set: (key, value) => storage.set(key, value) },
    rest: async (path, options = {}) => {
      restCalls.push({ path, options })
      if (path === '/check') {
        const payload = typeof result === 'function' ? result(options.body?.text) : result
        return { suggestions: payload, technicalSuppressed, truncated: false }
      }
      if (path === '/warm') return { ok: true, state: 'running', version: '1', checks: 0 }
      if (path === '/status' || path === '/config') return { state: 'running', version: '1', checks: 0 }
      return { ok: true }
    },
    registerMany: rows => contributions.push(...rows),
    onDispose() {},
    setInterval() {}
  })
  const container = document.createElement('div')
  const root = createRoot(container)
  const actions = contributions.find(row => row.id === 'composer-suggestions')
  const underside = contributions.find(row => row.id === 'strip')
  const status = contributions.find(row => row.id === 'status')
  const middleware = contributions.find(row => row.id === 'middleware')
  const check = contributions.find(row => row.id === 'check-now')
  await act(async () => { await check.data.run(); await new Promise(resolve => setTimeout(resolve, 0)) })
  const children = [actions.render()]
  for (let i = 0; i < surfaces; i++) children.push(underside.render())
  children.push(status.render())
  act(() => root.render(React.createElement('div', null, ...children)))
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
  return { container, root, contributions, storage, middleware, restCalls }
}

async function recheck(view) {
  const check = view.contributions.find(row => row.id === 'check-now')
  await act(async () => { await check.data.run(); await new Promise(resolve => setTimeout(resolve, 0)) })
}
function dispose(view) { act(() => view.root.unmount()) }
function rows(node) { return [...node.querySelectorAll('.hgc-apply-row')] }
function trigger(node) { return [...node.querySelectorAll('button')].find(button => /^Harper · /.test(button.textContent)) }

 test('0 → 1 suggestions auto-opens the composer popover; 0 suggestions hides it', async () => {
  const view = await setup()
  assert.equal(trigger(view.container)?.textContent, 'Harper · 2')
  assert.equal(view.container.querySelector('[role="dialog"]') !== null, true)
  assert.equal(popoverAutoFocusLog.at(-1), true, 'auto-open cancels the SDK popover focus transfer')
  assert.equal(composer.focuses, 0, 'auto-open does not call any composer focus API')
  composer.draft = 'typing continues'
  assert.equal(composer.draft, 'typing continues', 'simulated composer typing remains available while open')
  dispose(view)

  const clean = await setup({ result: [] })
  assert.equal(trigger(clean.container), undefined)
  assert.equal(clean.container.querySelector('[role="dialog"]'), null)
  dispose(clean)
})

test('closing suppresses identical rechecks; typing a distinct suggestion opens once', async () => {
  let current = suggestions
  const view = await setup({ result: () => current })
  try {
    const button = trigger(view.container)
    assert.ok(button)
    const dialog = view.container.querySelector('[role="dialog"]')
    act(() => dialog.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    assert.equal(view.container.querySelector('[role="dialog"]'), null)
    assert.equal(button.getAttribute('aria-expanded'), 'false')
    await recheck(view)
    assert.equal(view.container.querySelector('[role="dialog"]'), null, 'identical recheck stays closed')

    composer.draft = 'Thiss is a sentenc whit two mistaks'
    current = [...suggestions, { start: 11, end: 18, text: 'sentenc', code: 'new-rule', category: 'spelling', priority: 63, suggestions: ['sentence'] }]
    await recheck(view)
    assert.equal(view.container.querySelector('[role="dialog"]') !== null, true, 'new typing produced a distinct suggestion set')
  } finally { dispose(view) }
})

test('an empty result resets dismissal so later suggestions auto-open again', async () => {
  let current = suggestions
  const view = await setup({ result: () => current })
  try {
    act(() => view.container.querySelector('[role="dialog"]')?.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    current = []
    await recheck(view)
    assert.equal(view.container.querySelector('[role="dialog"]'), null)
    current = suggestions
    await recheck(view)
    assert.equal(view.container.querySelector('[role="dialog"]') !== null, true)
  } finally { dispose(view) }
})

test('Apply correction clicks the whole row and keeps the popover open with remaining checked rows', async () => {
  const view = await setup()
  try {
    const row = rows(view.container)[0]
    assert.ok(row)
    assert.equal(row.textContent.includes('Apply correction'), false)
    await act(async () => { row.click(); await new Promise(resolve => setTimeout(resolve, 0)) })
    assert.equal(composer.draft, 'This is a mistke.')
    assert.ok(composer.focuses > 0, 'supported composer focus API restores focus after row application')
    assert.equal(view.container.querySelector('[role="dialog"]') !== null, true)
    assert.equal(rows(view.container).length, 1)
    assert.equal(view.container.textContent.includes('mistke'), true)
  } finally { dispose(view) }
})

test('multiple sequential row applications keep the same popover open', async () => {
  const first = suggestions[0]
  const second = { start: 6, end: 12, text: 'mistke', code: 's2', message: 'Spelling', category: 'spelling', priority: 63, suggestions: ['mistake'] }
  const third = { start: 13, end: 21, text: 'sentenc', code: 's3', message: 'Spelling', category: 'spelling', priority: 63, suggestions: ['sentence'] }
  const view = await setup({ draft: 'Thiss mistke sentenc', result: text => {
    if (text === 'This mistake sentenc') return [third]
    if (text === 'This mistke sentenc') return [second, third]
    return [first, second, third]
  } })
  try {
    await act(async () => { rows(view.container)[0].click(); await new Promise(resolve => setTimeout(resolve, 0)) })
    assert.equal(rows(view.container).length, 2)
    assert.ok(view.container.querySelector('[role="dialog"]'))
    await act(async () => { rows(view.container)[0].click(); await new Promise(resolve => setTimeout(resolve, 0)) })
    assert.equal(composer.draft, 'This mistake sentenc')
    assert.equal(rows(view.container).length, 1)
    assert.ok(view.container.querySelector('[role="dialog"]'))
  } finally { dispose(view) }
})

test('an outside click still dismisses after apply; new suggestions can auto-open once again', async () => {
  let current = suggestions
  const view = await setup({ result: () => current })
  try {
    await act(async () => { rows(view.container)[0].click(); await new Promise(resolve => setTimeout(resolve, 0)) })
    assert.ok(view.container.querySelector('[role="dialog"]'), 'apply retains the open popover')
    act(() => document.body.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true })))
    assert.equal(view.container.querySelector('[role="dialog"]'), null, 'outside pointer interaction still dismisses')

    composer.draft = 'A different draft with new errors'
    current = [{ start: 0, end: 1, text: 'A', code: 'new-set', category: 'spelling', priority: 63, suggestions: ['A'] }]
    await recheck(view)
    assert.ok(view.container.querySelector('[role="dialog"]'), 'a later distinct set still auto-opens')
  } finally { dispose(view) }
})

test('row controls use native keyboard buttons; Ignore only ignores; Apply all still applies', async () => {
  const view = await setup()
  try {
    const apply = rows(view.container)[0]
    const ignore = view.container.querySelector('[aria-label="Ignore this suggestion"]')
    assert.equal(apply.tagName, 'BUTTON')
    assert.equal(apply.tabIndex, 0)
    assert.equal(ignore.tagName, 'BUTTON')
    assert.equal(ignore.tabIndex, 0)
    assert.equal(apply.contains(ignore), false, 'Ignore is a sibling, never nested inside the row button')
    assert.equal(apply.getAttribute('aria-label'), "Apply correction: Change 'Thiss' to 'This'")
    const before = composer.draft
    act(() => ignore.click())
    assert.equal(composer.draft, before)
    assert.equal(rows(view.container).length, 1)
    const applyAll = [...view.container.querySelectorAll('button')].find(button => button.textContent === 'Apply all')
    await act(async () => { applyAll.click(); await new Promise(resolve => setTimeout(resolve, 0)) })
    assert.equal(composer.draft, 'Thiss is a mistake.', 'ignored item stays while the other suggestion applies')
  } finally { dispose(view) }
})

test('stale displayed rows cannot change a draft that has moved', async () => {
  const view = await setup()
  try {
    composer.draft = 'A completely changed draft.'
    await act(async () => { rows(view.container)[0].click(); await new Promise(resolve => setTimeout(resolve, 0)) })
    assert.equal(composer.draft, 'A completely changed draft.')
    assert.deepEqual(composer.writes, [])
  } finally { dispose(view) }
})

test('correct-on-send defaults off and passes the exact draft through without a check', async () => {
  const view = await setup({ draft: 'dockge', result: [{ start: 0, end: 6, text: 'dockge', code: 'spell', category: 'spelling', priority: 100, suggestions: ["dock's"] }] })
  try {
    assert.equal(view.storage.get('settings').correctOnSend, undefined)
    const checksBefore = view.restCalls.filter(call => call.path === '/check').length
    const original = { text: 'dockge' }
    const sent = await view.middleware.data.handler(original)
    assert.equal(sent.text, 'dockge')
    assert.equal(view.restCalls.filter(call => call.path === '/check').length, checksBefore, 'disabled middleware does not issue /check')
  } finally { dispose(view) }
})

test('persisted Correct on send switch is read by submit middleware', async () => {
  const spell = [{ start: 0, end: 5, text: 'Thiss', code: 'spell', category: 'spelling', priority: 100, suggestions: ['This'] }]
  const view = await setup({ draft: 'Thiss', result: spell, correctOnSend: true })
  try {
    const sent = await view.middleware.data.handler({ text: 'Thiss' })
    assert.equal(sent.text, 'This')
  } finally { dispose(view) }
})

test('an explicitly enabled send path never reapplies the ignored dockge suggestion', async () => {
  const dockge = [{ start: 0, end: 6, text: 'dockge', code: 'spell-dockge', category: 'spelling', priority: 100, suggestions: ["dock's"] }]
  const view = await setup({ draft: 'dockge', result: dockge, correctOnSend: true })
  try {
    act(() => view.container.querySelector('[aria-label="Ignore this suggestion"]').click())
    const sent = await view.middleware.data.handler({ text: 'dockge' })
    assert.equal(sent.text, 'dockge')
  } finally { dispose(view) }
})

test('explicit saved true is preserved, ignored items stay ignored, and other high-confidence items can apply', async () => {
  const two = [
    { start: 0, end: 6, text: 'dockge', code: 'dockge', category: 'spelling', priority: 100, suggestions: ["dock's"] },
    { start: 7, end: 12, text: 'Thiss', code: 'Thiss', category: 'spelling', priority: 100, suggestions: ['This'] }
  ]
  const view = await setup({ draft: 'dockge Thiss', result: text => text === 'dockge!'
    ? [{ start: 0, end: 6, text: 'dockge', code: 'dockge', category: 'spelling', priority: 100, suggestions: ["dock's"] }]
    : two, correctOnSend: true })
  try {
    assert.equal(view.storage.get('settings').correctOnSend, true)
    act(() => view.container.querySelector('[aria-label="Ignore this suggestion"]').click())
    const partial = await view.middleware.data.handler({ text: 'dockge Thiss' })
    assert.equal(partial.text, 'dockge This')
    const changed = await view.middleware.data.handler({ text: 'dockge!' })
    assert.equal(changed.text, "dock's!")
  } finally { dispose(view) }
})

test('opted-in send path uses the filtered /check response for protected technical spans', async () => {
  const text = 'Keep `dockge` as a command in config.yaml.'
  const view = await setup({ draft: text, result: [], correctOnSend: true, technicalSuppressed: 1 })
  try {
    const sent = await view.middleware.data.handler({ text })
    assert.equal(sent.text, text)
  } finally { dispose(view) }
})

test('underside remains selectable; statusbar is the multiple-composer fallback', async () => {
  const underside = await setup({ display: 'underside' })
  assert.equal(underside.container.textContent.includes('2 suggestions'), true)
  assert.equal(underside.container.querySelector('[aria-label="Harper, 2 suggestions"]'), null)
  dispose(underside)

  const multiple = await setup({ surfaces: 2 })
  assert.equal(multiple.container.querySelector('[aria-label="Harper, 2 suggestions"]') !== null, true)
  assert.equal(multiple.container.textContent.includes('Thiss'), true, 'statusbar fallback owns the list')
  dispose(multiple)
})

test('palette and keybind contributions expose open suggestions and apply all', async () => {
  const view = await setup()
  const palette = view.contributions.filter(row => row.area === 'palette').map(row => row.data)
  const keys = view.contributions.filter(row => row.area === 'keybinds').map(row => row.data)
  assert.ok(palette.some(row => row.label === 'Harper: Open suggestions'))
  assert.ok(palette.some(row => row.label === 'Harper: Apply all suggestions'))
  assert.ok(keys.some(row => row.label === 'Harper: Open suggestions' && row.defaults.includes('mod+alt+h')))
  assert.ok(keys.some(row => row.label === 'Harper: Apply all suggestions' && row.defaults.includes('mod+alt+shift+h')))
  dispose(view)
})
