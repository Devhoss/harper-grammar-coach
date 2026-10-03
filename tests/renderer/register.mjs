// tests/renderer/register.mjs — install the SDK stub hook before any test module loads.
import { register } from 'node:module'

register('./loader.mjs', import.meta.url)
