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
