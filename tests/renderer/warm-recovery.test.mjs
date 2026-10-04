import assert from 'node:assert/strict'
import test from 'node:test'

import { createEngine } from '../../desktop/plugin.js'
import { composer } from './sdk-stub.mjs'

const draft = 'Thiss is a sentenc whit two mistaks'
const suggestion = { start: 0, end: 5, text: 'Thiss', code: 'SpellCheck', suggestions: ['This'] }

function notMounted() {
  return new Error('404: {"detail":"Not Found"}')
}

function harness(rest) {
  const timers = []
  const ctx = {
    rest,
    setTimeout(callback, delay) {
      const timer = { callback, delay, cancelled: false }
      timers.push(timer)
      return () => { timer.cancelled = true }
    }
  }
  const engine = createEngine(ctx)
  const runNext = async () => {
    const timer = timers.find(item => !item.cancelled)
    assert.ok(timer, 'expected a scheduled retry')
    timer.cancelled = true
    await timer.callback()
    await Promise.resolve()
    await Promise.resolve()
    return timer
  }
  return { engine, timers, runNext }
}

test('404 during initial warm retries, checks the existing draft, and returns suggestions', async () => {
  composer.reset(draft)
  let warmCalls = 0
  const h = harness(async path => {
    if (path === '/config') return {}
    if (path === '/warm' && ++warmCalls === 1) throw notMounted()
    if (path === '/warm') return { ok: true, state: 'running' }
    if (path === '/check') return { suggestions: [suggestion] }
    throw new Error(`unexpected ${path}`)
  })

  assert.equal(await h.engine.warm(), false)
  assert.equal(h.engine.backendDown, false)
  assert.equal(h.engine.warming, true)
  assert.equal(h.engine.checkState.state, 'starting')
  assert.equal(h.timers[0].delay, 500)

  await h.runNext()
  assert.equal(h.engine.backendDown, false)
  assert.equal(h.engine.warming, false)
  await h.engine.tick()
  await h.engine.fire(draft)
  assert.equal(h.engine.checkState.state, 'suggestions')
  assert.deepEqual(h.engine.checkState.suggestions, [suggestion])
  assert.equal(warmCalls, 2)
  assert.equal(h.timers.filter(timer => !timer.cancelled).length, 0)
  h.engine.dispose()
})

test('bounded repeated startup failures end in a useful offline state', async () => {
  composer.reset('')
  const h = harness(async path => {
    if (path === '/config') return {}
    throw notMounted()
  })

  await h.engine.warm()
  const delays = []
  while (h.timers.some(timer => !timer.cancelled)) {
    delays.push((await h.runNext()).delay)
  }
  assert.deepEqual(delays, [500, 1_000, 2_000, 4_000, 8_000, 15_000])
  assert.equal(h.engine.backendDown, true)
  assert.equal(h.engine.checkState.state, 'offline')
  assert.match(h.engine.checkState.reason, /after startup retries/i)
  h.engine.dispose()
})

test('timeout warm failure recovers on the next attempt', async () => {
  composer.reset('')
  let warms = 0
  const h = harness(async path => {
    if (path === '/config') return {}
    if (path === '/warm' && warms++ === 0) throw new Error('Timed out connecting to Hermes backend')
    return { ok: true, state: 'running' }
  })
  await h.engine.warm()
  await h.runNext()
  assert.equal(warms, 2)
  assert.equal(h.engine.backendDown, false)
  assert.equal(h.engine.warming, false)
  assert.equal(h.timers.filter(timer => !timer.cancelled).length, 0)
  h.engine.dispose()
})

test('unload cancels a pending retry', async () => {
  composer.reset('')
  const h = harness(async path => {
    if (path === '/config') return {}
    throw notMounted()
  })
  await h.engine.warm()
  h.engine.dispose()
  assert.equal(h.timers[0].cancelled, true)
  assert.equal(await h.engine.warm(), false)
})

test('manual retry cancels the pending backoff and starts immediately', async () => {
  composer.reset('')
  let warms = 0
  const h = harness(async path => {
    if (path === '/config') return {}
    if (path === '/warm' && warms++ === 0) throw notMounted()
    return { ok: true, state: 'running' }
  })
  await h.engine.warm()
  const pending = h.timers[0]
  await h.engine.recheck()
  assert.equal(pending.cancelled, true)
  assert.equal(warms, 2)
  assert.equal(h.engine.warming, false)
  assert.equal(h.engine.backendDown, false)
  h.engine.dispose()
})

test('concurrent warm calls share one request and success stops retrying', async () => {
  composer.reset('')
  let warms = 0
  let release
  const h = harness(async path => {
    if (path === '/config') return {}
    warms += 1
    return new Promise(resolve => { release = () => resolve({ ok: true, state: 'running' }) })
  })
  const first = h.engine.warm()
  const second = h.engine.warm()
  await Promise.resolve()
  assert.equal(warms, 1)
  release()
  assert.equal(await first, true)
  assert.equal(await second, true)
  assert.equal(h.timers.filter(timer => !timer.cancelled).length, 0)
  h.engine.dispose()
})

// --- the API disappearing under us ----------------------------------------------------------
//
// Measured against a real Hermes Desktop: uninstalling the profile that owned the plugin's
// dashboard package leaves `_dashboard_plugin_search_dirs()` with no discoverable copy, so a NEW
// backend mounts no router. The renderer then sees `POST /warm` time out and afterwards get
// `405: {"detail":"Method Not Allowed"}` — FastAPI's SPA catch-all answers GET only, so an
// unmounted POST is a 405, not a 404. Harper cannot fix that lifecycle (upstream), but it must
// not display `Harper · Ready` on top of it, and it must heal by itself when the route comes back.

function unmounted() {
  return new Error('405: {"detail":"Method Not Allowed"}')
}

const REAPED = { ok: true, state: 'idle', version: '2.12.0', binary: 'E:/harper/vendor/harper-ls.exe', binarySource: 'vendor', checks: 12, lastCheckMs: 6.4 }
const NO_BINARY = { ok: true, state: 'idle', version: '2.12.0', binary: null, binarySource: null, reason: 'no harper-ls binary found', checks: 0, lastCheckMs: 0 }

test('a 405 unmounted route is retried like a 404 and ends in an unreachable API state', async () => {
  composer.reset('')
  const h = harness(async path => {
    if (path === '/config') return {}
    throw unmounted()
  })

  await h.engine.warm()
  const delays = []
  while (h.timers.some(timer => !timer.cancelled)) {
    delays.push((await h.runNext()).delay)
  }
  assert.deepEqual(delays, [500, 1_000, 2_000, 4_000, 8_000, 15_000], '405 is a retryable reachability failure, not a terminal one')
  assert.equal(h.engine.backendDown, true)
  assert.equal(h.engine.backendState, 'unreachable')
  assert.equal(h.engine.checkState.state, 'offline')
  assert.equal(h.engine.checkState.reason.includes('Method Not Allowed'), false, 'the raw FastAPI body is not a user-facing sentence')
  assert.match(h.engine.checkState.reason, /unavailable for the current Hermes backend/i)
  h.engine.dispose()
})

test('a failed check marks the API unreachable even after the engine reported running', async () => {
  composer.reset(draft)
  const h = harness(async path => {
    if (path === '/warm') return REAPED
    if (path === '/check') throw unmounted()
    return {}
  })

  assert.equal(await h.engine.warm(), true)
  assert.equal(h.engine.backendState, 'reachable')
  await h.engine.fire(draft)
  assert.equal(h.engine.backendState, 'unreachable', 'the stale `running` answer must not survive a dead route')
  assert.equal(h.engine.diagnose().engineState, 'idle', 'engine metadata is kept as last-known, not invented')
  h.engine.dispose()
})

test('a successful status probe restores reachability and lets checks run again', async () => {
  composer.reset('')
  let reachable = false
  const h = harness(async path => {
    if (path === '/config') return {}
    if (path === '/status' && reachable) return REAPED
    if (path === '/warm') throw unmounted()
    throw unmounted()
  })

  await h.engine.warm()
  while (h.timers.some(timer => !timer.cancelled)) await h.runNext()
  assert.equal(h.engine.backendState, 'unreachable')
  assert.equal(h.engine.backendDown, true)

  reachable = true
  assert.equal(await h.engine.probeBackend(), true)
  assert.equal(h.engine.backendState, 'reachable')
  assert.equal(h.engine.backendDown, false, 'a reaped-but-installed engine can be checked again immediately')
  h.engine.dispose()
})

test('a probe that reaches the API but finds no binary keeps the check gate latched', async () => {
  // The durable-condition rule still applies: reaching the backend is not the same as being able
  // to check. Without this, a successful probe would resume a doomed /check every debounce.
  composer.reset('')
  const h = harness(async path => {
    if (path === '/config') return {}
    if (path === '/status') return NO_BINARY
    throw unmounted()
  })

  await h.engine.warm()
  while (h.timers.some(timer => !timer.cancelled)) await h.runNext()
  assert.equal(await h.engine.probeBackend(), true)
  assert.equal(h.engine.backendState, 'reachable')
  assert.equal(h.engine.backendDown, true)
  assert.equal(h.engine.diagnose().needsInstall, true)
  h.engine.dispose()
})

test('an empty composer still probes a dead API, then waits for the probe cadence', async () => {
  const realNow = Date.now
  let now = 1_000_000
  Date.now = () => now
  try {
    composer.reset('')
    const paths = []
    const h = harness(async path => {
      paths.push(path)
      throw unmounted()
    })
    await h.engine.warm()
    while (h.timers.some(timer => !timer.cancelled)) await h.runNext()
    assert.equal(h.engine.backendState, 'unreachable')

    await h.engine.tick()
    assert.equal(paths.filter(path => path === '/status').length, 1, 'the recovery probe is a read-only /status')

    await h.engine.tick()
    assert.equal(paths.filter(path => path === '/status').length, 1, 'no probe spam within the cadence')

    now += 31_000
    await h.engine.tick()
    assert.equal(paths.filter(path => path === '/status').length, 2, 'the cadence resumes so a restarted backend heals itself')
    h.engine.dispose()
  } finally {
    Date.now = realNow
  }
})

test('diagnose reports safe technical state with the HTTP condition', async () => {
  composer.reset('')
  const h = harness(async path => {
    if (path === '/config') return {}
    throw unmounted()
  })
  await h.engine.warm()
  while (h.timers.some(timer => !timer.cancelled)) await h.runNext()

  const report = h.engine.diagnose()
  assert.equal(report.backend, 'unreachable')
  assert.equal(report.backendStatus, 405)
  assert.equal(report.engineState, 'unknown')
  assert.equal(report.binaryPresent, false)
  assert.equal(typeof report.lastError, 'string')
  assert.notEqual(report.lastError, '')
  assert.equal(typeof report.checks, 'number')
  assert.equal(typeof report.lastCheckMs, 'number')
  h.engine.dispose()
})
