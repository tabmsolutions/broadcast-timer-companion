# companion-module-broadcast-timer

A [Bitfocus Companion](https://bitfocus.io/companion) module providing
**feedback and variables** for a self-hosted
[broadcast-timer](https://github.com/kgtpuck/broadcast-timer) server (a
time-of-day clock / count up-down timer for broadcast use).

This module is deliberately **read-only** — it never sends commands. It
connects to the server's WebSocket state feed and exposes live values as
Companion variables and feedbacks, so you can show the actual countdown
digits, running state, etc. on Companion buttons. All control
(start/stop/reset/set time/direction/digit entry/show/hide) stays on
Companion's built-in **Generic HTTP** module hitting the server's REST API —
this module doesn't touch or replace that, it's purely additive.

Because the server holds one authoritative state per timer and broadcasts
every change to all subscribers, any number of controllers can drive or
watch a timer at once: Generic HTTP buttons, this module, the server's own
`/control/:id` web page, multiple Companion instances — simultaneously, with
no conflict.

See [companion/HELP.md](companion/HELP.md) for the variable/feedback
reference, and the [server repo](https://github.com/kgtpuck/broadcast-timer)
for the REST API this module is a companion to.

## Installing into Companion (developer mode)

This isn't published to the official module store. To use it:

```bash
git clone https://github.com/kgtpuck/broadcast-timer-companion.git
cd broadcast-timer-companion
npm install
```

Then in Companion: **Settings → Developer modules → Add module path**, and
point it at this folder. Companion will pick it up as "Broadcast Timer".

## Validating changes

```bash
npm run check
```

Runs `@companion-module/tools`'s `companion-module-check` against the
manifest and module structure. **Known issue:** as of `@companion-module/tools@3.0.2`,
this script crashes on Windows with `ENOENT ... file:\C:\...` — it passes an
`import.meta.resolve()` URL string straight to `fs.stat()`, which only
accepts plain paths, not `file://` URLs, on Windows. This is a bug in that
package's `check-connection.js`, not in this module. If you hit it, validate
the manifest directly instead:
```bash
node -e "
import('@companion-module/base/manifest').then(async ({ validateManifest }) => {
  const { readFile } = await import('fs/promises');
  const manifestJson = JSON.parse(await readFile('./companion/manifest.json', 'utf8'));
  validateManifest(manifestJson, false);
  console.log('Manifest OK');
});
"
```
and confirm the module itself imports cleanly:
```bash
node -e "import('./main.js').then(m => console.log(typeof m.default))"
```
(should print `function`). The real test either way is loading it in
Companion's own developer mode, which this can't substitute for.

## Development

- `main.js` — the module (default-exports the instance class; no build step,
  runs directly under Node as Companion's developer mode expects)
- `companion/manifest.json` — module metadata Companion reads to load it
- `companion/HELP.md` — shown in Companion's own UI for this module
