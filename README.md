# companion-module-broadcast-timer

A [Bitfocus Companion](https://bitfocus.io/companion) module for a
self-hosted [broadcast-timer](https://github.com/kgtpuck/broadcast-timer)
server (a time-of-day clock / count up-down timer for broadcast use), with
both **full control** (actions for start/stop/reset/set time/adjust time/direction/
digit entry/show/hide/rename — the entire REST API) and **live feedback** (variables
and feedbacks Companion's built-in Generic HTTP module has no way to
provide). One module instead of two: install this and you don't need a
separate Generic HTTP connection for the same timer, though you still can if
you'd rather — the actions here just POST to the same REST endpoints Generic
HTTP would call by hand.

Because the server holds one authoritative state per timer and broadcasts
every change to all subscribers, any number of controllers can drive or
watch a timer at once: this module, Generic HTTP buttons, the server's own
`/control/:id` web page, multiple Companion instances — simultaneously, with
no conflict.

See [companion/HELP.md](companion/HELP.md) for the variable/feedback
reference, and the [server repo](https://github.com/kgtpuck/broadcast-timer)
for the REST API this module is a companion to.

## Installing into Companion

This isn't published to the official module store, and Companion 5.x doesn't
have a "point at a source folder" developer mode — it installs modules from
a packaged `.tgz`, built with `@companion-module/tools`:

```bash
git clone https://github.com/kgtpuck/broadcast-timer-companion.git
cd broadcast-timer-companion
npm install
npm run build
```

This produces `broadcast-timer-<version>.tgz` (a self-contained bundle —
`ws` and the module code are inlined via esbuild, no `node_modules` needed
at runtime). In Companion's web admin: **Modules** page → **Import module
package** → select that `.tgz`. It'll show up as "Broadcast Timer" and can
then be added from the **Connections** page like any other module.

To pick up changes after editing `main.js`, re-run `npm run build` and
re-import — Companion's "Add New Connection" dialog lets you pick which
installed version an existing connection uses if you need to roll back.

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
(should print `function`). Neither substitutes for actually building and
importing it into Companion (see above) and checking the connection status,
variables, and a real button — verified working end-to-end against Companion
5.0.3 on Windows.

## Development

- `main.js` — the module source (default-exports the instance class)
- `npm run build` — bundles `main.js` + dependencies into a single
  `broadcast-timer-<version>.tgz` via `@companion-module/tools`, ready to
  import into Companion
- `companion/manifest.json` — module metadata; `runtime.apiVersion` should
  track the installed `@companion-module/base` version (the build script
  sets this automatically)
- `companion/HELP.md` — shown in Companion's own UI for this module
