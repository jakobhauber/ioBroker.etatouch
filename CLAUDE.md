# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

ioBroker adapter `etatouch` for ETA heating systems, using the ETAtouch RESTful webservices (XML over HTTP, port 8080; spec: ETA-RESTful v1.2 – resources `/user/api`, `/user/menu`, `/user/var`, `/user/vars`, `/user/varinfo`, `/user/errors`). Repo: https://github.com/jakobhauber/ioBroker.etatouch. User-facing texts (log messages, admin UI, README) are in German.

## Commands

```bash
npm install
npm test                 # unit + package tests
npm run test:unit        # mocha test/structure.test.js
npm run test:package     # @iobroker/testing validation of package.json / io-package.json
npx mocha test/structure.test.js -g "sanitizes"   # single test by name
node --check main.js     # quick syntax check (main.js needs js-controller to actually run)
```

No build step and no linter: plain CommonJS JavaScript. This is required because the adapter is installed directly from GitHub (`iobroker url https://github.com/jakobhauber/ioBroker.etatouch`), which only runs `npm install`. Keep runtime dependencies pure JS (target: Raspberry Pi arm64, Node 22).

## Releasing

Bump `version` in **both** `package.json` and `io-package.json`, add an entry to `common.news` in `io-package.json` (en + de) and to the Changelog in `README.md`, run `npm test`, commit, push to `main`. The user updates by reinstalling from the GitHub URL.

## Architecture

- `lib/etaClient.js` – thin API wrapper (built-in `fetch` + `fast-xml-parser`). All URIs are normalized to `24/10561/0/0/12000` form (no leading slash; varset responses omit it, menu includes it). `EtaError.status === 0` means network error/timeout (retryable); other statuses are errors reported by the heating (e.g. `Invalid permission`, HTTP 400). `mapLimit` limits concurrency.
- `lib/structure.js` – pure functions, unit-tested: menu tree + varinfo + values → ioBroker object list (`buildObjects`), value conversion (`toStateValue`) and write conversion (`toWriteParams`). Each state stores everything needed at runtime in `native` (`uri`, `kind`, `etaType`, `scaleFactor`, `min`/`max`, `isWritable`).
- `main.js` – adapter lifecycle.

Key flow:
1. **No objects are created on install/start.** The menu structure differs per heating, so objects are only created when the user presses "XML-Struktur einlesen" in the admin UI (`admin/jsonConfig.json` `sendTo` → `onMessage` command `readStructure`). The handler replies immediately and runs `readStructure()` in the background (fetching varinfo for ~1800 entries takes ~12 min because the heating answers slowly); progress goes to `info.structureStatus` and the log.
2. `readStructure` → `getMenu` → varinfo per URI → creates the varset → reads values → `buildObjects` → deletes obsolete objects → `extendObject` for all.
3. On every start, `loadStates()` rebuilds the `uri → state` map from existing objects (those with `native.uri`); polling only runs if such objects exist.
4. Polling reads all values with one request via the varset `/user/vars/ioBroker`. Varsets are not persistent on the heating (lost on reboot) → recreated when reading fails; recreated hourly if some variables could not be added.
5. Writing (`onStateChange`, `ack=false`) only when config `writeEnabled` (default **false**) and `native.isWritable`; POST `/user/var/<uri>`, then re-read the variable.

Value mapping by `native.kind`: `text` (ETA type TEXT → number with `common.states` from varinfo), `number` (DEFAULT → `raw / scaleFactor`; strValues `xxx`/`---` mean "not available" but are still numeric), `timeslot` (string `"HH:MM - HH:MM [value]"`, begin/end in quarter hours 0–96), `string` (read-only fallback). Menu nodes with children that carry their own value get a `_Wert` state. Duplicate sibling names get the last non-zero URI segment appended.

The heating may deny access to whole CAN nodes (`Invalid permission`, node = first URI segment, e.g. `120`), and such function blocks can temporarily vanish from the menu. Inaccessible variables are skipped; existing objects of a currently locked node are kept if they were read successfully before.

## Testing against the real heating

The user's heating is reachable at `192.168.2.160:8080` (API 1.2, ~1780 menu entries, CAN nodes 24, 120, 121). GET requests and varset PUT/DELETE are fine. **Never send POST `/user/var/...` (changes heating values) without the user's explicit consent.** For live checks, write a script in the scratchpad that requires `lib/etaClient.js` / `lib/structure.js` directly.
