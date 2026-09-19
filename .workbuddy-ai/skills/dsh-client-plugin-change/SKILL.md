---
name: dsh-client-plugin-change
description: Verify and ship a change to a client UI plugin in the DeepSeek Harness monorepo (packages/client/*), including changes that add a Host Remote command the composer calls. Use when editing React/CSS/TS under packages/client/ and you need to confirm the change is correct AND actually visible in the running app. Covers the focused check order (tsc → oxlint → vitest → theme contracts → jscpd), the client-bundle rebuild that makes changes appear, and the sandbox-direct commands to use when `pnpm` is unavailable.
agent_created: true
---

# Changing a client plugin in DeepSeek Harness

Client UI is one Cordis plugin per surface under `packages/client/*`. Two facts
drive everything below:

- **Changes are invisible until the client bundle is rebuilt.** CSS *and* TS are
  compiled into `lib/client.js` at build time (`packages/client/tsdown.client.ts`).
- **CSS/theme contracts are enforced by tests that scan CSS on disk** across all
  of `packages/` (not just the package you edited).

## When `pnpm` does not work (this sandbox)

`pnpm` is unusable here (`wmic.exe` is blacklisted), and `scripts/run-gates.ts`
refuses to start without `npm_execpath`. Invoke the tools directly instead:

```sh
NODE=C:/Users/Dedy_Sher/.workbuddy-ai/binaries/node/versions/22.22.2-2/node.exe

# types (per package, or the whole aggregate)
$NODE node_modules/typescript/bin/tsc -b packages/client/<pkg>/tsconfig.json
$NODE node_modules/typescript/bin/tsc -b tsconfig.client.json   # all client TESTS
$NODE node_modules/typescript/bin/tsc -b tsconfig.host.json     # all host TESTS

# tests
$NODE node_modules/vitest/vitest.mjs run packages/client/<pkg>/tests

# one gate, run as a script (the aggregate needs pnpm)
$NODE --import tsx/esm scripts/verify-client-ui-i18n.ts

# bundle a package
cd packages/client/<pkg> && $NODE ../../../node_modules/tsdown/dist/run.mjs
```

Coverage for one host file, without running the whole workspace:

```sh
$NODE node_modules/vitest/vitest.mjs run <spec> \
  --coverage --coverage.include='packages/<group>/<pkg>/src/<file>.ts' --coverage.reporter=text
```

Per-file 100% is the CI gate, but `vitest.config.ts` exempts the GUI-debt paths —
check the `coverage.exclude` list before assuming a client file needs coverage.
`packages/*/*/src/types.ts` is always excluded, so new request/value interfaces
never need a test of their own.

## Check order (cheapest first, focused over exhaustive)

Run only what your change touches — CI owns the full matrix.

1. **Types, one package at a time** (whole-repo `typecheck` is slow and can be
   blocked by unrelated broken packages).
2. **Lint only your files** (full lint also runs `build:lib:host`, ~90s):
   ```sh
   $NODE --import tsx/esm scripts/run-oxlint.ts <changed files…>
   ```
   Watch for `no-unsafe-return` on untyped `vi.fn()` mocks — type the mock:
   `vi.fn((_arg: RealType) => {})`. Also `@stylistic(eol-last)` requires a
   trailing newline; file-writing tools can drop it.
   **`no-unnecessary-condition` on a mounted-guard flag:** writing the fetch in a
   `useEffect` as `void (async () => { … if (!live) return … })()` makes TypeScript
   narrow `live` to the literal `true` (the IIFE is immediately invoked, so CFA
   analyses its body inline) and the guard is reported as dead code — meaning the
   guard you think protects against setting state after unmount is not there.
   Use the project idiom instead — a promise chain whose callbacks TS cannot
   analyse: `void Promise.all([...]).then(([...]) => { if (!live) return … },
   (error: unknown) => { if (live) … })`, with `return () => { live = false }`.
   See `ui-attachment/src/MessageImage.tsx` and
   `ui-conversation/src/client/queue/QueueDock.tsx`.
3. **Tests, focused** on the package you edited.
4. **Theme/CSS contracts** whenever you touch CSS or component styles:
   `$NODE node_modules/vitest/vitest.mjs run packages/client/ui-theme`
5. **Clone detection** (runs over `packages` + `scripts`): `pnpm run duplication`.
6. **Rebuild the bundles that make it visible** — see below.

## Sweeping every gate (and whose red is whose)

The project rule says a new feature is not done until its integration is
*verified*, not just written. When the user asks for a sweep, run every gate
that can run here — not a focused subset. All are leaf scripts, so `pnpm` is
not needed:

```sh
for s in verify-client-ui-i18n verify-client-packages verify-doc-budgets \
         verify-md-links verify-md-wrap verify-doc-refs verify-package-paths \
         verify-client-domain-graph; do
  $NODE --import tsx/esm "scripts/$s.ts"
done
$NODE node_modules/vitest/vitest.mjs run scripts/doc-standard.spec.ts
```

`verify-client-ui-i18n` (543 files), `verify-client-packages` (50 packages),
`verify-doc-budgets` (8 docs), `verify-md-links` (2248), `verify-md-wrap`
(2256), `verify-doc-refs` (2477), `verify-package-paths` (4700) and
`doc-standard.spec.ts` (12) were all green on 14.09.2026.

For a **full audit**, add the checks that are not repository gates:

```sh
# This is a pnpm workspace: npm audit answers ENOLOCK and is the wrong tool.
pnpm audit --prod --json > .artifacts/pnpm-audit.json

# Electron tests do not need the pnpm wrapper; direct Node avoids the sandbox's
# blocked `wmic.exe` dependency-status probe.
$NODE --test electron/tests/*.test.js

# Standalone Python launchers.
$PYTHON -m py_compile launcher_gui.py simple_harness.py example_run.py
```

⚠️ `pnpm audit` may print nothing useful when its report is piped to `tail`.
Save JSON first, then inspect `metadata.vulnerabilities` and `advisories`.
On 14.09.2026 the production graph contained 38 advisories (18 high, 19
moderate, 1 low, 0 critical). `npm audit` incorrectly reported `ENOLOCK`
because this repository intentionally has no `package-lock.json`.

`pnpm duplication` is **not runnable in this sandbox**: pnpm's dependency
status check calls the blacklisted Windows program `wmic.exe`. Do not retry,
do not bypass the blacklist; report the check as unavailable.

**Known red, not yours** (state of the fork, 14.09.2026):
`verify-package-readme-limitations` and `verify-package-readme-model-experience`
(the 8 custom packages — `ui-settings-about/accessibility/accounts/
customization/network/screen/voice` and `host/media-gateway` — ship no
DSH-format `README.md`), and `verify-translation-pairing` (`workspace/README.md`
and `Документация/README.md` have no bilingual counterpart). Confirm with the
history trick below before believing a red is pre-existing.

### `doc-standard.spec.ts`: the `default` export regex has no word boundaries

The "audited library registry" check flags an entry that looks like a plugin:

```ts
not.toMatch(/export (?:default\b|\{[^}]*\bdefault\b[^}]*\} from)/u)
```

⚠️ As originally written it was `[^}]*default[^}]*` — no `\b` — so **any export
whose name merely starts with `default` trips it** (`defaultVoiceOf`,
`defaultsFor`). The failure reads `entry must be a plain module, not a plugin`,
which sends you hunting for a `default` export that does not exist. If you hit
it, the fix belongs in the regex (the `\b` version still catches `export
default` and `export { x as default } from`), not in a rename of your export.

### `verify-client-domain-graph` — read it before you trust it

It enforces intra-package layering inside `packages/client/<pkg>/src/client/`:
domains may import `contract/` and top-level shared files, never each other,
and only `apply.ts`/`index.ts` assemble. **A top-level file that imports a
domain is also a violation**, and `contract/` may hold declarations only — a
re-export of a domain trips it too.

Two traps:

- **It is only in `check-all`** (`scripts/run-gates.ts:263`), not in the
  ordinary CI group. It can stay red for a long time unnoticed. On 14.09.2026
  it reported **7 violations**, 3 of which were already in `HEAD`.
- **Never assume a red gate is your fault, and never assume it is not.**
  Settle it by running the *same* check against the version in history, in a
  scratch directory — no `git stash`, no `git worktree`, working files
  untouched:

  ```sh
  git archive HEAD packages/client | tar -x -C "$TMPDIR/dsh-head-check"
  ```

  The gate imports only `node:fs`/`node:path`, so a copy of its logic runs
  against that tree with any node binary. HEAD gave 3, the working tree 7 —
  the extra 4 came from uncommitted work, the base 3 from history.

New host or client files that carry a *shared service* for two domains should
go to the **top level** of `src/client/` (as `service.ts`, `stores.ts`,
`context-occupancy.ts` already do), not into a domain directory — that is the
placement the gate accepts.

## Rebuilding so the user actually sees it

```sh
$NODE node_modules/tsdown/dist/run.mjs --env.DSH_BUILD_FACE client
```

Rebuilds every client bundle in ~15s and does **not** need a successful `tsc`
run, as long as `lib/types/` is already emitted. Prefer it over
`build:lib:client`, which chains `tsc -b tsconfig.client.json` first and
therefore fails whenever any unrelated package has a type error.

- Per-package: run `tsdown` from the package directory. With no
  `DSH_BUILD_FACE`, the package config emits **both** halves (node + client).
- **`ui-primitives` is a `staticLinked` package**: it has **no `scripts` section**
  and emits `lib/index.js` (not `lib/client.js`). It can only be built by the
  root tsdown run.

### Rebuilding the page itself (`apps/web/dist`)

The client bundles above are served **by** the page; a new plugin also needs the
page rebuilt, or the server advertises a bundle the shell has no reference to.

```sh
cd apps/web && $NODE node_modules/vite/bin/vite.js build --emptyOutDir
```

Do **not** pass `--outDir`: `emit-preview-page` in `apps/web/vite.config.ts`
reads and writes `<apps/web>/dist` **by hard-coded path**, so any other output
directory builds the app without `preview.html` (128 files instead of 129). A
relative `--outDir dist-new` resolves against the **vite config dir**, not your
shell's cwd, so you can also silently land a nested `apps/web/dist/dist/`.

Check the result by its shape, not by the exit code: `ls apps/web/dist/` must
show `assets/ favicon.svg index.html manifest.webmanifest preview/ preview.html`
and **no** `dist*` subdirectory.

Do not hand-move `dist` around to work around this — `mv dist dist-old && … &&
rm -rf dist-old` returns a misleading "cannot stat" and can leave the old tree
nested inside the new one. Build in place with `--emptyOutDir`.

### Verify the change really landed in the bundle

Never assume the build picked it up — grep the artifact for a marker string:

```sh
grep -c "someNewIdentifier" packages/client/<pkg>/lib/client.js
```

### A NEW package needs three things the four registration edits do not cover

Registering in `bundle/web-app/package.json`, `cordis.patch.yml`,
`tsconfig.client.json` and `tsconfig.base.json` is **not enough**. With `pnpm`
unavailable the new workspace package is never linked, and both of these fail
**only at app startup** — `tsc` and vitest stay green throughout:

1. **`Cannot find package '@deepseek-ai/dsh-client-<name>'`** (ERR_MODULE_NOT_FOUND
   from `~/.dsh/profiles/<profile>/`). The profile resolves a bundle's plugins
   through the **bundle's own** `node_modules`:
   `healProfileModuleFallback` → `dependencyClosure` walks
   `packages/bundle/<bundle>/package.json`. Create the link yourself:
   `packages/bundle/<bundle>/node_modules/@deepseek-ai/<name>` → the package dir.
   On this Windows host bash `ln -sfn` silently produces an empty directory —
   use the PowerShell tool with `New-Item -ItemType Junction`. Do this **after**
   editing the bundle's `package.json`, or the link resolves nothing.

2. **`atomic-write: timed out waiting for the writer lock at
   ~/.dsh/profiles/node_modules.lock`** — the whole app refuses to boot. The lock
   holds the PID of a process that already died. `packages/util/atomic-write`
   states the policy outright: *"file age cannot prove that its owner stopped;
   orphan recovery is an operator action"* — the code never removes it. Confirm
   the PID is gone (`tasklist`) and clear the file. Editing a bundle's
   dependencies is what makes the fallback snapshot stale and triggers the heal
   in the first place, so expect this trap on exactly this kind of change.

### Proving a new section reaches the running app

Grep of `lib/client.js` proves the build; it does not prove the app loads it.
Boot the server and ask it:

```sh
$NODE apps/cli/lib/bin.js web --port <free> --no-open   # line 1 prints ?token=…
```

Then, with `node:http` only (the sandbox proxies loopback):
`GET /?token=…` → `303` + `set-cookie`; `GET /` with the cookie; the HTML
contains the package name, a `/plugins/??…,<pkg>/client.js,…` combined URL, and
the `__DSH_BOOT__` record `{"id":"@deepseek-ai/dsh-client-<pkg>","url":…}`.
Fetch that URL → expect `200` with a non-empty body.

**Always include a negative control** — the same path with an invented package
name must return `404`; otherwise the `200` proves nothing. And search for
locale strings **as they actually appear** in `locales.ts` (a section's `nav`
label may be `Сеть`, not «Настройки сети») — inventing the string yields a false
negative.

## Adding a Host Remote command the composer calls

The composer has no `ctx`; it reaches the Host through `InputActions`
(`ui-conversation/src/client/contract/input.ts`) → the shell
(`input/facade.ts`, which owns a session-scope `actx`) → `ctx.remote.<ns>.<method>`.

1. **Host types** in the owning package's `src/types.ts` (excluded from coverage).
2. **Host implementation** in a new `src/<feature>.ts` module. Take `Context`;
   read `ctx.agentDefaultModel.currentSelection()` for the configured model and
   stream through `ctx.llm.stream(options)`, assembling with `BlockAssembler`.
   Do **not** set `GenerateOptions.purpose` — the union is closed to
   `'compaction' | 'session-title'`; an unset purpose is an ordinary call, which
   is what an auxiliary request is. Build the user message with
   `createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'plugin', plugin: '<id>' } })`.
   `RemoteError` details are a closed map: `gateway/bad-request` accepts only
   `{ issues?: readonly object[] }`, `gateway/internal` and `gateway/cancelled`
   accept `{}` — put the bound or reason in the **message**, not in details.
3. **Register it** on the existing `TypertRemoteService` subclass in
   `src/index.ts` with `@Remote('<name>')`. Return `signal.throwIfAborted()`
   first when the caller may cancel.
4. **Register the file in `tsconfig.host.json`** — that config lists `files`
   explicitly and does **not** use `include`. A new host module missing from
   that list silently never compiles. (`tsconfig.client.json` uses `include`.)
5. **Regenerate the Typert artifacts.** The generator runs as a plugin of the
   **root** `tsdown.config.ts` in `mode: 'workspace'`; a per-package `tsdown`
   run does **not** emit them, so `lib/typert.remote-client.d.ts` silently keeps
   the old method list and the client cannot see the command. Either run the
   root tsdown, or drive the generator directly:
   ```js
   const g = new WorkspaceTypertGenerator(process.cwd(), { checkDiagnostics: false })
   for (const a of g.generate(['@deepseek-ai/dsh-<pkg>'], ['host'])) {
     // write a.js/a.dts as lib/typert.<face>.js/.d.ts, and a.remote as
     // lib/typert.remote-client.js/.d.ts/.d.ts.map
   }
   ```
   Then confirm: `grep -c <method> packages/<group>/<pkg>/lib/typert.remote-client.d.ts`.
   Order matters: `tsc -b` first (it emits `lib/types`), then tsdown.
6. **Client contract**: add the member to `InputActions`. The Remote method
   resolves to `RemoteResult<T>` (`{ok:true,value} | {ok:false,error}`) — unwrap
   it in the shell and throw `new Error(result.error.message)` on the error
   branch.
7. **Client UI**: the control lives in `MediaToolbar.tsx` (the toolbar beside
   mic/call/screen). It needs the draft, so add a `draft: string` prop and pass
   `draft={draft}` from `InputBar.tsx` (which already reads `useInput`).
8. **Locales**: add the label, the busy label, and the failure notice to all
   three dictionaries in `ui-conversation/src/client/locales.ts`.

### The contract-change ripple (budget for it)

Extending `InputActions` (or any slot-props interface) breaks **every test fake**
that builds the object literally — typically ~16 sites across
`ui-attachment`, `ui-chat` (×2), `ui-tool` (×5), `ui-trajectory`,
`ui-user-questions` (×2), `ui-workflow-run`, plus
`api/session-controller/tests/fake-api.client.ts` for a new Remote namespace
method. Find them all with:

```sh
grep -rn "pruneImages\|InputActions" --include=*.ts --include=*.tsx packages/client
```

Then run `tsc -b tsconfig.client.json` — it is the only check that sees test
files, so a green per-package typecheck proves nothing about them.

### An auxiliary model call: read the answer WHOLE, and surface the reason

If the host command you add calls the model (`ctx.llm.stream`), two things are
mandatory and both were missing from `draft-restructure.ts` until 14.09.2026 —
it shipped, rendered, and failed in the user's app with nothing to act on.

**1. Check `assembler.finish` after the loop, before reading blocks.** A
provider failure can arrive as the *terminal finish chunk* rather than a throw.
Reading only `blocks()` turns "insufficient balance" into "no text" and buries
the real cause:

```ts
const finish = assembler.finish
if (finish.kind === 'error' || finish.kind === 'aborted') {
  throw new RemoteError('gateway/internal', `... failed: ${finish.failure.message}`, {})
}
if (finish.kind === 'max-tokens') {
  throw new RemoteError('gateway/internal', '... reached its token cap before producing text', {})
}
```

`assembler.finish` defaults to `{ kind: 'stop' }` when no finish chunk arrives.
Two working call sites do exactly this with a local `finishError` helper:
`session/session-title-llm/src/index.ts` and
`compaction/compaction-basic/src/summarizer.ts`. Write yours inline — a third
copy of the helper would trip `jscpd` (`minTokens: 60`); an inline variant does
not (verified: 0 clones).

**2. Do not swallow the error on the client.** `MediaToolbar.tsx` already
establishes the pattern for the voice controls —
`setNotice(error instanceof Error ? error.message : String(error))`. A bare
`catch { setNotice(t('...failed')) }` shows a translated line that names no
cause: the user cannot tell a missing API key from a network fault. Keep the
localized lead-in and append the reason.

Neither problem is caught by tests that only script a happy path, and neither is
visible in the host log — the Electron launcher prints backend stderr to its own
console and writes no file. The error has to reach the UI to be diagnosable.

### Letting the user choose WHICH model an auxiliary call uses

The pattern (built for the composer's «Улучшить текст» button, 17.09.2026): give
the call its **own** settings namespace on the host, and read it as layer one
over the Agent default.

1. **A new host settings owner**, not a second reader of `agent-default-model`.
   `packages/core/draft-restructure-model/` is the template: a `Service`
   declaring `static Config`, calling
   `ctx.settings.installSection(ctx, NS, SCHEMA, entry, { setSource, validate,
   onChange })` inside `ctx.inject(['settings'], …)`. The read accessor is called
   **at call time**, so a settings edit takes effect with no restart and no
   registration rebuild — do not cache it at load.
2. **Read it through `ctx.get('<service>')?.…`**, not `this.ctx.<service>`. The
   call must still work in a composition that never mounted the settings plugin.
3. **Give the service an `import type {} from '<pkg>'` in the consumer.** Without
   it the `ctx.get()` read is `any`, and oxlint's `no-unsafe-*` rules go red while
   `tsc` stays green — and the argument the route helper expects is lost.
4. **A pair is validated as a pair.** Declaring `installSection(…, { validate })`
   and rejecting a half-written `{ provider }` with no `model` is deliberate: a
   provider swap leaves the previous model id behind, and that pair addresses a
   route that does not exist. A silent fallback would hide a form bug behind
   working behaviour. (Refusing is also what makes the form clear the model on a
   provider change.)
5. **Check routability before binding the route.** A provider can leave the
   composition between the write and the call; falling back to the Agent default
   beats failing deep in the stream with "unknown provider", which names nothing
   the user can act on. `draftRestructureRoute` in
   `api/session-controller/src/draft-restructure.ts` is the pure, testable shape —
   keep the decision in a pure function so it needs no live Context to test.
6. **A blank pair is the "not configured" state**, so the call must fall back.
   Page-side, write both halves explicitly on clear (`{ op: 'set', path: ['provider'],
   value: '' }`) rather than unsetting — an unset leaves the previous value.

**Do not duplicate the provider form on the new page.** The Models page and this
page already read one registry (`session/modelCatalog`) and write the same
namespaces (`llm-deepseek` / `llm-pi-ai`), so a provider added on the Models page
appears here automatically. A second form would let the two pages disagree about
what a provider *is*; reuse the data seam rather than copying the UI.

### Verify the Remote command end to end, with no browser and no app window

Unit tests prove the handler; this proves the wiring — that the command is
registered, dispatched, descriptor-validated, and actually reaches the model.
Boot the real web profile and call the command over its own HTTP channel:

```sh
$NODE apps/cli/lib/bin.js web --port 7391 --no-open   # background
# stdout line 1: dsh web: http://127.0.0.1:7391/?token=…
# GET that URL with the token -> 303 + set-cookie (that IS the sign-in)
```

Then POST, exactly as the page does:

```
POST http://127.0.0.1:7391/api/<namespace>/<command>
content-type: application/json
cookie: <from the set-cookie above>

{"type":"client-request","rpcId":"<uuid>","method":"<namespace>/<command>",
 "payload":{"args":{"request":{ …the method's arguments… }}}}
```

Response: `{"type":"server-response","rpcId":…,"result":{"ok":true,"value":…}}`
or `{"ok":false,"error":{"code":…,"message":…,"details":{}}}`.

**The `payload` shape is the only trap** — it is `args`, keyed by the method's
*parameter name* (`request` for `restructureDraft(request, signal)`), and the
`signal` never rides in the body. Guessing it produces two instructive errors
in a row: `Remote payload must contain exactly one plain-object args field`,
then `args fields do not match the descriptor: missing "request"`.

Protocol source of truth: `client/connection/src/client/rpc.ts` (POST to
`<origin><channel>/<endpoint>`), `api-path.ts` (`/api`), `browser-auth.ts`
(root-URL token → cookie). **Use `node:http`, not `fetch`** — the sandbox
exports `HTTP_PROXY`/`HTTPS_PROXY`, which sends loopback fetches through the
proxy. Kill the server afterwards and confirm the port is free.

### When a model call fails, read the app's OWN logs — not just your code

The user's app records everything it does, and it is the only witness to *why* a
call failed. It is also where the provider's verbatim reason lives (retry
policy, HTTP status, rate-limit headers, reset timestamp).

`~/.dsh/sessions/<encoded-workdir>/<session-id>/session.jsonl.zstd`

**Trap: the file is MANY concatenated zstd frames, one per event, and
`zlib.zstdDecompressSync(wholeFile)` silently returns only the FIRST frame.**
The first frame is the ~200-byte `session` header, so a 688-event session looks
like "1 event — the user never sent anything". I drew exactly that wrong
conclusion once. Decode frame by frame: collect every `28 B5 2F FD` offset, then
from the current position try decompressing up to the next boundary; the first
success ends the frame — continue from there.

Event types worth filtering for:

| type | what it gives you |
| --- | --- |
| `user/message` | what the user actually typed (real text, not a paraphrase) |
| `assistant/message` | the model's answer, **which provider/model produced it**, token usage |
| `model/selection` | every model switch the user made — shows a model-hopping loop |
| `llm/retry` | **the jackpot**: the provider's verbatim failure, `code` (`RATE_LIMIT`, `TRANSPORT`, …), attempt number, delay, and the retry `policyKey` |

A `RATE_LIMIT` entry carries the provider's own remedy hint and
`X-RateLimit-*` headers — quote those to the user instead of guessing.

**Do not judge a key by probing it from the sandbox.** A direct request with the
key stored in `~/.dsh/.credentials.yaml` returned `401 User not found`, while the
app was successfully getting answers with that same key minutes earlier — and a
deliberately garbage key returns the identical error, so the probe proves
nothing. The sandbox appears to substitute `Authorization` for well-known
providers. (`~/.dsh/.credentials.yaml` also holds secret **values** in the clear:
read it, never echo it.)

### "It works for me, not for the user" — check your egress FIRST

The sandbox exits the internet through **Warsaw, Poland**; the app on this machine
connects directly from Russia. So geo-restrictions hit the user and not you, and
network verdicts drawn from the sandbox are worthless without this check:

```sh
$NODE -e "fetch('https://ipinfo.io/json').then(r=>r.text()).then(console.log)"
```

Worked example: Google returned the user `400 User location is not supported for
the API use` (`FAILED_PRECONDITION`) while the very same `gemini-3.6-flash`
request from the sandbox returned `200` and answered. The key and the model were
fine — only the route differed. The app's *own* log carried the verbatim Google
error inside `turn/end`, which no amount of local probing would have produced.

### The launcher's V2Ray tunnel (fixed 14.09.2026)

It used to open a **SOCKS5** inbound only and hand the backend
`socks5://127.0.0.1:<port>` via `ALL_PROXY`/`HTTP_PROXY`/`HTTPS_PROXY`. The
harness refuses SOCKS outright — `packages/util/http-proxy/src/policy.ts` has
`SUPPORTED_PROTOCOLS = { http:, https: }`, and `acceptProxyUrl` returns
`{ kind: 'rejected' }` with "names a SOCKS proxy, which is not supported;
connecting directly for that scheme". Net effect was: the tunnel up, the browser
using it, **model requests bypassing it**.

Now the generated config carries **two inbounds** (`socks` 10808 + `http` 10809)
and `proxyEnv()` exports `http://127.0.0.1:<httpPort>`. Keep both: the browser
button wants SOCKS, the harness only speaks HTTP. Colliding ports fail loudly
rather than silently. `v2ray.exe` is **not in the repo**, so the tunnel cannot be
exercised locally — verify config generation, not traffic.

### Test the launcher window's wiring with jsdom, not by reading it

`electron/port-selector.html` is a classic page whose `<script>` runs at the end
of the body — there is no module boundary and no component test. A dead button
there looks perfect and does nothing, and `new Script(code)` only proves it
parses. Drive it for real:

```js
const { JSDOM } = require('jsdom')            // root devDependency, resolves from electron/tests/
const dom = new JSDOM(readFileSync(html, 'utf8'), {
  runScripts: 'dangerously',
  beforeParse(window) { window.harnessAPI = fakeBridge },   // must be installed BEFORE parsing
})
await settle()                                 // the page kicks off async loads; drain a few ticks
```

- The bridge must expose **every** method the page touches at load
  (`onReady`, `onFullscreenChanged`, `onMaximizeChanged`, `onLaunchProgress`,
  `onLaunchError`, `getAppIcon`, `checkPort`, …), or the script throws mid-load.
- Keep a fake document in the test and let the fake handlers mutate it — that is
  what proves the launcher and the settings page edit **one** document.
- Assert the positive path *and* a negative control (an empty paste must NOT
  reach the shell), then confirm the test has teeth by deleting the
  `addEventListener` line in a **copy** of the HTML and re-running: the positive
  assertion must fail. A wiring test that cannot fail is decoration.
- Files under `electron/tests/*.test.js` run with `node --test` and are already
  picked up by `test:launcher`; oxlint ignores `electron/` entirely.

## Bundle-purity gate (a build error, not a warning)

`dsh-client-bundle-purity` rejects any `@deepseek-ai/*` **value** import from a
client bundle unless the specifier is:

- in the package's `dsh.client.external`, or
- in the baseline `PLATFORM_MODULES` / `PRELOADED_CLIENT_EXTERNALS`
  (`packages/client/web/src/platform.ts`), or
- an inline-safe wire layer (`INLINE_SAFE` in `tsdown.client.ts`) or a generated
  `/remote` contribution.

Type-only imports are erased and never reach the gate. `ui-primitives` IS in
`PLATFORM_MODULES`, so importing its leaves is legal from any client package.
Cross-plugin collaboration otherwise goes through cordis services.

## Put a user-facing switch next to the callers it must intercept

When a setting chooses between an app-wide engine and the platform default
(`setTtsBackend` for the voice provider), the switch must live **in the same
module as every entry point that could bypass it** — here `speech-synthesis.ts`,
beside `speakText`/`speakCode`.

Patching each caller instead is what fails: the module had been split so the
engine lived in `speech-engine.ts` while `speakText`/`speakCode` spoke through
the system voice directly in `speech-synthesis.ts`. Both had tests, both were
green, and the chosen provider silently never applied. Moving the switch makes
the bypass **structurally impossible** rather than "we remembered every call
site". If you find yourself adding a third module that also speaks, that is the
signal the seam is in the wrong place.

## Design-system rules (contracts, not preferences)

- Colors/shadows/radii are `--dsw-*` tokens defined in
  `packages/client/ui-theme/src/styles/` — never literals. (Prefix is `--dsw-`,
  **not** `--dsh-`; a typo here produces false conclusions when grepping.)
- Neutral borders are `0.5px`; a rule must not combine an elevation token's
  `box-shadow` with a neutral `--dsw-alias-border-*` border in the same rule.
- Any full radius (50% / 100% / ≥99px) needs `corner-shape: round` in the same rule.
- The global stylesheet list in `ui-theme/src/client/styles.ts` is fixed and
  `a11y.css` must stay last — change it only together with its test.
- Every new animation needs a `prefers-reduced-motion` branch.
- **A scroll container on an elevated surface must rebind the scrollbar pair.**
  If your sheet has `overflow: auto/scroll` and any rule names a surface
  (`--dsw-alias-bg-*` / `--dsw-specific-*`), add to the **surface** rule (custom
  properties inherit down to whichever descendant scrolls):
  ```css
  --dsh-scrollbar-thumb: var(--dsw-alias-scrollbar-bg-l2);
  --dsh-scrollbar-thumb-hover: var(--dsw-alias-scrollbar-hover-l2);
  ```
  `ui-theme/tests/scrollbar-styles.client.spec.ts` fails with "scrolls on an
  elevated surface without rebinding" — the defect it closes is invisible in
  review and in a light-palette screenshot (l1 and l2 thumbs differ only in the
  dark palette). Copy `ui-primitives/src/Menu.module.css` as the reference.

## Testing UI behavior

- Use `jsdom` (`// @vitest-environment jsdom` + `@testing-library/react`).
- **jsdom implements no Web Speech API and no media APIs**: `speechSynthesis`,
  `SpeechSynthesisUtterance`, `SpeechRecognition`, `webkitSpeechRecognition`,
  `MediaRecorder`, `RTCPeerConnection` are all `undefined`. Code that degrades
  gracefully therefore tests its "unavailable" path for free; stub the global
  (`vi.stubGlobal('SpeechRecognition', Fake)`) to test the available path.
- Always `vi.unstubAllGlobals()` + `vi.restoreAllMocks()` in `afterEach`, and
  prefer `vi.spyOn(X.prototype, 'm')` over assigning to a prototype directly —
  a bare assignment leaks into later tests in the same file.
- `CDP` is unusable in this environment (sockets open, no frames) — do not try to
  drive the real renderer; assert through jsdom instead.

### jsdom's `Blob` has no `stream()`

`new Response(new Blob([bytes]))` throws `object.stream is not a function` from
inside `response.blob()` — jsdom's `Blob` is a stub. Pass a **string** to the
stub instead (`new Response('clip', { headers })`): `Response.blob()` turns text
into bytes on its own, and the code under test never learns the difference.

### Never `vi.stubGlobal('URL', {...})`

Replacing the whole `URL` class breaks jsdom's own constructor and every later
test in the file. Assign the two methods you need and restore the originals:

```ts
const real = { create: URL.createObjectURL, revoke: URL.revokeObjectURL }
URL.createObjectURL = vi.fn(() => 'blob:fake/1')
// afterEach: URL.createObjectURL = real.create
```

### A module-level singleton needs `dispose()` in `afterEach`

When a subsystem is deliberately created **once per app** (`screenCapture()`,
`installSpeechEngine()`), state started by one test survives into the next and
later tests fail with "expected vi.fn() to have been called once, but got 0
times". Add `<singleton>().dispose()` to `afterEach`. ⚠️ Do not "fix" this by
making the singleton per-test — the leaking state *is* the designed behaviour
(that is exactly what makes the feature outlive its UI). The test file is what
has to clean up.

## Errors that cross the Electron bridge are NOT `instanceof Error`

A rejected `ipcRenderer.invoke` surfaces in the page as a **foreign-realm** object:
`error instanceof Error` is `false`, `String(error)` yields `[object Object]`, and if
you print it raw the user sees the harness's own plumbing:

```
Error invoking remote method 'v2ray-start': Error: V2Ray не найден. …
```

Do this instead:

1. Read the reason **by property**, with a shape check —
   `typeof error === 'object' && typeof error.message === 'string'` (accept a plain
   string too).
2. Strip the wrapper with **one anchored regex** (Electron wraps twice):
   `/^(?:[A-Za-z]*Error:\s*)?(?:Error invoking remote method '[^']*':\s*)?(?:[A-Za-z]*Error:\s*)?/`
3. If stripping leaves nothing, return the original text rather than an empty string.

Twinned implementations to copy: `ui-settings-network/src/client/v2ray-bridge.ts`
(`bridgeErrorMessage`) and `electron/port-selector.html` (`readableError`, 7 call
sites). ⚠️ `oxlint`'s `no-base-to-string` **forbids** `String(error)` on a foreign
object — treat the lint error as the design note it is: the case is unhandled.

⚠️ A jsdom test that throws from another realm reproduces this exactly. An
`instanceof Error` assertion in the test passes while the shipped code still leaks
the wrapper — assert on the *rendered string* (`includes('Error invoking remote
method') === false`), not on the error object's type.

## Installer UX in the launcher: progress + source failover

When a launcher button performs a long-running install (example: V2Ray core),
three pieces are load-bearing together — skipping one causes user-visible hangs
or "works on my machine" failures:

1. **Emit machine-readable progress from the worker script**
   - Print a dedicated line prefix (e.g. `[v2ray-progress] {json}`) with
     `percent` 0-100 and a short message.
   - Keep ordinary logs separate (`[v2ray] ...`) so the parent can parse
     progress deterministically.

2. **Stream progress through main -> preload -> page**
   - Main parses child stdout/stderr line-by-line and forwards progress over a
     dedicated IPC event (e.g. `v2ray-install-progress`).
   - Preload exposes both the invoke action and an event subscription with
     unsubscribe (`onV2RayInstallProgress`).
   - The page updates one status line in place, including percent text.

3. **Never allow infinite waiting**
   - Set a hard timeout in main for the child process (kill + friendly error).
   - Add a second watchdog timeout in the page (`Promise.race`) so UI cannot be
     stuck if IPC itself wedges.

Source failover pattern for downloaders:
- Build an ordered source list (primary + mirrors).
- Resolve checksum and archive by trying each source in sequence.
- On each failure, record reason and continue automatically.
- If all fail, return one user-facing message with the attempted sources.

This pattern was verified in `electron/port-selector.html` + `electron/main.js`
+ `scripts/setup-v2ray-core.mjs` and guarded by launcher tests.

## Browser-capability gotchas worth knowing before you build on one

- **`SpeechRecognition` / `webkitSpeechRecognition` is NOT local in Chromium.**
  It calls Google's server-side recognizer. Chrome ships the credentials;
  **Electron does not**, so in the Electron app `start()` always fails with
  `network` (or `service-not-allowed`) even though the constructor exists. Never
  promise "works offline" for dictation in Electron — it only works in a real
  browser (Chrome/Edge, e.g. via `dsh web`). Detect and explain rather than fail
  generically.
- **`speechSynthesis` (TTS) IS local** — it uses the OS voices, so it works in
  Electron and in browsers alike.
- A capability probe by constructor presence is not proof the feature works;
  always pair it with an error-code mapping so the user gets a reason.
- Probing a real Electron renderer from a sandboxed shell does not work
  (`ERR_FAILED -2` even for `about:blank`) — the renderer cannot spawn there,
  while the app itself loads pages fine. Do not burn time on it; check the docs.
  If you do write such a probe, mirror `electron/main.js:75-76`
  (`disable-renderer-backgrounding`, `disable-background-timer-throttling`) or a
  hidden window's renderer is throttled and `executeJavaScript` never resolves.
- **A WebSocket upgrade carries no custom headers.** A browser cannot set them,
  so anything the host must know at connect time (a provider, a voice, a model)
  has to ride the **query string** —
  `/api/media/realtime?url=…&provider=…&voice=…`. The host reads it with
  `new URL(req.url, 'http://x').searchParams`. Do not design a handshake that
  depends on headers; it will pass in a test and fail in the app.
- **A hidden window throttles main-thread timers to ~once a minute.** For a
  cadence that must survive minimising, the window needs
  `backgroundThrottling: false` in `webPreferences` (plus
  `powerSaveBlocker.start('prevent-display-sleep')` when a sleeping display
  would freeze the work). Prefer running the tick in a `Worker` built from a
  **blob URL** — no second bundler entry point — with an honest fallback to
  `setInterval` when `Worker` is absent or policy refuses one. Terminate the
  worker on stop so nothing outlives the run.
