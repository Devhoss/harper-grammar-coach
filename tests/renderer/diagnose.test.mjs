/** `Harper: Diagnose` — the safe technical report, for troubleshooting a plugin whose backend
    route is there one session and gone the next.

    Two promises, and the second one is the reason this file exists separately: the report must
    carry the state a user can act on (API reachability, HTTP condition, engine state, version,
    binary source, presence, check count, latency, last error) and it must carry NOTHING else.
    The draft is the unpublished writing the whole plugin is built around keeping local, so a
    diagnostic surface — a toast and a console line — is exactly where a leak would be careless.
    Every assertion here runs against a mounted plugin with real draft text in the composer.
*/

import assert from 'node:assert/strict'
import test from 'node:test'

import { installDom } from './dom.mjs'

installDom()
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const React = await import('react')
const { act } = React
const { createRoot } = await import('react-dom/client')
const pluginModule = await import('../../desktop/plugin.js')
const { default: plugin } = pluginModule
const { composer, host } = await import('@hermes/plugin-sdk')

const SENTENCE = 'Thiss is a sentenc whit two mistaks, my password is hunter2hunter2'
const RUNNING = { ok: true, state: 'running', version: '2.12.0', binary: 'E:/harper/vendor/harper-ls.exe', binarySource: 'vendor', checks: 12, lastCheckMs: 6.4 }
const NO_BINARY = { ok: true, state: 'idle', version: '2.12.0', binary: null, binarySource: null, reason: 'no harper-ls binary found', checks: 0, lastCheckMs: 0 }
const SETTLED = () => new Promise(resolve => setTimeout(resolve, 0))

async function mount(initial = RUNNING) {
  composer.reset(SENTENCE)
  const contributions = []
  const restCalls = []
  const logged = []
  const storage = new Map()
  const debug = console.debug
  const state = { alive: true }
  let poll = null
  host.request = async () => ({ plugins: [] })
  console.debug = (...args) => { logged.push(args) }

  plugin.register({
    storage: { get: (key, fallback) => storage.has(key) ? storage.get(key) : fallback, set: (key, value) => storage.set(key, value) },
    rest: async (path, options = {}) => {
      restCalls.push({ path, body: options.body })

      if (!state.alive) {
        throw new Error('405: {"detail":"Method Not Allowed"}')
      }

      if (path === '/check') {
        return { suggestions: [], technicalSuppressed: 0, truncated: false }
      }

      return initial
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

  return {
    container,
    contributions,
    restCalls,
    logged,
    state,
    command: label => contributions.filter(row => row.area === 'palette').find(row => row.data.label === label),
    run: data => act(async () => {
      await data.run()
      await SETTLED()
    }),
    dispose: () => {
      act(() => root.unmount())
      console.debug = debug
    }
  }
}

const notification = () => composer.notifications.at(-1)

test('Harper: Diagnose is a palette command', async () => {
  const view = await mount()
  try {
    assert.ok(view.command('Harper: Diagnose'), 'a route to the state that does not depend on the chip rendering')
    assert.equal(view.restCalls.some(call => call.path === '/status'), false, 'listing the command must not run it')
  } finally {
    view.dispose()
  }
})

test('a healthy plugin reports reachability, engine state, version, source, counts and latency', async () => {
  const view = await mount(RUNNING)
  try {
    await view.run(view.command('Harper: Diagnose').data)
    const message = notification().message

    assert.match(message, /API reachable/i)
    assert.match(message, /running/, 'the engine state itself')
    assert.match(message, /v2\.12\.0/, 'harper-ls version')
    assert.match(message, /vendor/, 'where the binary came from')
    assert.match(message, /12 checks/, 'check count from the backend, not the renderer')
    assert.match(message, /6\.4 ms/, 'last check latency')
    assert.equal(notification().kind, 'success')
  } finally {
    view.dispose()
  }
})

test('a missing binary is reported as missing, not as an error', async () => {
  const view = await mount(NO_BINARY)
  try {
    await view.run(view.command('Harper: Diagnose').data)
    const message = notification().message

    assert.match(message, /API reachable/i)
    assert.match(message, /binary missing/i, 'the presence answer, in the report the user pastes into a bug report')
    assert.match(message, /no harper-ls binary found/, 'and the engine reason that names the condition')
  } finally {
    view.dispose()
  }
})

test('an unmounted route is reported with its HTTP condition', async () => {
  const view = await mount(RUNNING)
  try {
    view.state.alive = false
    await view.run(view.command('Harper: Diagnose').data)
    const message = notification().message

    assert.match(message, /API unreachable/i)
    assert.match(message, /405/, 'the status code is the evidence that the route, not the engine, is gone')
    assert.equal(notification().kind, 'error')
    assert.equal(message.includes('Method Not Allowed'), false, 'the raw FastAPI body is not part of the report')
  } finally {
    view.dispose()
  }
})

test('the report and the log never carry the draft', async () => {
  const view = await mount()
  try {
    await view.run(view.command('Harper: Diagnose').data)

    const surfaces = [notification().message, ...view.logged.flat().map(entry => String(entry?.message ?? entry))]

    for (const surface of surfaces) {
      assert.equal(surface.includes('Thiss'), false, 'no draft words')
      assert.equal(surface.includes('mistaks'), false, 'no draft words')
      assert.equal(surface.includes('hunter2hunter2'), false, 'no draft content of any kind')
    }
    assert.equal(composer.writes.length, 0, 'diagnosing never touches the composer')
  } finally {
    view.dispose()
  }
})

test('formatDiagnose renders the snapshot fields it promises', () => {
  const { formatDiagnose } = pluginModule

  assert.equal(typeof formatDiagnose, 'function', 'the report is a pure function of the snapshot, so it can be tested without a renderer')

  const line = formatDiagnose({
    backend: 'reachable',
    backendStatus: 200,
    engineState: 'running',
    version: '2.12.0',
    binarySource: 'vendor',
    binaryPresent: true,
    needsInstall: false,
    checks: 3,
    lastCheckMs: 8.1,
    lastError: 'harper-ls exited'
  })

  assert.match(line, /API reachable/)
  assert.match(line, /running/)
  assert.match(line, /v2\.12\.0/)
  assert.match(line, /vendor/)
  assert.match(line, /binary present/i)
  assert.match(line, /3 checks/)
  assert.match(line, /8\.1 ms/)
  assert.match(line, /last error: harper-ls exited/)
})
