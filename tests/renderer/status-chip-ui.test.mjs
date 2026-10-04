/** The statusbar chip rendered in jsdom, in the state a fresh Git install actually lands in.

    The bug this pins: right after a restart the chip correctly showed the missing-binary popover,
    then the first poll of an EMPTY composer published the idle check state and the chip became
    inert "Harper · Ready" text. `poll` is the function the plugin handed to `ctx.setInterval`, so
    the test drives the exact same poll the renderer runs every TICK_MS.
*/

import assert from 'node:assert/strict'
import test from 'node:test'

import { installDom } from './dom.mjs'

installDom()
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const React = await import('react')
const { act } = React
const { createRoot } = await import('react-dom/client')
const { default: plugin } = await import('../../desktop/plugin.js')
const { composer, host } = await import('@hermes/plugin-sdk')

const NO_BINARY = {
  ok: false,
  state: 'offline',
  version: '2.12.0',
  binary: null,
  checks: 0,
  // The real contract: resolve_binary() puts the human sentence in `reason`, and /warm passes it
  // through as `exc.detail` (harper_ls.py:123). There is no separate `message` field.
  reason: 'no harper-ls binary found (looked for HARPER_LS_PATH, harper_ls_path, vendor/harper-ls.exe, and PATH). Run POST /bootstrap to download the pinned release.'
}
const INSTALLED = { ok: true, state: 'running', version: '2.12.0', binary: 'E:/harper/vendor/harper-ls.exe', binarySource: 'vendor', checks: 0, dialect: 'American' }
const SETTLED = () => new Promise(resolve => setTimeout(resolve, 0))

async function mount(initial = NO_BINARY, { responder = null, draft = '' } = {}) {
  composer.reset(draft)
  let engine = initial
  const contributions = []
  const restCalls = []
  const storage = new Map()
  let poll = null
  host.request = async () => ({ plugins: [] })
  plugin.register({
    storage: { get: (key, fallback) => storage.has(key) ? storage.get(key) : fallback, set: (key, value) => storage.set(key, value) },
    rest: async (path, options = {}) => {
      restCalls.push({ path, body: options.body })

      if (responder) {
        return responder(path, options, { adopt: value => { engine = value } })
      }

      if (path === '/bootstrap') {
        engine = INSTALLED

        return { ...INSTALLED, installed: true }
      }

      return path === '/check' ? { suggestions: [], technicalSuppressed: 0, truncated: false } : engine
    },
    registerMany: rows => contributions.push(...rows),
    onDispose() {},
    setInterval: fn => {
      poll = fn
    },
    setTimeout: (fn, ms) => {
      const timer = setTimeout(fn, ms)

      return () => clearTimeout(timer)
    }
  })
  const container = document.createElement('div')
  const root = createRoot(container)

  await act(async () => {
    root.render(contributions.find(row => row.id === 'status').render())
    await SETTLED()
  })

  const settle = fn => act(async () => {
    await fn()
    await SETTLED()
  })

  return {
    container,
    contributions,
    restCalls,
    poll: () => settle(poll),
    click: node => settle(() => node.click()),
    run: data => settle(() => data.run()),
    dispose: () => act(() => root.unmount())
  }
}

const chip = node => [...node.querySelectorAll('button')].find(button => /^Harper · /.test(button.textContent))
const dialog = node => node.querySelector('[role="dialog"]')
const installButton = node => [...node.querySelectorAll('button')].find(button => button.textContent.includes('Install Harper'))
const retryButton = node => [...node.querySelectorAll('button')].find(button => button.textContent.trim() === 'Retry')
const command = (view, label) => view.contributions.filter(row => row.area === 'palette').find(row => row.data.label === label)

test('an empty composer does not turn a missing engine into a ready chip', async () => {
  const view = await mount()
  try {
    assert.equal(chip(view.container).textContent, 'Harper · Install required')

    // The exact sequence reported: correct popover at first, then the poll of an empty draft.
    await view.poll()
    assert.equal(chip(view.container) !== undefined, true, 'the chip must stay a clickable trigger')
    assert.equal(chip(view.container).textContent, 'Harper · Install required', 'no false Ready while the engine is absent')
  } finally {
    view.dispose()
  }
})

test('the install-required popover explains the engine and installs only on click', async () => {
  const view = await mount()
  try {
    assert.equal(view.restCalls.some(call => call.path === '/bootstrap'), false, 'nothing downloads before the user asks')
    assert.equal(dialog(view.container), null, 'and the popover does not auto-open on a problem')

    await view.click(chip(view.container))
    const body = dialog(view.container)

    assert.ok(body)
    assert.equal(body.textContent.includes('no harper-ls binary found'), true, 'the engine reason, not a generic warning')
    assert.ok(installButton(body), 'a Harper-owned install action, reachable from the chip')

    await view.click(installButton(body))
    assert.equal(view.restCalls.filter(call => call.path === '/bootstrap').length, 1)
    assert.equal(composer.notifications.at(-1).kind, 'success')
    await view.poll()
    assert.equal(chip(view.container), undefined, 'installed and idle: back to inert Ready text')
    assert.equal(view.container.textContent.includes('Harper · Ready'), true)
  } finally {
    view.dispose()
  }
})

test('a healthy engine with an empty composer stays quiet', async () => {
  const view = await mount(INSTALLED)
  try {
    await view.poll()
    assert.equal(chip(view.container), undefined, 'Ready is still inert text when there is nothing to act on')
    assert.equal(view.container.textContent.includes('Harper · Ready'), true)
  } finally {
    view.dispose()
  }
})

test('the palette can install the engine without the settings page', async () => {
  const view = await mount()
  try {
    const command = view.contributions
      .filter(row => row.area === 'palette')
      .find(row => row.data.label === 'Harper: Install Harper')

    assert.ok(command, 'a fresh Git install is recoverable from the palette alone')
    assert.equal(view.restCalls.some(call => call.path === '/bootstrap'), false, 'listing the command must not run it')

    await view.run(command.data)
    assert.equal(view.restCalls.filter(call => call.path === '/bootstrap').length, 1)
  } finally {
    view.dispose()
  }
})

// --- the API vanishing under a chip that believed everything was fine -----------------------
//
// Measured on the real app: after the Hermes profile that owned the plugin's dashboard package was
// uninstalled, a rebuilt backend mounted no Harper router, so every request became
// `405: {"detail":"Method Not Allowed"}` while the statusbar still read `Harper · Ready`. The chip
// must invert that: no Ready without a reachable API, and a clickable popover that says what broke.

const SENTENCE = 'Thiss is a sentenc whit two mistaks'
const ROUTE_GONE = '405: {"detail":"Method Not Allowed"}'

function unavailableSetup() {
  let phase = 'mounted'

  return {
    goDown: () => { phase = 'gone' },
    comeBack: () => { phase = 'mounted' },
    responder: path => {
      if (phase === 'mounted') {
        if (path === '/warm' || path === '/status') return INSTALLED

        return { suggestions: [], technicalSuppressed: 0, truncated: false }
      }

      throw new Error(ROUTE_GONE)
    }
  }
}

test('an unmounted route turns Ready into a clickable Unavailable that an empty composer cannot undo', async () => {
  const api = unavailableSetup()
  const view = await mount(INSTALLED, { responder: api.responder })
  try {
    await view.poll()
    assert.equal(chip(view.container), undefined, 'baseline: a reachable API with an installed engine is inert Ready text')
    assert.equal(view.container.textContent.includes('Harper · Ready'), true)

    api.goDown()
    composer.reset(SENTENCE)
    await view.run(command(view, 'Harper: Check draft now').data)

    const button = chip(view.container)
    assert.ok(button, 'the chip stays a trigger, because there is now something to explain')
    assert.equal(button.textContent, 'Harper · Unavailable')

    // The exact overwrite that hid the old failure: the next poll of an empty composer.
    composer.reset('')
    await view.poll()
    assert.equal(chip(view.container).textContent, 'Harper · Unavailable', 'idle is not evidence that anything works')

    await view.click(chip(view.container))
    const body = dialog(view.container)
    assert.ok(body)
    assert.match(body.textContent, /Harper backend is unavailable for the current Hermes backend/i)
    assert.equal(body.textContent.includes('Method Not Allowed'), false, 'a raw FastAPI body is not an explanation')
    assert.ok(retryButton(body), 'Retry is the action the user has')
    assert.equal(
      body.textContent.includes(SENTENCE),
      false,
      'the diagnostic surface never carries the draft'
    )
  } finally {
    view.dispose()
  }
})

test('the unavailable popover keeps the last-known engine metadata and recovers on Retry', async () => {
  const api = unavailableSetup()
  const view = await mount(INSTALLED, { responder: api.responder })
  try {
    await view.poll()
    api.goDown()
    composer.reset(SENTENCE)
    await view.run(command(view, 'Harper: Check draft now').data)
    await view.click(chip(view.container))

    const body = dialog(view.container)
    assert.match(body.textContent, /v2\.12\.0/, 'engine version stays visible as last-known metadata')
    assert.match(body.textContent, /vendor/, 'and so does the binary source, when the backend reported one')

    api.comeBack()
    await view.click(retryButton(body))
    composer.reset('')
    await view.poll()
    assert.equal(view.container.textContent.includes('Harper · Ready'), true, 'a successful request restores Ready')
    assert.equal(chip(view.container), undefined, 'and the chip goes back to being inert text')
  } finally {
    view.dispose()
  }
})

test('a lost API still reports install required once the backend answers again', async () => {
  let phase = 'mounted'
  const view = await mount(NO_BINARY, {
    responder: path => {
      if (phase === 'gone') throw new Error('404: {"detail":"Not Found"}')

      return path === '/check' ? { suggestions: [], technicalSuppressed: 0, truncated: false } : NO_BINARY
    }
  })
  try {
    assert.equal(chip(view.container).textContent, 'Harper · Install required')

    phase = 'gone'
    composer.reset(SENTENCE)
    await view.run(command(view, 'Harper: Check draft now').data)
    assert.equal(chip(view.container).textContent, 'Harper · Unavailable', 'an unreachable API outranks an install claim')

    phase = 'mounted'
    composer.reset('')
    await view.poll()
    assert.equal(chip(view.container).textContent, 'Harper · Install required', 'and the durable condition returns once it answers')
  } finally {
    view.dispose()
  }
})

test('the install-required popover offers Retry next to Install Harper', async () => {
  const view = await mount()
  try {
    await view.click(chip(view.container))
    const body = dialog(view.container)

    assert.ok(installButton(body), 'the explicit install action')
    assert.ok(retryButton(body), 'and a re-check, for the case where the binary arrived by other means')
  } finally {
    view.dispose()
  }
})
