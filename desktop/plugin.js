/**
 * Harper Grammar Coach — renderer half.
 *
 * A grammar + spelling coach for the chat composer. It talks to this plugin's
 * own Python backend (`dashboard/plugin_api.py`), which owns a persistent
 * `harper-ls` subprocess over stdio LSP and returns suggestions whose offsets
 * are already converted to UTF-16 code units.
 *
 * Nothing here touches app DOM, the ProseMirror view, or internals: every
 * draft read/write goes through `host.composer`, every pixel through a
 * registered contribution, every byte through `ctx.rest` to our own namespace.
 *
 * LIVE CHECKING IS ADVISORY ONLY. The composer's single programmatic write
 * path (`paintDraft`) unconditionally ends with `placeCaretEnd(editor)` and
 * there is no sanctioned caret restore, so a linter that auto-applied while you
 * type would yank the caret to the end of the draft on every correction. The
 * only automation is at submit time, where the draft is cleared immediately
 * afterwards and the caret is moot. Clicking a suggestion ROW accepts one caret
 * jump to the end — documented in the settings panel, not hidden.
 */

import {
  APPEARANCE_AREAS,
  Badge,
  Button,
  COMPOSER_AREAS,
  GlyphSpinner,
  KEYBINDS_AREA,
  ListRow,
  PALETTE_AREA,
  Popover,
  PopoverContent,
  PopoverTrigger,
  SegmentedControl,
  STATUSBAR_AREAS,
  ToggleRow,
  atom,
  host,
  icons,
  useValue
} from '@hermes/plugin-sdk'
import { useEffect, useState } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'

const ID = 'harper-grammar-coach'

/** Draft poll interval. The tick is one in-process bus read; the HTTP check is
 *  debounced off it, so this only bounds how quickly a pause is noticed. */
const TICK_MS = 250
/** Below this there is nothing worth linting (and a cleared composer mid-stream
 *  would otherwise fire a request per turn). */
const MIN_TEXT_CHARS = 3
/** Mirrors the backend's `MAX_TEXT_CHARS`; the engine stays the authority and
 *  this only lets us say "too long" without a round trip. */
const MAX_CHECK_CHARS = 20_000
/** Submit-time budget. Over it the message sends UNCHANGED — a grammar check
 *  must never delay or eat a send. */
const AUTOFIX_TIMEOUT_MS = 900
/** Live-check ceiling. A warm check answers in tens of ms (measured 32 ms end to
 *  end), but this request carries the whole backend round trip, and a loaded
 *  Windows box has been measured taking 6-13 s for even `/api/health` on the same
 *  process — at 4 s every one of those checks died before it could answer and the
 *  strip looked dead. At most one check is in flight at a time (`inFlight`), so a
 *  wider ceiling costs nothing on the happy path. */
const CHECK_TIMEOUT_MS = 8_000
/** After a timeout the debounce is re-armed rather than left spent: a slow answer
 *  is a blip, and the user should not have to edit the draft to get a check back. */
const CHECK_RETRY_MS = 3_000
/** Startup/readiness retries for the plugin API. A cold Desktop profile can
 *  briefly send the first request to the primary backend before its active
 *  profile scope is installed. Keep that recovery bounded and well below the
 *  much longer per-request timeout budget. */
const WARM_RETRY_DELAYS_MS = [500, 1_000, 2_000, 4_000, 8_000, 15_000]
/** Server-side ceiling for the code-action phase, in ms. That phase is the only part
 *  of a check that grows with the draft — Harper re-parses the whole document per
 *  action (~14 ms at 1k chars, ~254 ms at 20k) — so the renderer states how long it is
 *  willing to wait instead of letting the backend run past its timeout. */
const CHECK_BUDGET_MS = 1_200
/** Smaller slice for the send-time check, which has to land inside AUTOFIX_TIMEOUT_MS. */
const AUTOFIX_BUDGET_MS = 600
/** Send-time checking stops at this draft length. Measured against deliberately
 *  error-dense text (one lint every ~11 chars, far worse than real writing), the
 *  600 ms tier costs ~730 ms at 4k chars, ~830 ms at 8k and 1.6 s at 20k — the lint
 *  itself is one uninterruptible LSP request, so `budgetMs` bounds only the action
 *  phase and the wall time grows with the draft. Past this cap the user would wait
 *  most of their 900 ms timeout and still send uncorrected. Waiting for nothing is
 *  the one thing a send path may not do. Live checking is unaffected. */
const AUTOFIX_MAX_CHARS = 4_000
/** Backend failure reasons that fix themselves: the engine re-spawns harper-ls on the next
 *  check, so the user's next keystroke is the retry. Anything else that answers 5xx is
 *  durable and latches the strip offline until an explicit Retry. */
const RECOVERABLE_REASONS = new Set(['timeout', 'engine-dead', 'lsp-error', 'bad-frame'])
/** Why the count says "partial": Harper re-reads the whole draft per fix, so a long one is
 *  checked from the top down until the work budget is spent. */
const TRUNCATED_HINT = 'Long draft — only the first fixes were resolved. Shorten it for a full check.'
/** Rows shown before the list folds into "and N more". */
const MAX_ROWS = 12

const CATEGORIES = [
  { id: 'spelling', label: 'Spelling' },
  { id: 'capitalisation', label: 'Capitalisation' },
  { id: 'grammar', label: 'Grammar rewrites' }
]
const DIALECTS = [
  { id: 'American', label: 'American' },
  { id: 'British', label: 'British' },
  { id: 'Canadian', label: 'Canadian' },
  { id: 'Australian', label: 'Australian' }
]
const PRIORITIES = [
  { id: 60, label: 'High' },
  { id: 30, label: 'Medium' }
]
const DEBOUNCES = [
  { id: 'fast', label: 'Fast', ms: 400 },
  { id: 'normal', label: 'Normal', ms: 700 },
  { id: 'relaxed', label: 'Relaxed', ms: 1500 }
]
const DEFAULTS = {
  live: true,
  correctOnSend: false,
  categories: { spelling: true, capitalisation: true, grammar: false },
  minPriority: 60,
  dialect: 'American',
  debounce: 'normal',
  suggestionDisplay: 'popover'
}

/** An `@ref` chip marker. Requires preceding whitespace so an ordinary
 *  `user@example.com` in a draft is not mistaken for a reference token. */
const AT_REF = /(?:^|\s)@[A-Za-z0-9_.\-]+/
/** A leading `/command`. `setDraft` hydrates these into chips like a paste, so
 *  rewriting a draft that contains one risks mangling the reference. */
const SLASH_CMD = /^\s*\/[A-Za-z0-9_.\-]+/m

// --- pure helpers (exported for node tests, like plugins/radio does) ----------

export function normalizeSettings(raw) {
  const src = raw && typeof raw === 'object' ? raw : {}
  const cats = src.categories && typeof src.categories === 'object' ? src.categories : {}
  const bool = (value, fallback) => (value === undefined ? fallback : Boolean(value))

  return {
    live: bool(src.live, DEFAULTS.live),
    correctOnSend: bool(src.correctOnSend, DEFAULTS.correctOnSend),
    categories: {
      spelling: bool(cats.spelling, DEFAULTS.categories.spelling),
      capitalisation: bool(cats.capitalisation, DEFAULTS.categories.capitalisation),
      grammar: bool(cats.grammar, DEFAULTS.categories.grammar)
    },
    minPriority: PRIORITIES.some(p => p.id === src.minPriority) ? src.minPriority : DEFAULTS.minPriority,
    dialect: DIALECTS.some(d => d.id === src.dialect) ? src.dialect : DEFAULTS.dialect,
    debounce: DEBOUNCES.some(d => d.id === src.debounce) ? src.debounce : DEFAULTS.debounce,
    suggestionDisplay: ['popover', 'underside'].includes(src.suggestionDisplay)
      ? src.suggestionDisplay
      : DEFAULTS.suggestionDisplay
  }
}

export function debounceMs(id) {
  const found = DEBOUNCES.find(d => d.id === id)

  return found ? found.ms : 700
}

/** The replacement we would write for one suggestion, or null when Harper
 *  offered nothing usable. */
export function replacementOf(item) {
  const list = item && item.suggestions

  if (!Array.isArray(list)) {
    return null
  }

  for (const candidate of list) {
    if (typeof candidate === 'string' && candidate.length > 0) {
      return candidate
    }
  }

  return null
}

/** A non-overlapping subset of `items`, best-first.
 *
 *  Harper routinely emits overlapping spans for one phrase ("could of" as a
 *  whole plus "of" alone). Folding overlapping edits against shifting offsets
 *  corrupts text, and an all-or-nothing fold would then report a spurious
 *  "draft changed". Ranking by confidence then span length keeps the single
 *  best reading of each region. Returned sorted by offset. */
export function dropOverlaps(items) {
  if (!Array.isArray(items)) {
    return []
  }

  const ranked = items
    .filter(
      item =>
        item &&
        Number.isInteger(item.start) &&
        Number.isInteger(item.end) &&
        item.end > item.start &&
        replacementOf(item) !== null
    )
    .sort(
      (a, b) =>
        (b.priority ?? 0) - (a.priority ?? 0) ||
        b.end - b.start - (a.end - a.start) ||
        a.start - b.start
    )

  const kept = []

  for (const item of ranked) {
    if (kept.some(other => other.start < item.end && item.start < other.end)) {
      continue
    }

    kept.push(item)
  }

  return kept.sort((a, b) => a.start - b.start)
}

/** Apply `items` to `text` in one write, highest offset first so earlier
 *  offsets stay valid.
 *
 *  ALL-OR-NOTHING with a stale guard: if any span no longer matches the text
 *  Harper saw (the user kept typing), we return null instead of splicing on a
 *  shifted offset. Partial application would leave the draft in a state no
 *  suggestion list describes. */
export function foldReplacements(text, items) {
  if (typeof text !== 'string') {
    return null
  }

  const picks = dropOverlaps(items)

  if (!picks.length) {
    return null
  }

  let out = text
  let applied = 0

  for (const item of picks.slice().sort((a, b) => b.start - a.start)) {
    const replacement = replacementOf(item)
    const { start, end } = item

    if (start < 0 || end > out.length || start >= end) {
      return null
    }

    if (out.slice(start, end) !== item.text) {
      return null
    }

    out = out.slice(0, start) + replacement + out.slice(end)
    applied += 1
  }

  return applied > 0 ? { text: out, applied } : null
}

/** True when the draft holds a token `setDraft` would re-hydrate into a chip. */
export function bearsToken(text) {
  return typeof text === 'string' && (AT_REF.test(text) || SLASH_CMD.test(text))
}

/** Dismissal key: ignore THIS rule for THIS word in THIS draft. Carrying the
 *  draft text is what makes "until the draft changes" in the tooltip true, and
 *  what keeps a mis-click from muting the word for the whole session. */
export function ignoreKey(item, text = '') {
  return `${text}|${item?.code ?? ''}|${item?.text ?? ''}`
}

export function confidenceLabel(priority) {
  const value = Number(priority) || 0

  if (value >= 60) {
    return 'High'
  }

  return value >= 30 ? 'Medium' : 'Low'
}

/** What submit-time auto-fix is allowed to touch: enabled categories only, at
 *  or above the confidence floor, and only where Harper offered a replacement. */
export function pickForAutoFix(suggestions, settings) {
  if (!Array.isArray(suggestions)) {
    return []
  }

  const categories = (settings && settings.categories) || {}
  const minPriority = Number(settings && settings.minPriority) || 0

  return suggestions.filter(item => {
    if (!item || typeof item.text !== 'string') {
      return false
    }

    if (!categories[item.category]) {
      return false
    }

    if ((Number(item.priority) || 0) < minPriority) {
      return false
    }

    return replacementOf(item) !== null
  })
}

/** The rows that survive an apply, already in the NEW draft's coordinates.
 *
 *  A click must not blank the strip while the next check runs, and it must not show a row whose
 *  offsets belong to the old text either. So every untouched row is shifted by the net length
 *  change of the applied edits BEFORE it, and then re-verified against the new draft: a row that
 *  no longer reads the same at its new offset is dropped, not offered. Same rule as
 *  `foldReplacements` — a suggestion is only ever shown while its span is provably its word. */
export function survivorsAfterApply(rows, applied, nextText) {
  if (!Array.isArray(rows) || !Array.isArray(applied) || typeof nextText !== 'string') {
    return []
  }

  const picks = applied.filter(
    item =>
      item &&
      Number.isInteger(item.start) &&
      Number.isInteger(item.end) &&
      item.end > item.start &&
      replacementOf(item) !== null
  )

  const out = []

  for (const row of rows) {
    if (!row || !Number.isInteger(row.start) || !Number.isInteger(row.end) || row.end <= row.start) {
      continue
    }

    // The applied row itself overlaps, and so does any row sharing that region.
    if (picks.some(pick => pick.start < row.end && row.start < pick.end)) {
      continue
    }

    const shift = picks.reduce(
      (total, pick) =>
        pick.start < row.start ? total + replacementOf(pick).length - (pick.end - pick.start) : total,
      0
    )
    const start = row.start + shift
    const end = row.end + shift

    if (nextText.slice(start, end) !== row.text) {
      continue
    }

    out.push({ ...row, start, end })
  }

  return out
}

/** The strip's count line. `checking` is a suffix rather than a replacement: the rows underneath
 *  are still the ones the user is reading, they are just being reconfirmed. */
export function countLabel({ count = 0, truncated = false, checking = false }) {
  const base = `${count} ${count === 1 ? 'suggestion' : 'suggestions'}`

  return `${base}${truncated ? ' · partial' : ''}${checking ? ' · checking…' : ''}`
}

/** `api-transport` shapes a non-2xx as `Error("<status>: <raw body>")`. Only the
 *  message survives the `ipcRenderer.invoke` rejection (structured clone keeps
 *  name/message/stack and drops `statusCode`), so the prefix is the status. Our
 *  backend puts the human sentence in `detail.message` and the machine reason in
 *  `detail.reason`. */
function parseDetail(err) {
  const message = err && typeof err.message === 'string' ? err.message : ''
  const body = message.replace(/^\d+:\s*/, '')

  if (!body) {
    return null
  }

  try {
    const parsed = JSON.parse(body)
    const detail = parsed && typeof parsed === 'object' ? parsed.detail : null

    if (detail && typeof detail === 'object') {
      return {
        reason: typeof detail.reason === 'string' ? detail.reason : '',
        message: typeof detail.message === 'string' ? detail.message : ''
      }
    }

    if (typeof detail === 'string' && detail) {
      return { reason: '', message: detail }
    }
  } catch {
    // Body was not JSON — fall through to the raw message below.
  }

  return null
}

/** The HTTP status behind a desktop REST rejection: the property when the call
 *  stayed in-process, the `"<status>: <body>"` prefix when it crossed IPC. */
function httpStatus(err) {
  const direct = Number(err && err.statusCode) || 0

  if (direct) {
    return direct
  }

  const message = err && typeof err.message === 'string' ? err.message : ''

  return Number(/^\D*(\d{3}):/.exec(message)?.[1]) || 0
}

/** The desktop transport rejects a deadlined request with
 *  `Timed out connecting to Hermes backend after Nms` — no status, no `detail`,
 *  so the message is the only thing that names it. */
function isTimeoutError(err) {
  return /timed out/i.test(err && typeof err.message === 'string' ? err.message : '')
}

export function errorReason(err) {
  const detail = parseDetail(err)

  if (detail?.reason) {
    return detail.reason
  }

  return httpStatus(err) === 404 ? 'not-mounted' : ''
}

export function describeError(err) {
  const detail = parseDetail(err)

  // A 404 on this prefix is never ours — the backend only answers 400, 413 and 503 — so it is
  // FastAPI's route miss, whose body is `{"detail":"Not Found"}`. That generic string carries
  // no information and must not outrank the explanation a user can act on. During startup it
  // can also mean the request reached the primary profile before the active profile was ready.
  if (httpStatus(err) === 404) {
    return 'Harper API is not available on the current backend. Check the active profile and plugin settings.'
  }

  if (detail?.message) {
    return detail.message
  }

  const message = err && typeof err.message === 'string' ? err.message : ''

  if (message) {
    return message.length > 160 ? `${message.slice(0, 157)}…` : message
  }

  return 'unknown error'
}

/** Startup failures that can resolve without changing Harper configuration.
 *  A 404 is transient here because ctx.rest may still be scoped to Hermes'
 *  primary profile; repeated failure is surfaced after the bounded retry budget. */
function isTransientWarmFailure(err) {
  const reason = errorReason(err)
  const status = httpStatus(err)
  const message = err && typeof err.message === 'string' ? err.message : ''

  if (reason === 'not-mounted' || isTimeoutError(err) || RECOVERABLE_REASONS.has(reason)) {
    return true
  }

  // A transport failure has no HTTP status. Do not retry arbitrary programming errors.
  if (status === 0 && /network|fetch|connect|socket|econn|backend unavailable/i.test(message)) {
    return true
  }

  // An unclassified server failure may be a backend still starting. Explicit
  // Harper engine/configuration reasons remain terminal unless listed above.
  return status >= 500 && !reason
}

function exhaustedWarmMessage(err) {
  if (errorReason(err) === 'not-mounted') {
    return 'Harper could not reach the API for the active profile after startup retries. Check that the Agent plugin is enabled, then press Retry.'
  }

  return `Harper backend is still unavailable after startup retries. ${describeError(err)} Press Retry to try again.`
}

async function configuredCorrectOnSend(fallback = false) {
  try {
    const result = await host.request('plugins.manage', { action: 'list' })
    const plugin = result?.plugins?.find(row => row?.key === ID || row?.name === ID)
    const field = plugin?.settings_schema?.find(row => row?.key === 'correct_on_send')

    return typeof field?.value === 'boolean' ? field.value : fallback
  } catch {
    return fallback
  }
}

/** Never log draft text. Shape and counts only, matching the app's own
 *  `[composer-rehydrate]` precedent. */
function log(...args) {
  console.debug(`[${ID}]`, ...args)
}

// --- state -------------------------------------------------------------------

const $settings = atom(normalizeSettings(null))
const $engine = atom({
  state: 'unknown',
  version: '',
  reason: null,
  binary: null,
  checks: 0,
  lastCheckMs: 0,
  dialect: DEFAULTS.dialect
})
/** The cleared-check shape every reset publishes, so a new reset site cannot
 *  drop a field the strip reads. */
const IDLE_CHECK = { state: 'idle', text: '', suggestions: [], truncated: false }
/** `state`: idle | checking | clean | suggestions | offline | too-long | error.
 *  While `checking`, `suggestions` keeps the PREVIOUS rows so the strip holds
 *  its height instead of collapsing and re-expanding per keystroke.
 *  `truncated` marks a check that ran out of server-side work budget on a long
 *  draft: the rows are real, the list is just not the whole draft. */
const $check = atom(IDLE_CHECK)
const $ignored = atom(new Set())
const $expanded = atom(false)
/** The draft text the user dismissed the strip for. Text-keyed, so the next
 *  edit brings the strip back on its own — no sticky "hidden" mode. */
const $dismissed = atom(null)
/** Count of mounted underside surfaces (main composer + any tiles/HUD). */
const $surfaces = atom(0)
const $suggestionsOpen = atom(false)
/** Last set the user closed; an identical recheck remains dismissed. */
const $dismissedSuggestionSet = atom(null)
// Radix normally focuses the first popover item on open and dismisses when
// focus moves to the composer. Auto-open is visual-only; row application is
// the one deliberate outside-focus transition that must keep the popover up.
const $autoOpened = atom(false)
const $applyingSuggestion = atom(false)

function suggestionSetKey(items) {
  const parts = items.map(item => [
    String(item?.code ?? ''),
    String(item?.category ?? ''),
    String(item?.text ?? ''),
    String(replacementOf(item) ?? '')
  ])
  parts.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
  return JSON.stringify(parts)
}

function closeSuggestionsPopover() {
  const check = $check.get()
  const items = visibleItems(check.suggestions, $ignored.get(), check.text)
  $dismissedSuggestionSet.set(items.length ? suggestionSetKey(items) : null)
  $suggestionsOpen.set(false)
  $autoOpened.set(false)
}

// --- engine ------------------------------------------------------------------

export function createEngine(ctx) {
  let generation = 0
  let dueAt = 0
  let lastSeen = null
  let checkedText = null
  let checkedResult = null
  let inFlight = false
  let reading = false
  let disposed = false
  /** Sticky after warm recovery is exhausted so a user with no backend does
   *  not get a doomed request every debounce for the rest of the session.
   *  Cleared by an explicit Retry, a restart, or a successful request. */
  let backendDown = false
  let offlineShown = false
  /** True until the load-time `/warm` settles. Harper's dictionary load was
   *  measured at 4.4 s; a live check issued during it waits on the same engine
   *  and burns its whole ceiling for nothing, so the tick holds off. Cleared on
   *  both outcomes — a failed warm must not mute checking for the session. */
  let warming = true
  let warmPromise = null
  let warmRetryCancel = null
  let warmRetryIndex = 0
  let warmStarted = false
  let warmAttemptNumber = 0
  let warmStartedAt = 0
  let warmReadyAt = 0
  let suppressAutoOpenText = null
  let applyFocusGuardTimer = null

  const publish = next => {
    if (!disposed) {
      $check.set(next)

      if (next.state === 'checking') {
        if (!visibleItems(next.suggestions, $ignored.get(), next.text).length) {
          $suggestionsOpen.set(false)
        }
        return
      }

      const items = visibleItems(next.suggestions, $ignored.get(), next.text)

      if (!items.length) {
        $suggestionsOpen.set(false)
        $dismissedSuggestionSet.set(null)
        if (next.text === suppressAutoOpenText) suppressAutoOpenText = null
        return
      }

      const key = suggestionSetKey(items)

      if (next.text === suppressAutoOpenText) {
        if (!$suggestionsOpen.get()) $dismissedSuggestionSet.set(key)
        suppressAutoOpenText = null
      } else if ($dismissedSuggestionSet.get() !== key) {
        $autoOpened.set(true)
        $suggestionsOpen.set(true)
      }
    }
  }

  const publishOffline = reason => {
    publish({ state: 'offline', text: '', suggestions: [], reason })
  }

  const publishError = (err, text) => {
    const reason = errorReason(err)
    const status = httpStatus(err)

    // A missing or unstartable binary is a durable condition, not a blip: stop firing until
    // the user retries, restarts, or installs. The recoverable ones are deliberately NOT
    // latched — the backend re-spawns harper-ls by itself on the next check, so going offline
    // here would strand the strip on a wedge that the next keystroke already fixes.
    if (status === 404 || (status >= 500 && !RECOVERABLE_REASONS.has(reason))) {
      backendDown = true
      publishOffline(describeError(err))

      return
    }

    if (reason === 'too-long') {
      publish({ state: 'too-long', text, suggestions: [] })

      return
    }

    publish({ state: 'error', text, suggestions: [], reason: describeError(err) })
  }

  const keepRows = () => {
    const current = $check.get()

    return current.state === 'suggestions' || current.state === 'checking' ? current.suggestions : []
  }

  const fire = async text => {
    if (disposed || inFlight || backendDown) {
      return
    }

    inFlight = true
    dueAt = 0
    const gen = ++generation

    try {
      const payload = await ctx.rest('/check', {
        method: 'POST',
        body: { text, budgetMs: CHECK_BUDGET_MS },
        timeoutMs: CHECK_TIMEOUT_MS
      })

      if (disposed || gen !== generation) {
        return
      }

      backendDown = false
      offlineShown = false
      checkedText = text
      checkedResult = payload
      const suggestions = Array.isArray(payload?.suggestions) ? payload.suggestions : []
      const truncated = payload?.truncated === true

      log('check', {
        chars: text.length,
        suggestions: suggestions.length,
        truncated,
        engineMs: payload?.engineMs,
        sinceWarmMs: warmReadyAt ? Math.round(performance.now() - warmReadyAt) : undefined
      })
      publish(
        suggestions.length
          ? { state: 'suggestions', text, suggestions, truncated }
          : { state: 'clean', text, suggestions: [], truncated: false }
      )
    } catch (err) {
      if (disposed || gen !== generation) {
        return
      }

      log('check failed', errorReason(err) || describeError(err))
      publishError(err, text)

      // A timeout is a slow answer, not a wrong one. Without this the debounce is
      // spent (`dueAt` was zeroed when the check launched) and the strip sits on
      // its error until the user edits the draft again.
      if (isTimeoutError(err)) {
        dueAt = Date.now() + CHECK_RETRY_MS
      }
    } finally {
      inFlight = false
    }
  }

  /** One poll tick. Drives the trailing debounce itself rather than allocating
   *  and cancelling a timer per keystroke. */
  const tick = async () => {
    if (disposed || reading) {
      return
    }

    reading = true

    let draft

    try {
      draft = await host.composer.getDraft(null)
    } catch {
      draft = null
    } finally {
      reading = false
    }

    if (disposed) {
      return
    }

    const settings = $settings.get()

    if (!settings.live) {
      if (lastSeen !== null) {
        lastSeen = null
        dueAt = 0
        publish(IDLE_CHECK)
      }

      return
    }

    const text = typeof draft === 'string' ? draft : ''

    if (text.length < MIN_TEXT_CHARS) {
      if (lastSeen !== null || $check.get().state !== 'idle') {
        lastSeen = null
        dueAt = 0
        publish(IDLE_CHECK)
      }

      return
    }

    if (text.length > MAX_CHECK_CHARS) {
      lastSeen = text
      dueAt = 0
      publish({ state: 'too-long', text, suggestions: [] })

      return
    }

    // Hold off while the load-time `/warm` is still settling. Nothing is latched
    // here: `lastSeen` is left untouched, so the first tick after the warm
    // answers treats the draft as new and runs the normal debounce.
    if (warming) {
      return
    }

    if (backendDown) {
      if (!offlineShown) {
        offlineShown = true
        publishOffline($check.get().reason || 'Harper backend unavailable')
      }

      return
    }

    if (text === lastSeen) {
      if (dueAt && Date.now() >= dueAt && !inFlight) {
        void fire(text)
      }

      return
    }

    // A new draft supersedes anything in flight and restarts the debounce.
    lastSeen = text
    generation += 1
    if (text !== suppressAutoOpenText) suppressAutoOpenText = null
    dueAt = Date.now() + debounceMs(settings.debounce)
    publish({ state: 'checking', text, suggestions: keepRows() })
  }

  /** A check for an EXACT text, bypassing the generation logic — the middleware
   *  needs a fresh answer for what is being sent right now, not a cancellation.
   *  Resolves null on any failure so callers can pass through unchanged. */
  const checkNow = async (text, timeoutMs, budgetMs) => {
    if (checkedText === text && checkedResult) {
      return checkedResult
    }

    try {
      const payload = await ctx.rest('/check', {
        method: 'POST',
        body: { text, budgetMs: budgetMs ?? CHECK_BUDGET_MS },
        timeoutMs: timeoutMs ?? CHECK_TIMEOUT_MS
      })

      checkedText = text
      checkedResult = payload

      return payload
    } catch (err) {
      log('checkNow failed', errorReason(err) || describeError(err))

      return null
    }
  }

  /** Drop the renderer-side cache (the backend has its own, keyed by text). */
  const invalidate = () => {
    checkedText = null
    checkedResult = null
  }

  const applyItems = async (items, { focus = true } = {}) => {
    const picks = dropOverlaps(items)

    if (!picks.length) {
      return { applied: 0, reason: 'empty' }
    }

    const draft = await host.composer.getDraft(null).catch(() => null)

    if (typeof draft !== 'string') {
      return { applied: 0, reason: 'no-surface' }
    }

    const folded = foldReplacements(draft, picks)

    if (!folded) {
      // The draft moved under us. Re-check rather than guess.
      invalidate()
      lastSeen = null
      dueAt = Date.now()

      return { applied: 0, reason: 'stale' }
    }

    // Hermes' supported setDraft path also requests composer focus. Arm the
    // popover guard BEFORE the write; waiting until setDraft resolves misses
    // that focus request's React effect.
    if (focus) $applyingSuggestion.set(true)
    const wrote = await host.composer.setDraft(null, folded.text).catch(() => false)

    if (!wrote) {
      if (focus) $applyingSuggestion.set(false)
      return { applied: 0, reason: 'no-surface' }
    }

    // setDraft's official paint path parks the caret at the end and requests
    // composer focus. Keep outside-focus dismissal suppressed briefly while
    // its state update/effect runs. Pointer outside and Escape remain normal.
    if (focus) {
      if (applyFocusGuardTimer !== null) clearTimeout(applyFocusGuardTimer)
      applyFocusGuardTimer = setTimeout(() => {
        applyFocusGuardTimer = null
        $applyingSuggestion.set(false)
      }, 300)
    }
    invalidate()
    lastSeen = null
    dueAt = Date.now()
    $dismissed.set(null)
    suppressAutoOpenText = folded.text
    // Hold the rows that are still true of the NEW draft, at their new offsets, while the
    // recheck runs. Collapsing to an empty list here is what made every click flicker; the
    // re-verification inside `survivorsAfterApply` is what keeps a stale row from being
    // offered against text it no longer describes.
    publish({
      state: 'checking',
      text: folded.text,
      suggestions: survivorsAfterApply($check.get().suggestions, picks, folded.text)
    })

    return { applied: folded.applied }
  }

  const ignore = item => {
    const next = new Set($ignored.get())

    next.add(ignoreKey(item, $check.get().text))
    $ignored.set(next)
    const check = $check.get()
    if (!visibleItems(check.suggestions, next, check.text).length) {
      $suggestionsOpen.set(false)
      $dismissedSuggestionSet.set(null)
    }
  }

  const adopt = payload => {
    if (!payload || typeof payload !== 'object') {
      return
    }

    $engine.set({
      state: payload.state || 'unknown',
      version: payload.version || '',
      reason: payload.reason ?? null,
      binary: payload.binary ?? null,
      checks: Number(payload.checks) || 0,
      lastCheckMs: Number(payload.lastCheckMs) || 0,
      dialect: payload.dialect || DEFAULTS.dialect
    })
  }

  /** Start + pre-warm the dictionary (~2 s once) so the user's first real
   *  check costs 6 ms, not 2026 ms. Failures are DATA here, not HTTP errors. */
  const attemptWarm = async () => {
    if (disposed) return false
    warmAttemptNumber += 1
    if (!warmStartedAt) warmStartedAt = performance.now()

    // The stored dialect goes up BEFORE the start, not after: harper-ls reads it
    // from the workspace/configuration answer it only asks for during startup, so
    // setting it on a warm engine means killing that engine and paying the ~2 s
    // dictionary load a second time. On a cold one `/config` starts the process
    // itself, which is why the `/warm` below then returns early. A failure here is
    // left to `/warm`, which reports the real state (a missing binary included) as
    // data rather than as a toast the user did nothing to provoke.
    try {
      const dialect = $settings.get().dialect

      if (dialect && dialect !== $engine.get().dialect) {
        adopt(await ctx.rest('/config', { method: 'POST', body: { dialect }, timeoutMs: 20_000 }))
      }
    } catch {
      // Deliberate: /warm below is the authority on whether the engine can start.
    }

    try {
      const payload = await ctx.rest('/warm', { method: 'POST', timeoutMs: 15_000 })

      adopt(payload)

      if (payload && payload.ok === false) {
        // "Cannot start" is durable — the tick must not fire a doomed check
        // every debounce until the user installs, restarts, or retries.
        const reason = payload.reason || ''
        const error = new Error(payload.message || reason || 'Harper engine offline')
        error.reason = reason
        backendDown = true
        offlineShown = true
        return { ok: false, error, transient: RECOVERABLE_REASONS.has(reason) }
      } else {
        backendDown = false
        offlineShown = false
        warmRetryIndex = 0
        lastSeen = null
        dueAt = 0
        warmReadyAt = performance.now()
        log('warm', {
          state: payload?.state,
          warmupMs: payload?.warmupMs,
          attempt: warmAttemptNumber,
          sinceStartupMs: Math.round(warmReadyAt - warmStartedAt)
        })
        return { ok: true }
      }
    } catch (err) {
      backendDown = true
      offlineShown = true
      log('warm failed', describeError(err))
      return { ok: false, error: err, transient: isTransientWarmFailure(err) }
    } finally {
      warming = false
    }
  }

  const warm = async () => {
    if (disposed) return false
    if (warmPromise) return warmPromise
    if (warmRetryCancel) {
      warmRetryCancel()
      warmRetryCancel = null
    }

    warmStarted = true
    warming = true
    publish({ state: 'starting', text: '', suggestions: [] })
    const run = async () => {
      const result = await attemptWarm()
      if (disposed) return false
      if (result.ok) {
        backendDown = false
        offlineShown = false
        warmRetryIndex = 0
        return true
      }
      if (result.transient && warmRetryIndex < WARM_RETRY_DELAYS_MS.length) {
        const delay = WARM_RETRY_DELAYS_MS[warmRetryIndex++]
        warming = true
        backendDown = false
        log('warm retry scheduled', { attempt: warmAttemptNumber, delayMs: delay })
        publish({ state: 'starting', text: '', suggestions: [], reason: `Retrying in ${Math.ceil(delay / 1000)}s` })
        const scheduled = ctx.setTimeout(() => {
          warmRetryCancel = null
          void warm()
        }, delay)
        warmRetryCancel = typeof scheduled === 'function' ? scheduled : () => clearTimeout(scheduled)
        return false
      }
      backendDown = true
      offlineShown = true
      publishOffline(result.transient ? exhaustedWarmMessage(result.error) : describeError(result.error))
      return false
    }
    warmPromise = run().finally(() => { warmPromise = null })
    return warmPromise
  }

  const refreshStatus = async () => {
    try {
      adopt(await ctx.rest('/status', { timeoutMs: CHECK_TIMEOUT_MS }))
    } catch (err) {
      log('status failed', describeError(err))
    }
  }

  const setDialect = async dialect => {
    invalidate()
    lastSeen = null
    dueAt = 0

    try {
      adopt(await ctx.rest('/config', { method: 'POST', body: { dialect }, timeoutMs: 15_000 }))
    } catch (err) {
      host.notify({ kind: 'error', message: `Harper dialect not applied: ${describeError(err)}` })
    }
  }

  const restart = async () => {
    invalidate()
    backendDown = false
    offlineShown = true
    publishOffline('Restarting Harper engine…')

    try {
      adopt(await ctx.rest('/restart', { method: 'POST', timeoutMs: 20_000 }))
      offlineShown = false
      await warm()
      host.notify({ kind: 'success', message: 'Harper engine restarted.' })
    } catch (err) {
      offlineShown = true
      publishOffline(describeError(err))
      host.notify({ kind: 'error', message: `Harper restart failed: ${describeError(err)}` })
    }
  }

  /** User-triggered download of the pinned harper-ls release. Never automatic. */
  const bootstrap = async () => {
    try {
      const payload = await ctx.rest('/bootstrap', { method: 'POST', timeoutMs: 240_000 })

      if (payload?.installed) {
        host.notify({ kind: 'success', message: `Harper ${payload.version || ''} installed.` })
      }

      backendDown = false
      offlineShown = false
      await warm()

      return true
    } catch (err) {
      host.notify({ kind: 'error', message: `Harper install failed: ${describeError(err)}` })

      return false
    }
  }

  /** Force a check of the current draft right now (palette / Retry). */
  const recheck = async () => {
    if (warmStarted && (warming || backendDown)) {
      const ready = await warm()
      if (!ready) return
    }
    backendDown = false
    offlineShown = false
    const draft = await host.composer.getDraft(null).catch(() => null)

    if (typeof draft !== 'string' || draft.length < MIN_TEXT_CHARS) {
      host.notify({ kind: 'info', message: 'Nothing to check — the composer is empty.' })

      return
    }

    if (draft.length > MAX_CHECK_CHARS) {
      publish({ state: 'too-long', text: draft, suggestions: [] })

      return
    }

    generation += 1
    lastSeen = draft
    dueAt = 0
    publish({ state: 'checking', text: draft, suggestions: keepRows() })
    await fire(draft)
  }

  const dispose = () => {
    disposed = true
    generation += 1
    if (applyFocusGuardTimer !== null) clearTimeout(applyFocusGuardTimer)
    applyFocusGuardTimer = null
    $applyingSuggestion.set(false)
    if (warmRetryCancel) warmRetryCancel()
    warmRetryCancel = null
  }

  return {
    tick,
    fire,
    checkNow,
    applyItems,
    ignore,
    warm,
    refreshStatus,
    setDialect,
    restart,
    bootstrap,
    recheck,
    invalidate,
    dispose,
    get backendDown() {
      return backendDown
    },
    get warming() {
      return warming
    },
    get checkState() {
      return $check.get()
    }
  }
}

// --- components --------------------------------------------------------------

/** Ref-counts mounted underside surfaces. `getDraft(null)` resolves to the ONE
 *  active composer, so a strip in every tile would show the same suggestions
 *  under the wrong draft. With more than one surface mounted, the inline strip
 *  bows out and the statusbar chip carries the list instead. */
function useSurfaceCount() {
  const surfaces = useValue($surfaces)

  useEffect(() => {
    $surfaces.set($surfaces.get() + 1)

    return () => $surfaces.set(Math.max(0, $surfaces.get() - 1))
  }, [])

  return surfaces
}

function visibleItems(suggestions, ignored, text) {
  return (Array.isArray(suggestions) ? suggestions : []).filter(item => !ignored.has(ignoreKey(item, text)))
}

/** The whole row is the apply control: the reading itself is the target, so a click
 *  never has to hunt for a button. The ignore icon stays a separate surface — its own
 *  click is stopped before it reaches the row, and a keydown that bubbled up from a
 *  focused child is not an activation of the row. */
export function SuggestionRow({ item, engine }) {
  const replacement = replacementOf(item)
  const category = String(item.category ?? 'grammar')
  const label = category === 'spelling' ? 'Spelling' : category === 'capitalisation' ? 'Capitalisation' : 'Grammar'
  const changeLabel = `Apply correction: Change '${item.text}' to '${replacement}'`

  const onApply = async () => {
    const result = await engine.applyItems([item])

    if (result.reason === 'stale') {
      host.notify({ kind: 'warning', message: 'Draft changed — re-checking before applying.' })
    } else if (result.reason === 'no-surface') {
      host.notify({ kind: 'warning', message: 'No open composer to update.' })
    }
  }

  return jsxs('div', {
    className: 'hgc-item',
    children: [
      jsx(Button, {
        variant: 'ghost',
        size: 'micro',
        className: 'hgc-apply-row',
        'aria-label': changeLabel,
        onClick: () => void onApply(),
        children: jsxs('span', { className: 'hgc-row-content', children: [
          jsx('span', { className: 'hgc-bad', children: item.text }),
          jsx('span', { className: 'hgc-arrow', children: jsx(icons.ChevronRight, { className: 'hgc-ico' }) }),
          jsx('span', { className: 'hgc-good', children: replacement }),
          jsx('span', { className: 'hgc-spacer' }),
          jsx('span', { className: 'hgc-meta', children: `${label} · ${confidenceLabel(item.priority)}` })
        ]})
      }),
      jsx(Button, {
        variant: 'ghost',
        size: 'micro',
        title: 'Ignore this rule for this text until the draft changes',
        'aria-label': 'Ignore this suggestion',
        onClick: event => {
          event.stopPropagation()
          engine.ignore(item)
        },
        children: jsx(icons.EyeOff, { className: 'hgc-ico' })
      })
    ]
  })
}
function SuggestionList({ suggestions, engine, ignored, text }) {
  const items = visibleItems(suggestions, ignored, text)
  const shown = items.slice(0, MAX_ROWS)
  const rest = items.length - shown.length

  return jsxs('div', {
    className: 'hgc-list',
    children: [
      ...shown.map((item, index) => jsx(SuggestionRow, { item, engine }, `${index}:${item.start}:${item.code}`)),
      rest > 0
        ? jsx('div', {
            className: 'hgc-note',
            children: `…and ${rest} more. Apply all handles every suggestion at once.`
          })
        : null
    ]
  })
}

function ApplyAllButton({ items, engine, onApplied }) {
  const run = async () => {
    const result = await engine.applyItems(items)
    if (result.applied > 0) onApplied?.(result)
    else if (result.reason === 'stale') host.notify({ kind: 'warning', message: 'Draft changed — re-checking before applying.' })
    else if (result.reason === 'no-surface') host.notify({ kind: 'warning', message: 'No open composer to update.' })
  }
  return jsx(Button, { variant: 'secondary', size: 'micro', onClick: () => void run(), children: 'Apply all' })
}

function ComposerPopover({ engine }) {
  const surfaces = useValue($surfaces)
  const settings = useValue($settings)
  const check = useValue($check)
  const ignored = useValue($ignored)
  const open = useValue($suggestionsOpen)
  const items = visibleItems(check.suggestions, ignored, check.text)
  if (surfaces !== 1 || settings.suggestionDisplay !== 'popover' || !items.length) return null

  return jsxs(Popover, {
      open,
    onOpenChange: next => {
      if (next) {
        $autoOpened.set(false)
        $suggestionsOpen.set(true)
      } else closeSuggestionsPopover()
    },
    children: [
      jsx(PopoverTrigger, {
        asChild: true,
        children: jsx(Button, {
          variant: 'ghost', size: 'micro',
          'aria-label': `Harper, ${items.length} suggestions`,
          title: 'Open Harper suggestions',
          children: `Harper · ${items.length}`
        })
      }, 'trigger'),
      jsx(PopoverContent, {
        side: 'top', align: 'start', className: 'hgc-pop',
        onOpenAutoFocus: event => { if ($autoOpened.get()) event.preventDefault() },
        onFocusOutside: event => { if ($applyingSuggestion.get()) event.preventDefault() },
        children: jsxs('div', { className: 'hgc-pop-body', children: [
          jsxs('div', { className: 'hgc-row', children: [
            jsx('span', { className: 'hgc-h', children: `${items.length} suggestions` }),
            jsx('span', { className: 'hgc-spacer' }),
            jsx(ApplyAllButton, { items, engine })
          ]}),
          jsx(SuggestionList, { suggestions: check.suggestions, engine, ignored, text: check.text })
        ]})
      }, 'content')
    ]
  })
}
function ComposerStrip({ engine }) {
  const surfaces = useSurfaceCount()
  const settings = useValue($settings)
  const check = useValue($check)
  const expanded = useValue($expanded)
  const ignored = useValue($ignored)
  const dismissedText = useValue($dismissed)

  // Hooks above are unconditional; only now may we bail out.
  if (surfaces !== 1 || settings.suggestionDisplay !== 'underside') {
    return null
  }

  if (dismissedText !== null && dismissedText === check.text) {
    return null
  }

  const items = visibleItems(check.suggestions, ignored, check.text)

  if (check.state === 'idle' || check.state === 'clean') {
    return null
  }

  if (check.state === 'starting') {
    return jsx('div', {
      className: 'hgc-strip',
      children: jsx('div', {
        className: 'hgc-row',
        children: jsxs('span', {
          className: 'hgc-count',
          children: [jsx(GlyphSpinner, { className: 'hgc-spin' }), 'Harper · starting…']
        })
      })
    })
  }

  if (check.state === 'too-long') {
    return jsx('div', {
      className: 'hgc-strip',
      children: jsx('div', {
        className: 'hgc-row',
        children: jsxs('span', {
          className: 'hgc-count',
          children: [
            jsx(icons.Info, { className: 'hgc-ico' }),
            `Draft is over ${MAX_CHECK_CHARS.toLocaleString()} characters — too long to check.`
          ]
        })
      })
    })
  }

  if (check.state === 'offline' || check.state === 'error') {
    const offline = check.state === 'offline'

    return jsx('div', {
      className: 'hgc-strip',
      children: jsxs('div', {
        className: 'hgc-row',
        children: [
          jsx(offline ? icons.AlertTriangle : icons.Info, { className: 'hgc-ico' }),
          jsx('span', { className: 'hgc-count', children: check.reason || 'Harper unavailable' }),
          jsx('span', { className: 'hgc-spacer' }),
          jsx(Button, {
            variant: 'ghost',
            size: 'micro',
            onClick: () => void engine.recheck(),
            children: 'Retry'
          }),
          jsx(Button, {
            variant: 'ghost',
            size: 'micro',
            title: 'Dismiss',
            onClick: () => $dismissed.set(check.text || 'offline'),
            children: jsx(icons.X, {})
          })
        ]
      })
    })
  }

  const checking = check.state === 'checking'

  // Checking with nothing to show yet: a single quiet row, no layout shift.
  if (checking && !items.length) {
    return jsx('div', {
      className: 'hgc-strip',
      children: jsx('div', {
        className: 'hgc-row',
        children: jsxs('span', {
          className: 'hgc-count',
          children: [jsx(GlyphSpinner, { className: 'hgc-spin' }), 'Checking…']
        })
      })
    })
  }

  if (!items.length) {
    return null
  }

  const onApplyAll = async () => {
    const result = await engine.applyItems(items)

    if (result.applied > 0) {
      host.notify({
        kind: 'success',
        message: `Harper applied ${result.applied} ${result.applied === 1 ? 'correction' : 'corrections'}.`
      })
    } else if (result.reason === 'stale') {
      host.notify({ kind: 'warning', message: 'Draft changed — re-checking before applying.' })
    } else if (result.reason === 'no-surface') {
      host.notify({ kind: 'warning', message: 'No open composer to update.' })
    }
  }

  return jsxs('div', {
    className: 'hgc-strip',
    children: [
      jsxs('div', {
        className: 'hgc-row',
        children: [
          jsx(Button, {
            variant: 'ghost',
            size: 'micro',
            title: expanded ? 'Collapse' : 'Expand',
            onClick: () => $expanded.set(!expanded),
            children: jsx(expanded ? icons.ChevronDown : icons.ChevronRight, {})
          }),
          checking
            ? jsx(GlyphSpinner, { className: 'hgc-spin' })
            : jsx('span', { className: 'hgc-dot', title: 'Suggestions from Harper' }),
          jsx('span', {
            className: 'hgc-count',
            title: check.truncated ? TRUNCATED_HINT : undefined,
            children: countLabel({ count: items.length, truncated: check.truncated, checking })
          }),
          jsx('span', { className: 'hgc-spacer' }),
          items.length > 1
            ? jsx(Button, { variant: 'secondary', size: 'micro', onClick: onApplyAll, children: 'Apply all' })
            : jsx(Button, { variant: 'secondary', size: 'micro', onClick: onApplyAll, children: 'Apply' }),
          jsx(Button, {
            variant: 'ghost',
            size: 'micro',
            title: 'Dismiss until the draft changes',
            onClick: () => $dismissed.set(check.text),
            children: jsx(icons.X, {})
          })
        ]
      }),
      expanded ? jsx(SuggestionList, { suggestions: check.suggestions, engine, ignored, text: check.text }) : null
    ]
  })
}

/** Compact runtime indicator. It carries suggestions only when the composer
 *  action is unavailable or multiple composer surfaces are mounted. */
function StatusChip({ engine }) {
  const check = useValue($check)
  const engineState = useValue($engine)
  const ignored = useValue($ignored)
  const surfaces = useValue($surfaces)
  const settings = useValue($settings)
  const suggestionsOpen = useValue($suggestionsOpen)
  const [open, setOpen] = useState(false)
  const items = visibleItems(check.suggestions, ignored, check.text)
  const fallback = surfaces !== 1
  const showSuggestions = fallback && items.length > 0
  const popoverOpen = showSuggestions ? suggestionsOpen : open
  const issue = ['starting', 'offline', 'error', 'too-long'].includes(check.state)
  const popover = showSuggestions || issue
  const label = check.state === 'starting' ? 'Starting' : check.state === 'offline' || check.state === 'error' ? 'Unavailable' : check.state === 'too-long' ? 'Too long' : showSuggestions ? `${items.length} suggestions` : 'Ready'
  const caption = showSuggestions ? `Harper · ${items.length}` : `Harper · ${label}`

  const trigger = jsx(Button, {
    variant: 'ghost', size: 'micro',
    'aria-label': showSuggestions ? `Harper, ${items.length} suggestions` : `Harper status: ${label}`,
    title: check.truncated ? TRUNCATED_HINT : 'Harper Grammar Coach',
    children: jsxs('span', { className: 'hgc-status', children: [
      jsx(check.state === 'offline' || check.state === 'error' ? icons.AlertTriangle : icons.CircleLetterA, { className: 'hgc-ico' }),
      jsx(Badge, { variant: issue ? 'warn' : 'muted', size: 'xs', children: caption })
    ]})
  })

  if (!popover) return jsx('span', {
    className: 'hgc-status-static',
    children: jsxs('span', { className: 'hgc-status', children: [
      jsx(icons.CircleLetterA, { className: 'hgc-ico' }),
      jsx(Badge, { variant: 'muted', size: 'xs', children: caption })
    ]})
  })

  return jsxs(Popover, {
    open: popoverOpen,
    onOpenChange: next => {
      if (showSuggestions) next ? $suggestionsOpen.set(true) : closeSuggestionsPopover()
      else setOpen(next)
      if (next) void engine.refreshStatus()
    },
    children: [
      jsx(PopoverTrigger, { asChild: true, children: trigger }, 'trigger'),
      jsx(PopoverContent, {
        side: 'top', align: 'end', className: 'hgc-pop',
        children: jsxs('div', { className: 'hgc-pop-body', children: [
          jsxs('div', { className: 'hgc-row', children: [
            jsx('span', { className: 'hgc-h', children: 'Harper Grammar Coach' }),
            jsx('span', { className: 'hgc-spacer' }),
            jsx('span', { className: 'hgc-sub', children: `${engineState.state}${engineState.version ? ` · v${engineState.version}` : ''}` })
          ]}),
          issue ? jsx('div', { className: 'hgc-note', children: check.reason || (check.state === 'too-long' ? 'Draft too long to check.' : 'Harper is recovering.') }) : null,
          issue && check.state !== 'too-long' ? jsx(Button, { variant: 'ghost', size: 'micro', onClick: () => void engine.recheck(), children: 'Retry' }) : null,
          showSuggestions ? jsxs('div', { children: [
            jsx(ApplyAllButton, { items, engine }),
            jsx(SuggestionList, { suggestions: check.suggestions, engine, ignored, text: check.text })
          ]}) : null,
          !showSuggestions && !issue ? jsx('div', { className: 'hgc-note', children: `${settings.live ? 'Live checking enabled' : 'Live checking disabled'}${check.state === 'checking' ? ' · Checking draft…' : ''}` }) : null
        ]})
      }, 'content')
    ]
  })
}
function SettingsPanel({ ctx, engine }) {
  const settings = useValue($settings)
  const engineState = useValue($engine)
  const [busy, setBusy] = useState('')

  useEffect(() => {
    void engine.refreshStatus()
  }, [engine])

  const save = patch => {
    const next = normalizeSettings({ ...settings, ...patch })

    $settings.set(next)
    ctx.storage.set('settings', next)

    if (patch.dialect && patch.dialect !== settings.dialect) {
      void engine.setDialect(next.dialect)
    }

    if (patch.live === false) {
      $check.set(IDLE_CHECK)
    }
  }

  const saveCategories = patch => save({ categories: { ...settings.categories, ...patch } })

  const run = async (label, fn) => {
    setBusy(label)

    try {
      await fn()
    } finally {
      setBusy('')
    }
  }

  const missingBinary = !engineState.binary

  return jsxs('div', {
    className: 'hgc-settings',
    children: [
      jsx(ListRow, {
        title: 'Harper Grammar Coach',
        description:
          'Offline grammar and spelling coaching for the chat composer. Text never leaves this machine — it is checked by a local harper-ls process owned by this plugin.',
        below: jsx('div', {
          className: 'hgc-note',
          children:
            'Applying a suggestion moves the caret to the end of the draft. Live suggestions are advisory while you type. Send-time changes are optional and off by default.'
        })
      }),
      jsx(ToggleRow, {
        checked: settings.live,
        label: 'Check while typing',
        description: 'Checks the draft after a pause. Never edits your draft.',
        onChange: checked => save({ live: checked })
      }),
      jsx(ListRow, {
        title: 'Suggestion display',
        description: 'Choose where Harper suggestions appear.',
        action: jsx(SegmentedControl, {
          options: [
            { id: 'popover', label: 'Composer popover' },
            { id: 'underside', label: 'Underside list' }
          ],
          value: settings.suggestionDisplay,
          onChange: value => save({ suggestionDisplay: value })
        })
      }),
      jsx(ListRow, {
        title: 'Correct on send',
        description: 'Configure this persisted option in the Harper plugin settings gear. It is off by default.'
      }),
      ...CATEGORIES.map(category =>
        jsx(
          ToggleRow,
          {
            checked: Boolean(settings.categories[category.id]),
            label: `Auto-fix ${category.label.toLowerCase()}`,
            description:
              category.id === 'grammar'
                ? 'Off by default: grammar rewrites can change meaning, not just correctness.'
                : 'Applied at send time when confidence is at or above the floor.',
            disabled: !settings.correctOnSend,
            onChange: checked => saveCategories({ [category.id]: checked })
          },
          category.id
        )
      ),
      jsx(ListRow, {
        title: 'Minimum confidence for auto-fix',
        description: 'Live suggestions always show everything; this only gates what gets rewritten on send.',
        action: jsx(SegmentedControl, {
          options: PRIORITIES,
          value: settings.minPriority,
          onChange: value => save({ minPriority: value })
        })
      }),
      jsx(ListRow, {
        title: 'Dialect',
        action: jsx(SegmentedControl, {
          options: DIALECTS,
          value: settings.dialect,
          onChange: value => save({ dialect: value })
        })
      }),
      jsx(ListRow, {
        title: 'Check while typing (debounce)',
        description: 'How long a pause before a check fires.',
        action: jsx(SegmentedControl, {
          options: DEBOUNCES.map(({ id, label }) => ({ id, label })),
          value: settings.debounce,
          onChange: value => save({ debounce: value })
        })
      }),
      jsx(ListRow, {
        title: 'Engine',
        description: missingBinary
          ? engineState.reason || 'harper-ls not found.'
          : `${engineState.state} · v${engineState.version} · ${engineState.dialect} · ${engineState.checks} checks · last ${engineState.lastCheckMs} ms`,
        hint: missingBinary
          ? 'Install the pinned offline release, or put harper-ls on PATH / set HARPER_LS_PATH.'
          : 'Reaped after 10 minutes idle; the next check restarts it.',
        action: jsxs('div', {
          className: 'hgc-row',
          children: [
            missingBinary
              ? jsxs(Button, {
                  variant: 'secondary',
                  size: 'xs',
                  loading: busy === 'install',
                  onClick: () => void run('install', engine.bootstrap),
                  children: [jsx(icons.Download, {}), 'Install Harper']
                })
              : null,
            jsxs(Button, {
              variant: 'ghost',
              size: 'xs',
              loading: busy === 'restart',
              onClick: () => void run('restart', engine.restart),
              children: [jsx(icons.RefreshCw, {}), 'Restart']
            })
          ]
        })
      })
    ]
  })
}

// --- styling -----------------------------------------------------------------

// Disk plugins are not scanned by Tailwind, so every layout rule lives here
// against the app's own custom properties. SDK primitives (Button, Badge,
// Popover) carry their own compiled classes and are used as-is.
const CSS = `
.hgc-strip { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1 1 100%; }
.hgc-row { display: flex; align-items: center; gap: 4px; min-width: 0; }
.hgc-count { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; line-height: 16px; color: var(--ui-text-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.hgc-spacer { flex: 1 1 auto; min-width: 0; }
.hgc-dot { width: 6px; height: 6px; border-radius: 99px; background: var(--ui-accent); flex: 0 0 auto; }
.hgc-ico { width: 12px; height: 12px; flex: 0 0 auto; }
.hgc-spin { flex: 0 0 auto; font-size: 11px; line-height: 14px; color: var(--ui-text-secondary); }
.hgc-list { display: flex; flex-direction: column; gap: 1px; margin-top: 2px; }
.hgc-item { display: flex; align-items: center; gap: 6px; min-width: 0; padding: 1px 2px; border-radius: 3px; }
.hgc-apply-row { flex: 1 1 auto; min-width: 0; justify-content: flex-start; text-align: left; }
.hgc-row-content { display: flex; align-items: center; gap: 6px; width: 100%; min-width: 0; }
.hgc-bad { flex: 0 1 auto; max-width: 34%; font-size: 11px; color: var(--ui-text-secondary); text-decoration: line-through; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hgc-arrow { flex: 0 0 auto; display: inline-flex; color: var(--ui-text-secondary); }
.hgc-good { flex: 0 1 auto; max-width: 34%; font-size: 11px; font-weight: 500; color: var(--ui-text-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hgc-meta { flex: 1 1 auto; min-width: 0; font-size: 10px; color: var(--ui-text-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.hgc-note { display: flex; align-items: center; gap: 6px; font-size: 11px; line-height: 16px; color: var(--ui-text-secondary); padding: 2px 4px; }
.hgc-pop { width: 420px; max-width: 88vw; }
.hgc-pop-body { display: flex; flex-direction: column; gap: 6px; }
.hgc-h { font-size: 12px; font-weight: 600; color: var(--ui-text-primary); white-space: nowrap; }
.hgc-sub { font-size: 11px; color: var(--ui-text-secondary); white-space: nowrap; }
.hgc-status { display: inline-flex; align-items: center; gap: 4px; }
.hgc-status-static { display: inline-flex; align-items: center; }
.hgc-settings { display: flex; flex-direction: column; }
`

// --- plugin ------------------------------------------------------------------

export default {
  id: ID,
  name: 'Harper Grammar Coach',
  description: 'Offline grammar + spelling coaching for the chat composer, with a suggestion popover and optional send-time fixes.',
  // Opt-in: it spawns a subprocess and rewrites text at send time.
  defaultEnabled: false,

  register(ctx) {
    $settings.set(normalizeSettings(ctx.storage.get('settings', null)))
    void configuredCorrectOnSend($settings.get().correctOnSend).then(value => {
      $settings.set(normalizeSettings({ ...$settings.get(), correctOnSend: value }))
    })
    $ignored.set(new Set())
    $expanded.set(false)
    $dismissed.set(null)
    $surfaces.set(0)
    $suggestionsOpen.set(false)
    $autoOpened.set(false)
    $applyingSuggestion.set(false)
    $dismissedSuggestionSet.set(null)
    $check.set(IDLE_CHECK)

    const style = document.createElement('style')

    style.textContent = CSS
    document.head.append(style)
    ctx.onDispose(() => style.remove())

    const engine = createEngine(ctx)

    ctx.onDispose(engine.dispose)
    // Pre-warm the dictionary behind plugin load — never awaited, never blocking
    // registration (the loader has a hard deadline on register()).
    void engine.warm()
    ctx.setInterval(engine.tick, TICK_MS)

    const applyAllFromCurrent = async () => {
      const check = $check.get()

      if (check.state !== 'suggestions') {
        host.notify({ kind: 'info', message: 'No Harper suggestions to apply right now.' })

        return
      }

      const items = visibleItems(check.suggestions, $ignored.get(), check.text)
      const result = await engine.applyItems(items)

      if (result.applied > 0) {
        host.notify({
          kind: 'success',
          message: `Harper applied ${result.applied} ${result.applied === 1 ? 'correction' : 'corrections'}.`
        })
      } else if (result.reason === 'stale') {
        host.notify({ kind: 'warning', message: 'Draft changed — re-checking before applying.' })
      } else if (result.reason === 'empty') {
        host.notify({ kind: 'info', message: 'Nothing left to apply.' })
      } else {
        host.notify({ kind: 'warning', message: 'No open composer to update.' })
      }
    }

    ctx.registerMany([
      {
        id: 'composer-suggestions',
        area: COMPOSER_AREAS.actions,
        order: 40,
        render: () => jsx(ComposerPopover, { engine })
      },
      {
        id: 'strip',
        area: COMPOSER_AREAS.underside,
        order: 40,
        render: () => jsx(ComposerStrip, { engine })
      },
      {
        id: 'status',
        area: STATUSBAR_AREAS.right,
        order: 40,
        render: () => jsx(StatusChip, { engine })
      },
      {
        id: 'settings',
        area: APPEARANCE_AREAS.extra,
        order: 90,
        render: () => jsx(SettingsPanel, { ctx, engine })
      },
      // Submit-time correction. EVERY path returns a draft object: a middleware
      // returning null cancels the send, which is never acceptable here.
      {
        id: 'middleware',
        area: COMPOSER_AREAS.middleware,
        order: 80,
        data: {
          handler: async draft => {
            const configured = await configuredCorrectOnSend($settings.get().correctOnSend)
            const settings = { ...$settings.get(), correctOnSend: configured }

            if (!settings.correctOnSend || !draft || typeof draft.text !== 'string') {
              return draft
            }

            const text = draft.text

            if (text.trim().length < MIN_TEXT_CHARS || text.length > AUTOFIX_MAX_CHARS) {
              return draft
            }

            // A draft holding an @ref or /command would be re-hydrated into chips
            // by setDraft's paste path. No grammar fix is worth that risk.
            if (bearsToken(text)) {
              return draft
            }

            let payload

            try {
              payload = await engine.checkNow(text, AUTOFIX_TIMEOUT_MS, AUTOFIX_BUDGET_MS)
            } catch {
              return draft
            }

            if (!payload || !Array.isArray(payload.suggestions) || !payload.suggestions.length) {
              return draft
            }

            // Reuse the exact draft-scoped dismissal identity shown by the live
            // renderer. A submit-time check must not resurrect an ignored rule.
            const ignored = $ignored.get()
            const picks = pickForAutoFix(payload.suggestions, settings).filter(
              item => !ignored.has(ignoreKey(item, text))
            )

            if (!picks.length) {
              return draft
            }

            const folded = foldReplacements(text, picks)

            if (!folded) {
              return draft
            }

            engine.invalidate()
            log('autofix', { chars: text.length, applied: folded.applied })
            host.notify({
              kind: 'success',
              message: `Harper corrected ${folded.applied} ${folded.applied === 1 ? 'item' : 'items'} before sending.`,
              durationMs: 3500
            })

            return { ...draft, text: folded.text }
          }
        }
      },
      {
        id: 'check-now',
        area: PALETTE_AREA,
        order: 40,
        data: {
          id: 'check-now',
          label: 'Harper: Check draft now',
          icon: icons.Search,
          keywords: ['grammar', 'spelling', 'harper', 'proofread'],
          run: () => void engine.recheck()
        }
      },
      {
        id: 'apply-all',
        area: PALETTE_AREA,
        order: 41,
        data: {
          id: 'harper.applyAll',
          action: 'harper.applyAll',
          label: 'Harper: Apply all suggestions',
          icon: icons.Check,
          keywords: ['grammar', 'spelling', 'harper', 'fix'],
          run: () => void applyAllFromCurrent()
        }
      },
      {
        id: 'open-suggestions',
        area: PALETTE_AREA,
        order: 40,
        data: {
          id: 'harper.openSuggestions',
          action: 'harper.openSuggestions',
          label: 'Harper: Open suggestions',
          icon: icons.Search,
          keywords: ['grammar', 'spelling', 'harper', 'suggestions'],
          run: () => $suggestionsOpen.set(true)
        }
      },
      {
        id: 'open-suggestions',
        area: KEYBINDS_AREA,
        data: {
          id: 'harper.openSuggestions',
          category: 'view',
          defaults: ['mod+alt+h'],
          label: 'Harper: Open suggestions',
          run: () => $suggestionsOpen.set(true)
        }
      },
      {
        id: 'apply-all-keybind',
        area: KEYBINDS_AREA,
        data: {
          id: 'harper.applyAll',
          category: 'view',
          defaults: ['mod+alt+shift+h'],
          label: 'Harper: Apply all suggestions',
          run: () => void applyAllFromCurrent()
        }
      },
      {
        id: 'toggle-live',
        area: PALETTE_AREA,
        order: 42,
        data: {
          id: 'toggle-live',
          label: 'Harper: Toggle live grammar checking',
          icon: icons.Eye,
          keywords: ['grammar', 'spelling', 'harper', 'toggle'],
          detail: () => ($settings.get().live ? 'on' : 'off'),
          detailVariant: 'state',
          run: () => {
            const next = normalizeSettings({ ...$settings.get(), live: !$settings.get().live })

            $settings.set(next)
            ctx.storage.set('settings', next)

            if (!next.live) {
              $check.set(IDLE_CHECK)
            }

            host.notify({
              kind: 'info',
              message: `Harper live checking ${next.live ? 'enabled' : 'disabled'}.`
            })
          }
        }
      }
    ])
  }
}
