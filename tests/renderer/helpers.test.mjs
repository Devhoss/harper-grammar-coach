/** Deterministic logic of the renderer half, loaded as the REAL module under a stub SDK.

    These are the parts that decide what gets written into the user's draft, so they are tested
    without a DOM at all: row-click behaviour lives in suggestion-row.test.mjs.
*/

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  countLabel,
  dropOverlaps,
  foldReplacements,
  normalizeSettings,
  pickForAutoFix,
  survivorsAfterApply
} from '../../desktop/plugin.js'

const DRAFT = 'Thiss is a sentenc whit two mistaks'

test('default suggestion display is the composer popover and submit auto-fix is opt-in', () => {
  const settings = normalizeSettings(null)
  assert.equal(settings.suggestionDisplay, 'popover')
  assert.equal(settings.live, true)
  assert.equal(settings.correctOnSend, false)
  assert.equal(normalizeSettings({}).correctOnSend, false)
  assert.equal(normalizeSettings({ correctOnSend: true }).correctOnSend, true)
  assert.equal(normalizeSettings({ correctOnSend: false }).correctOnSend, false)
  assert.equal(normalizeSettings({ suggestionDisplay: 'underside' }).suggestionDisplay, 'underside')
})

function row(start, end, text, ...suggestions) {
  return {
    start,
    end,
    text,
    code: 'SpellCheck',
    message: `Did you mean to spell ${text} this way?`,
    category: 'spelling',
    lintKind: 'SpellCheck',
    priority: 63,
    suggestions
  }
}

const A = row(0, 5, 'Thiss', 'This', 'Thins')
const B = row(11, 18, 'sentenc', 'sentence')
const C = row(28, 35, 'mistaks', 'mistakes')
const ROWS = [A, B, C]

// --- keeping the list alive across an apply -----------------------------------

test('applying one row drops that row and keeps the survivors visible, shifted', () => {
  const next = 'This is a sentenc whit two mistaks'

  const survivors = survivorsAfterApply(ROWS, [A], next)

  assert.deepEqual(
    survivors.map(item => [item.start, item.end, item.text]),
    [
      [10, 17, 'sentenc'],
      [27, 34, 'mistaks']
    ]
  )
})

test('a survivor is still appliable after the remap: its own fold is exact', () => {
  const next = 'This is a sentenc whit two mistaks'
  const survivors = survivorsAfterApply(ROWS, [A], next)

  assert.equal(foldReplacements(next, [survivors[0]]).text, 'This is a sentence whit two mistaks')
})

test('an insertion shifts later survivors the other way', () => {
  const next = 'Thiss is a sentence whit two mistaks'

  const survivors = survivorsAfterApply(ROWS, [B], next)

  assert.deepEqual(
    survivors.map(item => [item.start, item.end]),
    [
      [0, 5],
      [29, 36]
    ]
  )
})

test('a row overlapping the applied span is dropped, not shifted', () => {
  const overlapping = row(11, 14, 'sen')
  const next = 'Thiss is a sentence whit two mistaks'

  const survivors = survivorsAfterApply([A, overlapping, B, C], [B], next)

  assert.deepEqual(survivors.map(item => item.text), ['Thiss', 'mistaks'])
})

test('a survivor whose text no longer matches is dropped rather than shown at a wrong offset', () => {
  // The applied fix happened, and something else moved too — nobody can say where B is now.
  const next = 'This was a sentenc whit two mistaks'

  assert.deepEqual(survivorsAfterApply(ROWS, [A], next), [])
})

test('applying nothing leaves every row where it was', () => {
  const survivors = survivorsAfterApply(ROWS, [], DRAFT)

  assert.deepEqual(
    survivors.map(item => [item.start, item.end, item.text]),
    ROWS.map(item => [item.start, item.end, item.text])
  )
})

test('the caller rows are never mutated: remapping returns copies', () => {
  const next = 'This is a sentenc whit two mistaks'

  assert.equal(ROWS[1].start, 11)

  const survivors = survivorsAfterApply(ROWS, [A], next)

  assert.notEqual(survivors[0], B)
  assert.equal(B.start, 11)
  assert.equal(survivors[0].start, 10)
})

test('a malformed list cannot produce survivors', () => {
  assert.deepEqual(survivorsAfterApply(undefined, [A], DRAFT), [])
  assert.deepEqual(survivorsAfterApply(ROWS, undefined, DRAFT), [])
  assert.deepEqual(survivorsAfterApply(ROWS, [A], undefined), [])
  assert.deepEqual(survivorsAfterApply([null, { start: 3 }], [], DRAFT), [])
})

// --- the strip's own words ----------------------------------------------------

test('the header counts stay singular, plural, and quiet about nothing', () => {
  assert.equal(countLabel({ count: 1 }), '1 suggestion')
  assert.equal(countLabel({ count: 3 }), '3 suggestions')
})

test('a recheck in flight reads as a suffix, never as an empty list', () => {
  assert.equal(countLabel({ count: 2, checking: true }), '2 suggestions · checking…')
  assert.equal(countLabel({ count: 2, truncated: true }), '2 suggestions · partial')
  assert.equal(countLabel({ count: 2, truncated: true, checking: true }), '2 suggestions · partial · checking…')
})

// --- the write path -----------------------------------------------------------

test('apply all folds every row in one write, highest offset first', () => {
  const folded = foldReplacements(DRAFT, ROWS)

  assert.equal(folded.applied, 3)
  assert.equal(folded.text, 'This is a sentence whit two mistakes')
})

test('a stale suggestion cannot modify the wrong draft', () => {
  // The user kept typing after the check: the row's span is no longer its word.
  const moved = 'Thiss is a sentenc whit two mistakes badly'

  assert.equal(foldReplacements(moved, [C]), null)
})

test('overlapping rows fold as one region', () => {
  const whole = row(11, 18, 'sentenc', 'sentence')
  const inner = row(11, 14, 'sen', 'sane')

  assert.deepEqual(dropOverlaps([whole, inner]).map(item => item.text), ['sentenc'])
})

test('the send path leaves protected technical text byte-for-byte untouched', () => {
  // What the backend now returns for this draft: the prose row only. Folding it must not
  // breathe on the code span or the path.
  const draft = 'I think the backend dont respond when I run `npm run dev` from E:\\hermes\\profiles\\coder.'
  const settings = { categories: { spelling: true }, minPriority: 60 }
  const picks = pickForAutoFix(
    [{ ...row(20, 24, 'dont', "don't", 'dent'), category: 'spelling' }],
    settings
  )

  const folded = foldReplacements(draft, picks)

  assert.equal(folded.applied, 1)
  assert.equal(
    folded.text,
    "I think the backend don't respond when I run `npm run dev` from E:\\hermes\\profiles\\coder."
  )
  assert.ok(folded.text.includes('`npm run dev`'))
  assert.ok(folded.text.includes('E:\\hermes\\profiles\\coder.'))
})
