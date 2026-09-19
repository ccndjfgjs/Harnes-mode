// @vitest-environment jsdom
// Accessibility presentation sheet: every font/contrast document value owns
// rules that re-point the tokens the UI already reads. jsdom has no layout,
// so these assert the declarations themselves (the live recolor proof runs
// in the browser lane).

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'

let css = ''
let palette = ''

beforeAll(() => {
  // process.cwd, not import.meta asset URLs: Vite rewrites static
  // `new URL('...', import.meta.url)` into dev-server asset references.
  css = readFileSync(join(process.cwd(), 'packages/client/ui-theme/src/styles/a11y.css'), 'utf8')
  palette = readFileSync(join(process.cwd(), 'packages/client/ui-theme/src/styles/design-platform.css'), 'utf8')
})

function declarationsOf(selector: string): string {
  const flat = css.replace(/\/\*[\s\S]*?\*\//g, ' ')
  const start = flat.indexOf(selector)
  if (start === -1) throw new Error(`no \`${selector}\` rule`)
  const open = flat.indexOf('{', start)
  const close = flat.indexOf('}', open)
  return flat.slice(open + 1, close)
}

function has(selector: string, declaration: string): boolean {
  return declarationsOf(selector).includes(declaration)
}

describe('a11y presentation sheet', () => {
  it('switches the interface typeface per font choice', () => {
    expect(has(":root[data-dsh-a11y-font='mono'] body", '--dsw-font-family')).toBe(true)
    expect(has(":root[data-dsh-a11y-font='mono'] body", 'Consolas')).toBe(true)
    expect(has(":root[data-dsh-a11y-font='mono'] body", '--dsw-font-mono')).toBe(true)
    expect(has(":root[data-dsh-a11y-font='atkinson'] body", "'Atkinson Hyperlegible'")).toBe(true)
  })

  it('renders black-and-white in both color schemes', () => {
    for (const scheme of [
      ":root[data-dsh-a11y-contrast='bw'] body:not([data-ds-dark-theme])",
      ":root[data-dsh-a11y-contrast='bw'] body[data-ds-dark-theme]",
    ]) {
      expect(has(scheme, '--dsw-alias-bg-base')).toBe(true)
      expect(has(scheme, '--dsw-alias-label-primary')).toBe(true)
    }
    expect(has(":root[data-dsh-a11y-contrast='bw'] body:not([data-ds-dark-theme])", '#ffffff')).toBe(true)
    expect(has(":root[data-dsh-a11y-contrast='bw'] body[data-ds-dark-theme]", '#000000')).toBe(true)
  })

  it('forces the yellow-on-black scheme with matching native chrome', () => {
    expect(has(":root[data-dsh-a11y-contrast='yellow']", 'color-scheme: dark')).toBe(true)
    expect(has(":root[data-dsh-a11y-contrast='yellow'] body", '#ffff00')).toBe(true)
    expect(has(":root[data-dsh-a11y-contrast='yellow'] body", '--dsw-alias-bg-base: #000000')).toBe(true)
  })

  it('remaps only state tokens for color-blind friendliness', () => {
    const selector = ":root[data-dsh-a11y-contrast='daltonism'] body"
    expect(has(selector, '--dsw-alias-state-error-primary: #d55e00')).toBe(true)
    expect(has(selector, '--dsw-alias-state-success-primary: #009e73')).toBe(true)
    expect(has(selector, '--dsw-alias-state-warn-primary: #e69f00')).toBe(true)
    expect(has(selector, '--dsw-alias-bg-base')).toBe(false)
  })

  // The surface a settings card paints is --dsw-specific-input-major, which
  // is an alias of --dsw-alias-bg-layer-3. A theme that leaves layer-3 at its
  // default white puts white cards on a black canvas with yellow-on-white
  // headings: the exact unreadable state this sheet exists to prevent.
  it('repaints the card surface, not just the canvas, in every contrast theme', () => {
    const themes = [
      ":root[data-dsh-a11y-contrast='bw'] body:not([data-ds-dark-theme])",
      ":root[data-dsh-a11y-contrast='bw'] body[data-ds-dark-theme]",
      ":root[data-dsh-a11y-contrast='yellow'] body",
    ]
    for (const theme of themes) {
      expect(has(theme, '--dsw-alias-bg-layer-3')).toBe(true)
      expect(has(theme, '--dsw-alias-bg-selector')).toBe(true)
      // Text is painted on the surface, so the two must disagree.
      expect(has(theme, '--dsw-alias-label-primary')).toBe(true)
    }
  })

  // Every declaration the palette gives one selector, across its repeated
  // light/dark blocks (the sheet states each scheme in two places).
  function paletteDeclarations(selector: string): Map<string, string> {
    const flat = palette.replace(/\/\*[\s\S]*?\*\//g, ' ')
    const pattern = new RegExp(`${selector.replace(/[[\]()]/g, '\\$&')}\\s*\\{([\\s\\S]*?)\\n\\}`, 'g')
    const found = new Map<string, string>()
    for (const match of flat.matchAll(pattern)) {
      for (const declaration of (match[1] ?? '').matchAll(/(--dsw-[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
        found.set(declaration[1] ?? '', (declaration[2] ?? '').trim())
      }
    }
    return found
  }

  // `bw` follows the active scheme, so the base palette already supplies every
  // token it leaves alone. `yellow` does not: it forces the black scheme onto a
  // body that may still be carrying the light palette, so any alias it omits
  // keeps its light value. That is the same unreadable state as above, reached
  // through a different token — a white stepper pill, a white "new session"
  // button, a white scrollbar, hover washes that vanish on black. Restating
  // every scheme-dependent alias is what makes the forced black scheme real.
  it('restates every scheme-dependent alias the forced black scheme needs', () => {
    const light = paletteDeclarations('body')
    const dark = paletteDeclarations('body[data-ds-dark-theme]')
    const repainted = [...light]
      .filter(([token, value]) => !token.startsWith('--dsw-static-')
        && dark.has(token)
        && dark.get(token) !== value)
      .map(([token]) => token)
    expect(repainted.length).toBeGreaterThan(40)
    const overridden = new Set(
      [...declarationsOf(":root[data-dsh-a11y-contrast='yellow'] body").matchAll(/(--dsw-[a-z0-9-]+)\s*:/g)]
        .map(match => match[1] ?? ''),
    )
    expect(repainted.filter(token => !overridden.has(token))).toEqual([])
  })

  // A component token wired straight to the raw palette is unreachable from
  // this sheet: the themes re-point aliases and nothing else. Every `specific`
  // token must therefore resolve to an alias, so the fix cannot silently
  // regress the next time the palette is edited.
  it('keeps every component token on the alias layer so themes can reach it', () => {
    const leaks: string[] = []
    for (const match of palette.matchAll(/--(dsw-specific-[a-z0-9-]+)\s*:\s*var\(--(dsw-[a-z0-9-]+)\)/g)) {
      const token = match[1] ?? ''
      const ref = match[2] ?? ''
      if (ref.startsWith('dsw-static-')) leaks.push(`${token} -> ${ref}`)
    }
    // Sidebar chrome is the documented exception: the sidebar keeps its own
    // fill under every theme, so its tokens deliberately stay on the palette.
    const allowed = new Set([
      'dsw-specific-sidebar-fill',
      'dsw-specific-sidebar-nav-item-active',
      'dsw-specific-sidebar-nav-item-active-accent',
      'dsw-specific-sidebar-nav-item-hover',
    ])
    const unexpected = leaks.filter(leak => !allowed.has(leak.split(' -> ')[0] ?? ''))
    expect(unexpected).toEqual([])
  })

  // A theme that names a token the palette never defines is a silent no-op:
  // the declaration parses, the theme looks complete, and nothing recolors.
  it('overrides only tokens the palette actually defines', () => {
    const defined = new Set(
      [...palette.matchAll(/--(dsw-[a-z0-9-]+)\s*:/g)].map(match => match[1] ?? ''),
    )
    for (const [, body] of css.matchAll(/:root\[data-dsh-a11y-contrast='[a-z]+'\][^{]*\{([\s\S]*?)\n\}/g)) {
      const named = [...(body ?? '').matchAll(/--(dsw-[a-z0-9-]+)\s*:/g)].map(match => match[1] ?? '')
      expect(named.filter(token => !defined.has(token))).toEqual([])
    }
  })
})
