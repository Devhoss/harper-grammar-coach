/** A stand-in for `@hermes/plugin-sdk`, enough of it to load and render the real plugin module.
 *
 *  The app's SDK is an internal import map, not a package, so this stub is what lets node load
 *  `desktop/plugin.js` unchanged. It reproduces the SHAPE the plugin codes against — `atom` +
 *  `useValue` subscriptions, `host.composer` read/write, a `Button` that really is a button —
 *  and nothing else. Behaviour the tests depend on lives here, so a change to the plugin's SDK
 *  usage shows up as a stub gap rather than a silently skipped assertion.
 */

import { cloneElement, createContext, createElement, useContext, useEffect, useRef, useState } from 'react'

export const PALETTE_AREA = 'palette'
export const KEYBINDS_AREA = 'keybinds'
export const COMPOSER_AREAS = { actions: 'composer-actions', underside: 'composer-underside', middleware: 'composer-middleware' }
export const STATUSBAR_AREAS = { right: 'statusbar-right' }
export const APPEARANCE_AREAS = { extra: 'appearance-extra' }

export function atom(initial) {
  let value = initial
  const listeners = new Set()

  return {
    get: () => value,
    set: next => {
      value = next
      for (const listener of listeners) {
        listener(value)
      }
    },
    subscribe: listener => {
      listeners.add(listener)

      return () => listeners.delete(listener)
    }
  }
}

export function useValue(target) {
  const [value, setValue] = useState(() => target.get())

  useEffect(() => {
    setValue(target.get())

    return target.subscribe(setValue)
  }, [target])

  return value
}

/** The draft the plugin believes it is editing, plus every call it made. */
export const composer = {
  draft: '',
  writes: [],
  focuses: 0,
  notifications: [],
  async getDraft() {
    return composer.draft
  },
  async setDraft(_surface, text) {
    composer.draft = text
    composer.writes.push(text)
    // Hermes' requestComposerSetDraft -> paintDraft path requests focus via a
    // React state update/effect rather than the SDK focus bus.
    composer.focuses += 1
    setTimeout(() => document.dispatchEvent(new window.Event('hgc:composer-focus')), 0)

    return true
  },
  focus() {
    composer.focuses += 1
    // Hermes' composerHost.focus() dispatches through requestComposerFocus,
    // which schedules the actual focus event with setTimeout(0).
    setTimeout(() => document.dispatchEvent(new window.Event('hgc:composer-focus')), 0)
  },
  reset(text) {
    composer.draft = text
    composer.writes = []
    composer.focuses = 0
    composer.notifications = []
  }
}

export const host = {
  composer,
  async request() { return { plugins: [] } },
  notify: message => {
    composer.notifications.push(message)
  }
}

function tag(name) {
  return function Component({ children, ...props }) {
    return createElement(name, props, children)
  }
}

export const Button = tag('button')
export const Badge = tag('span')
export const GlyphSpinner = tag('span')
export const ListRow = tag('div')
export const ToggleRow = tag('div')
export const SegmentedControl = tag('div')

const PopoverContext = createContext({ open: false, onOpenChange() {}, triggerRef: null })
export const popoverAutoFocusLog = []

export function Popover({ children, open = false, onOpenChange = () => {} }) {
  const root = useRef(null)
  const triggerRef = useRef(null)
  const contentHandlers = useRef({})
  useEffect(() => {
    const outside = event => {
      if (open && root.current && !root.current.contains(event.target)) onOpenChange(false)
    }
    document.addEventListener('pointerdown', outside)
    const focusOutside = () => {
      if (!open) return
      const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true } }
      contentHandlers.current.onFocusOutside?.(event)
      if (!event.defaultPrevented) onOpenChange(false)
    }
    document.addEventListener('hgc:composer-focus', focusOutside)
    return () => {
      document.removeEventListener('pointerdown', outside)
      document.removeEventListener('hgc:composer-focus', focusOutside)
    }
  }, [open, onOpenChange])
  return createElement(PopoverContext.Provider, { value: { open, onOpenChange, triggerRef, contentHandlers } }, createElement('div', { 'data-popover': true, ref: root }, children))
}

export function PopoverTrigger({ children }) {
  const { open, onOpenChange, triggerRef } = useContext(PopoverContext)
  return cloneElement(children, {
    ref: node => { triggerRef.current = node },
    'data-popover-trigger': true,
    'aria-haspopup': 'dialog',
    'aria-expanded': String(open),
    onClick: event => {
      children.props.onClick?.(event)
      onOpenChange(!open)
    },
    onKeyDown: event => {
      children.props.onKeyDown?.(event)
      if (event.key === 'Escape' && open) {
        onOpenChange(false)
        event.currentTarget.focus()
      }
    }
  })
}

export function PopoverContent({ children, onOpenAutoFocus, onFocusOutside }) {
  const { open, onOpenChange, triggerRef, contentHandlers } = useContext(PopoverContext)
  contentHandlers.current = { onFocusOutside }
  useEffect(() => {
    if (!open) return
    const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true } }
    onOpenAutoFocus?.(event)
    popoverAutoFocusLog.push(event.defaultPrevented)
  }, [open, onOpenAutoFocus])
  return open ? createElement('div', {
    'data-popover-content': true, role: 'dialog', tabIndex: -1,
    onKeyDown: event => {
      if (event.key === 'Escape') {
        onOpenChange(false)
        triggerRef.current?.focus()
        if (triggerRef.current) triggerRef.current.dispatchEvent(new window.FocusEvent('focus'))
      }
    }
  }, children) : null
}

/** `icons.X` is a component in the app; any name has to work here. */
export const icons = new Proxy(
  {},
  {
    get(_target, prop) {
      if (typeof prop !== 'string') {
        return undefined
      }

      return tag('svg')
    }
  }
)
