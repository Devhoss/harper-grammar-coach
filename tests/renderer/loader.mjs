/** Resolve `@hermes/plugin-sdk` to a test stub.
 *
 *  The renderer half runs inside the Hermes app, whose import map supplies the real SDK. Node
 *  has no such map, and the app's SDK is not a publishable package — so a hook is the only way
 *  to load the REAL `desktop/plugin.js` here. Loading the real module is the point: these tests
 *  must break when the plugin breaks, not when a copy of it drifts.
 */

const STUB = new URL('./sdk-stub.mjs', import.meta.url).href

export async function resolve(specifier, context, nextResolve) {
  if (specifier === '@hermes/plugin-sdk') {
    return { url: STUB, format: 'module', shortCircuit: true }
  }

  return nextResolve(specifier, context)
}
