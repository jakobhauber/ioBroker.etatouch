'use strict';

const utils = require('@iobroker/adapter-core');
const { EtaClient, mapLimit } = require('./lib/etaClient');
const { collectUris, buildObjects, nodeOf, toStateValue, toWriteParams } = require('./lib/structure');

const VARSET = 'ioBroker';
const PARALLEL = 4;

class Etatouch extends utils.Adapter {
    /**
     * @param {Partial<utils.AdapterOptions>} [options]
     */
    constructor(options = {}) {
        super({ ...options, name: 'etatouch' });
        /** @type {Map<string, {id: string, native: any}>} uri -> state */
        this.states = new Map();
        /** @type {Map<string, any>} id -> native */
        this.natives = new Map();
        this.pollTimer = null;
        this.busy = false;
        this.varsetReady = false;
        this.varsetFailed = 0;
        this.varsetTime = 0;
        this.stopped = false;

        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('message', this.onMessage.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    async onReady() {
        await this.setStateAsync('info.connection', false, true);
        if (!this.config.host) {
            this.log.error('Keine IP-Adresse konfiguriert');
            return;
        }
        this.client = this.createClient(this.config.host, this.config.port);
        this.interval = Math.max(10, Number(this.config.interval) || 300) * 1000;

        try {
            const version = await this.client.getApiVersion();
            await this.setStateAsync('info.apiVersion', String(version || ''), true);
            await this.setStateAsync('info.connection', true, true);
            this.log.info(`Verbunden mit ETA ${this.config.host}, API-Version ${version}`);
        } catch (err) {
            this.log.warn(`ETA nicht erreichbar: ${err.message}`);
        }

        await this.loadStates();
        this.subscribeStates('*');

        if (!this.states.size) {
            this.log.info('Noch keine Datenpunkte vorhanden. Bitte in den Instanz-Einstellungen "XML-Struktur einlesen" drücken.');
            return;
        }
        this.log.info(`${this.states.size} Datenpunkte geladen`);
        this.schedulePoll(0);
    }

    /**
     * @param {string} host
     * @param {number|string} port
     */
    createClient(host, port) {
        return new EtaClient({ host: String(host).trim(), port: Number(port) || 8080, timeout: 10000 });
    }

    /**
     * Loads all data point objects (those with native.uri) from the database and
     * aligns common.write with the "writeEnabled" setting.
     */
    async loadStates() {
        this.states.clear();
        this.natives.clear();
        const objs = await this.getAdapterObjectsAsync();
        for (const [fullId, obj] of Object.entries(objs)) {
            if (obj.type !== 'state' || !obj.native || !obj.native.uri) {
                continue;
            }
            const id = fullId.substring(this.namespace.length + 1);
            this.states.set(obj.native.uri, { id, native: obj.native });
            this.natives.set(id, obj.native);
            const write = !!obj.native.isWritable && !!this.config.writeEnabled;
            if (!!obj.common.write !== write) {
                await this.extendObjectAsync(id, { common: { write } });
            }
        }
    }

    /**
     * (Re)creates the varset on the ETA containing all given URIs.
     *
     * @param {EtaClient} client
     * @param {string[]} uris
     */
    async setupVarset(client, uris) {
        try {
            await client.deleteVarset(VARSET);
        } catch {
            // varset did not exist
        }
        await client.createVarset(VARSET);
        /** @type {Map<string, number>} node -> number of failed variables */
        const failedNodes = new Map();
        let failed = 0;
        await mapLimit(uris, PARALLEL, async uri => {
            try {
                await this.withRetry(() => client.addToVarset(VARSET, uri));
            } catch (err) {
                failed++;
                failedNodes.set(nodeOf(uri), (failedNodes.get(nodeOf(uri)) || 0) + 1);
                this.log.debug(`Variable ${uri} konnte nicht zum Varset hinzugefügt werden: ${err.message}`);
            }
        });
        if (failed) {
            const detail = [...failedNodes].map(([node, n]) => `Knoten ${node}: ${n}`).join(', ');
            this.log.warn(
                `${failed} von ${uris.length} Variablen sind auf der Heizung nicht abrufbar (${detail}). Neuer Versuch in einer Stunde.`,
            );
        }
        this.varsetFailed = failed;
        this.varsetTime = Date.now();
        this.log.debug(`Varset ${VARSET} mit ${uris.length - failed} Variablen angelegt`);
    }

    /**
     * Retries a request on network errors/timeouts (not on errors reported by the heating).
     *
     * @template T
     * @param {() => Promise<T>} fn
     * @param {number} [attempts]
     * @returns {Promise<T>}
     */
    async withRetry(fn, attempts = 3) {
        for (let i = 1; ; i++) {
            try {
                return await fn();
            } catch (err) {
                if (err.status !== 0 || i >= attempts || this.stopped) {
                    throw err;
                }
                await new Promise(resolve => setTimeout(resolve, 1000 * i));
            }
        }
    }

    /**
     * @param {number} delay
     */
    schedulePoll(delay) {
        if (this.pollTimer) {
            this.clearTimeout(this.pollTimer);
        }
        if (this.stopped) {
            return;
        }
        this.pollTimer = this.setTimeout(async () => {
            this.pollTimer = null;
            await this.poll();
            this.schedulePoll(this.interval);
        }, delay);
    }

    async poll() {
        if (this.busy || !this.states.size) {
            return;
        }
        this.busy = true;
        try {
            // Variables that were not accessible (e.g. "Invalid permission") are retried once per hour
            if (this.varsetReady && this.varsetFailed && Date.now() - this.varsetTime > 3600000) {
                this.varsetReady = false;
            }
            if (!this.varsetReady) {
                await this.setupVarset(this.client, [...this.states.keys()]);
                this.varsetReady = true;
            }
            let values;
            try {
                values = await this.client.readVarset(VARSET);
            } catch (err) {
                if (err.status === 0) {
                    throw err;
                }
                // Varset lost (e.g. ETA restarted) -> recreate
                this.log.info(`Varset nicht lesbar (${err.message}), wird neu angelegt`);
                await this.setupVarset(this.client, [...this.states.keys()]);
                values = await this.client.readVarset(VARSET);
            }
            await this.applyValues(values);
            await this.updateErrors(this.client);
            await this.setStateChangedAsync('info.connection', true, true);
        } catch (err) {
            this.varsetReady = false;
            this.log.warn(`Abfrage fehlgeschlagen: ${err.message}`);
            await this.setStateChangedAsync('info.connection', false, true);
        } finally {
            this.busy = false;
        }
    }

    /**
     * @param {any[]} values
     */
    async applyValues(values) {
        for (const value of values) {
            const entry = this.states.get(value.uri);
            if (!entry) {
                continue;
            }
            const val = toStateValue(entry.native, value);
            await this.setStateChangedAsync(entry.id, { val, ack: true });
        }
    }

    /**
     * @param {EtaClient} client
     */
    async updateErrors(client) {
        try {
            const errors = await client.getErrors();
            await this.setStateChangedAsync('info.errors', JSON.stringify(errors), true);
            await this.setStateChangedAsync('info.errorCount', errors.length, true);
        } catch (err) {
            this.log.debug(`Fehlerliste nicht lesbar: ${err.message}`);
        }
    }

    /**
     * Reads the XML menu structure of the heating and creates/updates/removes the objects.
     *
     * @param {string} host
     * @param {number|string} port
     */
    async readStructure(host, port) {
        const client = this.createClient(host, port);
        this.log.info(`Lese XML-Struktur von ${host}:${port || 8080} ...`);

        const menu = await client.getMenu();
        const uris = collectUris(menu);
        this.log.info(`${menu.length} Funktionsblöcke, ${uris.length} Menüeinträge gefunden, lese Variableninfos ...`);

        const infos = new Map();
        let done = 0;
        let lastPercent = -1;
        await mapLimit(uris, PARALLEL, async uri => {
            if (this.stopped) {
                throw new Error('Adapter wird beendet');
            }
            try {
                infos.set(uri, await this.withRetry(() => client.getVarInfo(uri)));
            } catch (err) {
                this.log.debug(`varinfo ${uri}: ${err.message}`);
            }
            const percent = Math.floor((++done * 100) / uris.length);
            if (percent !== lastPercent && percent % 5 === 0) {
                lastPercent = percent;
                await this.setStatus(`Lese Variableninfos: ${done}/${uris.length} (${percent} %)`, percent % 20 === 0);
            }
        });

        await this.setStatus('Lege Variablen-Set auf der Heizung an ...', true);
        await this.setupVarset(client, uris);
        const values = new Map((await client.readVarset(VARSET)).map(v => [v.uri, v]));

        await this.setStatus('Lege Objekte an ...', true);
        const objects = buildObjects(menu, infos, values, !!this.config.writeEnabled);
        const newIds = new Set(objects.map(o => o.id));

        // CAN nodes that answered at least one request in this scan
        const accessibleNodes = new Set([...infos.keys(), ...values.keys()].map(nodeOf));
        const lockedNodes = [...new Set(uris.map(nodeOf))].filter(n => !accessibleNodes.has(n));
        if (lockedNodes.length) {
            this.log.warn(
                `Knoten ${lockedNodes.join(', ')}: Heizung verweigert den Zugriff (z.B. "Invalid permission") – diese Datenpunkte werden übersprungen.`,
            );
        }

        // Objects of nodes that are currently not accessible are kept if they were read successfully before,
        // so a temporarily locked node does not lose its data points.
        const existing = await this.getAdapterObjectsAsync();
        const keepNodes = new Set();
        for (const obj of Object.values(existing)) {
            const node = obj.native && obj.native.uri ? nodeOf(obj.native.uri) : '';
            if (node && !accessibleNodes.has(node) && obj.type === 'state' && obj.native.etaType) {
                keepNodes.add(node);
            }
        }

        // remove objects that no longer exist on the heating
        let removed = 0;
        for (const [fullId, obj] of Object.entries(existing)) {
            const id = fullId.substring(this.namespace.length + 1);
            if (id === 'info' || id.startsWith('info.') || newIds.has(id)) {
                continue;
            }
            if (obj.native && obj.native.uri && keepNodes.has(nodeOf(obj.native.uri))) {
                continue;
            }
            await this.delForeignObjectAsync(fullId);
            removed++;
        }
        if (keepNodes.size) {
            this.log.info(`Vorhandene Datenpunkte von Knoten ${[...keepNodes].join(', ')} bleiben erhalten.`);
        }

        for (const { id, obj } of objects) {
            await this.extendObjectAsync(id, obj);
        }

        this.client = client;
        await this.loadStates();
        // kept data points of locked nodes are not in the varset yet -> let the next poll rebuild it
        const scanned = new Set(uris);
        this.varsetReady = [...this.states.keys()].every(uri => scanned.has(uri));
        await this.applyValues([...values.values()]);
        await this.updateErrors(client);
        await this.setStateAsync('info.connection', true, true);

        const stateCount = objects.filter(o => o.obj.type === 'state').length;
        await this.setStatus(
            `Fertig (${new Date().toLocaleString('de-DE')}): ${stateCount} Datenpunkte, ${removed} Objekte entfernt`,
            true,
        );
        this.schedulePoll(this.interval);
        return { stateCount, removed };
    }

    /**
     * Updates info.structureStatus and optionally logs the text.
     *
     * @param {string} text
     * @param {boolean} [log]
     */
    async setStatus(text, log = false) {
        if (log) {
            this.log.info(text);
        }
        await this.setStateAsync('info.structureStatus', text, true);
    }

    /**
     * @param {ioBroker.Message} obj
     */
    async onMessage(obj) {
        if (!obj || obj.command !== 'readStructure') {
            return;
        }
        const reply = msg => obj.callback && this.sendTo(obj.from, obj.command, msg, obj.callback);
        if (this.busy) {
            reply({ error: 'Es läuft bereits ein Vorgang, bitte warten (Fortschritt in etatouch.0.info.structureStatus).' });
            return;
        }
        const data = obj.message && typeof obj.message === 'object' ? obj.message : {};
        const host = String(data.host || this.config.host || '').trim();
        const port = Number(data.port) || this.config.port;
        if (!host) {
            reply({ error: 'Keine IP-Adresse angegeben' });
            return;
        }
        // Reading all variable infos takes several minutes -> answer immediately, continue in background
        this.busy = true;
        reply({
            result: 'Einlesen gestartet. Das dauert einige Minuten – Fortschritt im Log und in etatouch.0.info.structureStatus.',
        });
        try {
            await this.readStructure(host, port);
        } catch (err) {
            this.log.error(`XML-Struktur konnte nicht eingelesen werden: ${err.message}`);
            await this.setStatus(`Fehler: ${err.message}`).catch(() => {});
        } finally {
            this.busy = false;
        }
    }

    /**
     * @param {string} fullId
     * @param {ioBroker.State | null | undefined} state
     */
    async onStateChange(fullId, state) {
        if (!state || state.ack) {
            return;
        }
        const id = fullId.substring(this.namespace.length + 1);
        const native = this.natives.get(id);
        if (!native) {
            return;
        }
        if (!this.config.writeEnabled || !native.isWritable) {
            this.log.warn(`${id}: Schreiben ist nicht erlaubt (Einstellung "Schreiben erlauben" oder Datenpunkt nur lesbar)`);
            await this.refreshVar(id, native);
            return;
        }
        try {
            const current = native.kind === 'timeslot' ? await this.client.readVar(native.uri) : undefined;
            const { raw, begin, end } = toWriteParams(native, state.val, current);
            this.log.info(`Schreibe ${id} = ${state.val} (raw ${raw}${begin !== undefined ? `, ${begin}-${end}` : ''})`);
            await this.client.setVar(native.uri, raw, begin, end);
        } catch (err) {
            this.log.error(`${id} konnte nicht geschrieben werden: ${err.message}`);
        }
        await this.refreshVar(id, native);
    }

    /**
     * Reads a single variable and sets it with ack=true.
     *
     * @param {string} id
     * @param {any} native
     */
    async refreshVar(id, native) {
        try {
            const value = await this.client.readVar(native.uri);
            await this.setStateAsync(id, { val: toStateValue(native, value), ack: true });
        } catch (err) {
            this.log.warn(`${id} konnte nicht gelesen werden: ${err.message}`);
        }
    }

    /**
     * @param {() => void} callback
     */
    onUnload(callback) {
        try {
            this.stopped = true;
            if (this.pollTimer) {
                this.clearTimeout(this.pollTimer);
            }
            callback();
        } catch {
            callback();
        }
    }
}

if (require.main !== module) {
    /**
     * @param {Partial<utils.AdapterOptions>} [options]
     */
    module.exports = options => new Etatouch(options);
} else {
    new Etatouch();
}
