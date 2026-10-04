/** The statusbar chip's label/clickability decision, as pure logic.

    The chip used to read the DRAFT-CHECK state only. `tick()` legitimately resets that to
    `idle` whenever the composer is empty, which is the normal state right after a restart —
    so a plugin with no harper-ls binary at all displayed "Harper · Ready" as inert text and
    hid the only reachable Install action. These tests pin the two inputs the decision needs:
    the check state AND the engine state the backend reports.

    Engine shapes here are the real `/status` and `/warm` payloads (see dashboard/plugin_api.py:
    `state` is running|crashed|idle, `/warm` overrides it to "offline" on `binary-missing`, and
    `binary` is null exactly when resolution failed).
*/

import assert from 'node:assert/strict'
import test from 'node:test'

import { statusChipView } from '../../desktop/plugin.js'

const MISSING = { state: 'offline', version: '2.12.0', binary: null, reason: 'no harper-ls binary found (looked for HARPER_LS_PATH, harper_ls_path, vendor/harper-ls.exe, and PATH)' }
const RUNNING = { state: 'running', version: '2.12.0', binary: 'E:/harper/vendor/harper-ls.exe', reason: null }
const CRASHED = { state: 'crashed', version: '2.12.0', binary: 'E:/harper/vendor/harper-ls.exe', reason: 'harper-ls exited' }
const UNKNOWN = { state: 'unknown', version: '', binary: null, reason: null }

const SUGGESTIONS = [{ text: 'Thiss' }, { text: 'mistke' }]

test('an absent binary is reported as install required, even when the draft check is idle', () => {
  const view = statusChipView({ checkState: 'idle', engineState: MISSING, items: [], showSuggestions: false })

  assert.equal(view.needsInstall, true)
  assert.equal(view.label, 'Install required')
  assert.equal(view.caption, 'Harper · Install required')
  assert.equal(view.clickable, true, 'the chip must stay a popover trigger so Install is reachable')
})

test('the ready label requires a resolvable binary', () => {
  const view = statusChipView({ checkState: 'idle', engineState: RUNNING, items: [], showSuggestions: false })

  assert.equal(view.needsInstall, false)
  assert.equal(view.label, 'Ready')
  assert.equal(view.caption, 'Harper · Ready')
  assert.equal(view.clickable, false, 'a healthy idle plugin stays inert text')
})

test('an engine that has not reported yet is not claimed to need an install', () => {
  const view = statusChipView({ checkState: 'idle', engineState: UNKNOWN, items: [], showSuggestions: false })

  assert.equal(view.needsInstall, false, 'no evidence, no claim')
  assert.equal(view.label, 'Ready')
})

test('a binary that exists but died is unavailable, not installable', () => {
  const view = statusChipView({ checkState: 'idle', engineState: CRASHED, items: [], showSuggestions: false })

  assert.equal(view.needsInstall, false)
  assert.equal(view.label, 'Unavailable')
  assert.equal(view.clickable, true)
})

test('a crash-looped engine stays unavailable even though its binary resolves', () => {
  // /warm reports `state: "offline"` for any start failure, including `crash-loop`, where
  // `binary` is a real path. The chip must still say what the user cannot do with it.
  const view = statusChipView({ checkState: 'idle', engineState: { ...CRASHED, state: 'offline' }, items: [], showSuggestions: false })

  assert.equal(view.needsInstall, false)
  assert.equal(view.label, 'Unavailable')
  assert.equal(view.clickable, true)
})

test('an idle engine that is installed and merely reaped is honestly ready', () => {
  const view = statusChipView({ checkState: 'idle', engineState: { ...RUNNING, state: 'idle' }, items: [], showSuggestions: false })

  assert.equal(view.needsInstall, false)
  assert.equal(view.label, 'Ready')
  assert.equal(view.clickable, false, 'the next check restarts it by itself — nothing to report')
})

test('warming is starting, which outranks the engine state', () => {
  const view = statusChipView({ checkState: 'starting', engineState: UNKNOWN, items: [], showSuggestions: false })

  assert.equal(view.label, 'Starting')
  assert.equal(view.clickable, true)
})

test('a failed check reports unavailable while the engine is still installable', () => {
  const offline = statusChipView({ checkState: 'offline', engineState: MISSING, items: [], showSuggestions: false })
  const errored = statusChipView({ checkState: 'error', engineState: RUNNING, items: [], showSuggestions: false })

  assert.equal(offline.label, 'Install required', 'the durable cause wins over the generic one')
  assert.equal(errored.label, 'Unavailable')
})

test('an over-long draft is reported as too long, not ready', () => {
  const view = statusChipView({ checkState: 'too-long', engineState: RUNNING, items: [], showSuggestions: false })

  assert.equal(view.label, 'Too long')
  assert.equal(view.clickable, true)
})

test('visible suggestions keep their own label and stay clickable', () => {
  const view = statusChipView({ checkState: 'suggestions', engineState: RUNNING, items: SUGGESTIONS, showSuggestions: true })

  assert.equal(view.label, '2 suggestions')
  assert.equal(view.caption, 'Harper · 2')
  assert.equal(view.clickable, true)
})

test('suggestions outrank the install label so existing list UX is unchanged', () => {
  const view = statusChipView({ checkState: 'suggestions', engineState: MISSING, items: SUGGESTIONS, showSuggestions: true })

  assert.equal(view.caption, 'Harper · 2')
  assert.equal(view.clickable, true)
})

test('rows that are not shown do not claim a count', () => {
  const view = statusChipView({ checkState: 'suggestions', engineState: RUNNING, items: SUGGESTIONS, showSuggestions: false })

  assert.equal(view.label, 'Ready')
})

// --- the API itself: the chip must not report Ready off a backend it cannot reach ------------
//
// `adopt()` only ever runs on a SUCCESSFUL response, so when the route disappears mid-session
// (a Hermes backend rebuilt without the plugin's API mounted — the measured 405 case) `$engine`
// keeps the last healthy answer. A label derived from the check state plus that stale engine
// answer is exactly how `Harper · Ready` was displayed over a dead API.

const STALE_RUNNING = { ...RUNNING, backend: 'unreachable' }
const UNREACHABLE_NO_BINARY = { state: 'idle', version: '2.12.0', binary: null, backend: 'unreachable' }

test('a stale running engine does not claim Ready while the API is unreachable', () => {
  const view = statusChipView({ checkState: 'idle', engineState: STALE_RUNNING, items: [], showSuggestions: false })

  assert.equal(view.label, 'Unavailable', 'reachability outranks last-known engine metadata')
  assert.equal(view.needsInstall, false, 'an unreachable API cannot tell us whether an install is needed')
  assert.equal(view.clickable, true, 'the popover is the only place the condition is explained')
})

test('an unreachable API outranks the install label', () => {
  const view = statusChipView({ checkState: 'idle', engineState: UNREACHABLE_NO_BINARY, items: [], showSuggestions: false })

  assert.equal(view.label, 'Unavailable', 'no evidence the binary is missing, only that nothing answers')
  assert.equal(view.needsInstall, false)
})

test('a reachable API plus a running engine is Ready', () => {
  const view = statusChipView({ checkState: 'idle', engineState: { ...RUNNING, backend: 'reachable' }, items: [], showSuggestions: false })

  assert.equal(view.label, 'Ready')
  assert.equal(view.clickable, false)
})

test('a warm ladder against an already-unreachable API reports unavailable, not starting', () => {
  // `starting` means "a request is in flight and might succeed". Once a request has proven the
  // route is gone, retrying it is not a startup in progress — the honest label is the one that
  // matches what the user can act on, and the ladder's own terminal message says the same.
  const view = statusChipView({ checkState: 'starting', engineState: STALE_RUNNING, items: [], showSuggestions: false })

  assert.equal(view.label, 'Unavailable')
  assert.equal(view.clickable, true)
})

test('a warm ladder with the API answering is starting', () => {
  const view = statusChipView({ checkState: 'starting', engineState: { ...RUNNING, backend: 'reachable' }, items: [], showSuggestions: false })

  assert.equal(view.label, 'Starting')
  assert.equal(view.clickable, true)
})
