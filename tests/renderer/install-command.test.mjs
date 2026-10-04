/** `Harper: Install Harper` — the command must only offer what it can actually do.
    Measured in real Electron: with the Harper router gone the status popover correctly hid the
    Install button (`/bootstrap` is a Harper endpoint), but the palette row still read
    `engine not installed`, which promises a download the dead API cannot serve.

    Two surfaces, one rule: reachability decides. The row must say what is missing (the backend,
    not the engine) and clicking it must explain rather than POST at a route that is not there —
    without latching, so an API that came back still installs on the next click. The draft stays
    out of the explanation, same as every other diagnostic surface.
*/

import assert from 'node:assert/strict'
import test from 'node:test'

import { installDom } from './dom.mjs'

installDom()
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const React = await import('react')
const { act } = React
const pluginModule = await import('../../desktop/plugin.js')
const { default: plugin } = pluginModule
const { composer, host } = await import('@hermes/plugin-sdk')

const DRAFT = 'Thiss is a sentenc whit two mistaks, my password is hunter2hunter2'
const RUNNING = { ok: true, state: 'running', version: '2.12.0', binary: 'E:/harper/vendor/harper-ls.exe', binarySource: 'vendor', checks: 12, lastCheckMs: 6.4 }
const NO_BINARY = { ok: true, state: 'idle', version: '2.12.0', binary: null, binarySource: null, reason: 'no harper-ls binary found', checks: 0, lastCheckMs: 0 }
const INSTALLED = { installed: true, version: '2.12.0', state: 'running', binary: 'E:/harper/vendor/harper-ls.exe', binarySource: 'vendor' }
const SETTLED = () => new Promise(resolve => setTimeout(resolve, 0))

function unmounted() {
  return new Error('405: {"detail":"Method Not Allowed"}')
}

async function mount(state = { alive: true }) {
  composer.reset(DRAFT)
  const contributions = []
  const restCalls = []
  const timers = []
  const disposers = []
  const logged = []
  const debug = console.debug

  console.debug = (...args) => { logged.push(args) }
  host.request = async () => ({ plugins: [] })

  plugin.register({
    storage: { get: (key, fallback) => fallback, set: () => {} },
    rest: async (path, options = {}) => {
      restCalls.push({ path, method: options.method || 'GET' })

      if (!state.alive) {
        throw unmounted()
      }

      if (path === '/check') {
        return { suggestions: [], technicalSuppressed: 0, truncated: false }
      }

      if (path === '/bootstrap') {
        return INSTALLED
      }

      if (path === '/status' && state.noBinary) {
        return NO_BINARY
      }

      return path === '/status' ? RUNNING : (path === '/warm' ? { ok: true, state: 'running' } : {})
    },
    registerMany: rows => contributions.push(...rows),
    // Recorded, never scheduled: a real `ctx.setTimeout` here lets a failed warm retry itself for
    // 30 s of wall clock across every later test, and those background attempts mutate the same
    // module-level engine state the next mount is asserting on.
    onDispose: fn => disposers.push(fn),
    setInterval: () => () => {},
    setTimeout: (callback, delay) => {
      const timer = { callback, delay, cancelled: false }

      timers.push(timer)

      return () => { timer.cancelled = true }
    }
  })

  return {
    state,
    restCalls,
    timers,
    command: label => contributions.filter(row => row.area === 'palette').find(row => row.data.label === label),
    run: data => act(async () => {
      await data.run()
      await SETTLED()
    }),
    dispose: () => {
      console.debug = debug
      disposers.forEach(fn => fn())
    }
  }
}

const install = view => view.command('Harper: Install Harper').data
const notification = () => composer.notifications.at(-1)

// --- the row's claim: reachability decides what it is allowed to say --------------------------

test('an untouched session still offers the engine it is genuinely missing', async () => {
  const view = await mount()
  try {
    assert.equal(install(view).detail(), 'engine not installed', 'no contact yet, so the normal action stands')
    assert.equal(view.restCalls.some(call => call.path === '/bootstrap'), false, 'listing the command must not run it')
  } finally {
    view.dispose()
  }
})

test('a reachable API with a binary reports the version', async () => {
  const view = await mount()
  try {
    await view.run(view.command('Harper: Diagnose').data)
    assert.equal(install(view).detail(), 'v2.12.0')
  } finally {
    view.dispose()
  }
})

test('a reachable API without a binary still reports the install action', async () => {
  const view = await mount({ alive: true, noBinary: true })
  try {
    await view.run(view.command('Harper: Diagnose').data)
    assert.equal(install(view).detail(), 'engine not installed', 'the ordinary case the command exists for')
  } finally {
    view.dispose()
  }
})

test('an unreachable API is named as the blocker instead of a missing engine', async () => {
  const view = await mount({ alive: false })
  try {
    await view.run(view.command('Harper: Diagnose').data)

    const detail = install(view).detail()

    assert.equal(detail.includes('engine not installed'), false, 'nothing proves the engine is absent; only the route is gone')
    assert.match(detail, /backend unavailable/i)
  } finally {
    view.dispose()
  }
})

// --- clicking it: explain, do not download ---------------------------------------------------

test('installing against an unreachable API explains instead of posting a doomed download', async () => {
  const view = await mount({ alive: false })
  try {
    await view.run(install(view))

    assert.equal(view.restCalls.some(call => call.path === '/bootstrap'), false, 'no request to a router that is not mounted')
    assert.match(notification().message, /unavailable for the current Hermes backend/)
    assert.match(notification().message, /install/i, 'and it reads as an answer about installing')
    assert.equal(notification().kind, 'error')
    assert.equal(notification().message.includes('Method Not Allowed'), false, 'the raw FastAPI body is not user-facing')
  } finally {
    view.dispose()
  }
})

test('the install explanation never carries the draft', async () => {
  const view = await mount({ alive: false })
  try {
    await view.run(install(view))

    for (const fragment of ['Thiss', 'mistaks', 'hunter2hunter2']) {
      assert.equal(notification().message.includes(fragment), false)
    }
    assert.equal(composer.writes.length, 0, 'installing does not touch the composer')
  } finally {
    view.dispose()
  }
})

test('an API that came back installs on the next click, with no probe latch', async () => {
  const view = await mount({ alive: false })
  try {
    await view.run(install(view))
    assert.equal(view.restCalls.some(call => call.path === '/bootstrap'), false)

    view.state.alive = true
    await view.run(install(view))

    assert.ok(view.restCalls.some(call => call.path === '/bootstrap' && call.method === 'POST'), 'the verdict is refreshed, not remembered')
    assert.match(notification().message, /Harper 2\.12\.0 installed/)
  } finally {
    view.dispose()
  }
})

test('a reachable API keeps the ordinary install path intact', async () => {
  const view = await mount({ alive: true, noBinary: true })
  try {
    await view.run(install(view))

    assert.ok(view.restCalls.some(call => call.path === '/bootstrap' && call.method === 'POST'))
    assert.equal(notification().kind, 'success')
  } finally {
    view.dispose()
  }
})
