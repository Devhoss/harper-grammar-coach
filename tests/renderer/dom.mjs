/** A minimal jsdom global scope, installed before react-dom is imported. */

import { JSDOM } from 'jsdom'

const GLOBALS = [
  'window',
  'document',
  'Element',
  'HTMLElement',
  'HTMLDivElement',
  'Node',
  'NodeList',
  'DocumentFragment',
  'Event',
  'MouseEvent',
  'KeyboardEvent',
  'MutationObserver',
  'getComputedStyle',
  'requestAnimationFrame',
  'cancelAnimationFrame'
]

export function installDom() {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    pretendToBeVisual: true,
    url: 'http://localhost/'
  })

  for (const name of GLOBALS) {
    Object.defineProperty(globalThis, name, {
      value: name === 'window' ? dom.window : dom.window[name],
      writable: true,
      configurable: true
    })
  }

  return dom
}
