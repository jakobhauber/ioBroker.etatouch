'use strict';

const { XMLParser } = require('fast-xml-parser');

const ARRAY_TAGS = new Set(['fub', 'object', 'variable', 'error', 'vars']);

const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '',
    removeNSPrefix: true,
    parseTagValue: false,
    parseAttributeValue: false,
    trimValues: true,
    textNodeName: '#text',
    isArray: (name, jpath) => ARRAY_TAGS.has(name) || jpath.endsWith('validValues.value'),
});

/**
 * Normalizes an ETA URI to the form "24/10561/0/0/12000" (no leading slash, no /user/var prefix).
 *
 * @param {string} uri
 */
function normalizeUri(uri) {
    return String(uri || '')
        .replace(/^\/?user\/(var|varinfo)\//, '')
        .replace(/^\/+/, '')
        .replace(/\/+$/, '');
}

/**
 * Returns the text content of a parsed element (string or { '#text': ... }).
 *
 * @param {any} el
 */
function textOf(el) {
    if (el === undefined || el === null) {
        return '';
    }
    if (typeof el === 'object') {
        return el['#text'] !== undefined ? String(el['#text']) : '';
    }
    return String(el);
}

class EtaError extends Error {
    /**
     * @param {string} message
     * @param {number} status
     */
    constructor(message, status) {
        super(message);
        this.status = status;
    }
}

class EtaClient {
    /**
     * @param {object} options
     * @param {string} options.host
     * @param {number} [options.port]
     * @param {number} [options.timeout] request timeout in ms
     */
    constructor({ host, port = 8080, timeout = 10000 }) {
        this.baseUrl = `http://${host}:${port}`;
        this.timeout = timeout;
    }

    /**
     * Sends a request and returns the parsed <eta> element.
     *
     * @param {string} method
     * @param {string} path
     * @param {Record<string, string|number>} [form]
     */
    async request(method, path, form) {
        /** @type {RequestInit} */
        const options = { method, signal: AbortSignal.timeout(this.timeout) };
        if (form) {
            options.body = new URLSearchParams(Object.entries(form).map(([k, v]) => [k, String(v)])).toString();
            options.headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
        }
        let res;
        try {
            res = await fetch(this.baseUrl + path, options);
        } catch (err) {
            const reason = err && err.cause ? err.cause.message || err.cause.code : err.message;
            throw new EtaError(`${method} ${path} fehlgeschlagen: ${reason}`, 0);
        }
        const text = await res.text();
        let eta = {};
        if (text.trim()) {
            const doc = parser.parse(text);
            eta = doc.eta || {};
        }
        if (eta.error) {
            throw new EtaError(`${method} ${path}: ${textOf(eta.error[0]) || 'Fehler'}`, res.status);
        }
        if (!res.ok) {
            throw new EtaError(`${method} ${path}: HTTP ${res.status}`, res.status);
        }
        return eta;
    }

    async getApiVersion() {
        const eta = await this.request('GET', '/user/api');
        return eta.api ? eta.api.version : undefined;
    }

    /**
     * Returns the menu as a tree: [{ uri, name, children: [...] }] (one entry per fub).
     */
    async getMenu() {
        const eta = await this.request('GET', '/user/menu');
        const convert = node => ({
            uri: normalizeUri(node.uri),
            name: node.name || '',
            children: (node.object || []).map(convert),
        });
        return ((eta.menu && eta.menu.fub) || []).map(convert);
    }

    /**
     * @param {string} uri
     */
    async getVarInfo(uri) {
        const eta = await this.request('GET', `/user/varinfo/${normalizeUri(uri)}`);
        const v = eta.varInfo && eta.varInfo.variable && eta.varInfo.variable[0];
        if (!v) {
            throw new EtaError(`Keine varinfo für ${uri}`, 0);
        }
        const info = {
            uri: normalizeUri(v.uri),
            name: v.name,
            fullName: v.fullName,
            unit: v.unit || '',
            decPlaces: Number(v.decPlaces) || 0,
            scaleFactor: Number(v.scaleFactor) || 1,
            advTextOffset: Number(v.advTextOffset) || 0,
            isWritable: v.isWritable === '1',
            type: textOf(v.type) || 'DEFAULT',
            /** @type {{values?: {raw: number, text: string}[], min?: number, max?: number, def?: number} | null} */
            validValues: null,
        };
        const vv = v.validValues;
        if (vv && typeof vv === 'object') {
            info.validValues = {};
            if (vv.value) {
                info.validValues.values = vv.value.map(x => ({ raw: Number(textOf(x)), text: x.strValue }));
            }
            for (const key of ['min', 'max', 'def']) {
                const m = vv[key];
                if (m && typeof m === 'object' && m['#text'] !== undefined) {
                    info.validValues[key] = Number(m['#text']);
                    if (m.unit && !info.unit) {
                        info.unit = m.unit;
                    }
                }
            }
        }
        return info;
    }

    /**
     * @param {any} v raw <value>/<variable> element
     */
    static parseValue(v) {
        return {
            uri: normalizeUri(v.uri),
            raw: Number(textOf(v)),
            strValue: v.strValue || '',
            unit: v.unit || '',
            scaleFactor: Number(v.scaleFactor) || 1,
            decPlaces: Number(v.decPlaces) || 0,
            advTextOffset: Number(v.advTextOffset) || 0,
        };
    }

    /**
     * @param {string} uri
     */
    async readVar(uri) {
        const eta = await this.request('GET', `/user/var/${normalizeUri(uri)}`);
        if (!eta.value) {
            throw new EtaError(`Kein Wert für ${uri}`, 0);
        }
        return EtaClient.parseValue(eta.value);
    }

    /**
     * WRITES a value to the heating (HTTP POST). Only called on explicit user state changes.
     *
     * @param {string} uri
     * @param {number} raw raw (unscaled) value
     * @param {number} [begin] time slot begin (quarter hours since midnight)
     * @param {number} [end] time slot end (quarter hours since midnight)
     */
    async setVar(uri, raw, begin, end) {
        /** @type {Record<string, number>} */
        const form = { value: raw };
        if (begin !== undefined && end !== undefined) {
            form.begin = begin;
            form.end = end;
        }
        await this.request('POST', `/user/var/${normalizeUri(uri)}`, form);
    }

    /**
     * @param {string} name
     */
    async deleteVarset(name) {
        await this.request('DELETE', `/user/vars/${name}`);
    }

    /**
     * @param {string} name
     */
    async createVarset(name) {
        await this.request('PUT', `/user/vars/${name}`);
    }

    /**
     * @param {string} name
     * @param {string} uri
     */
    async addToVarset(name, uri) {
        await this.request('PUT', `/user/vars/${name}/${normalizeUri(uri)}`);
    }

    /**
     * Reads all variables of a varset.
     *
     * @param {string} name
     */
    async readVarset(name) {
        const eta = await this.request('GET', `/user/vars/${name}`);
        const set = eta.vars && eta.vars[0];
        if (!set) {
            throw new EtaError(`Varset ${name} nicht vorhanden`, 404);
        }
        return (set.variable || []).map(v => EtaClient.parseValue(v));
    }

    /**
     * Returns active errors as a flat list.
     */
    async getErrors() {
        const eta = await this.request('GET', '/user/errors');
        const errors = eta.errors && (Array.isArray(eta.errors) ? eta.errors[0] : eta.errors);
        const list = [];
        for (const fub of (errors && errors.fub) || []) {
            for (const e of fub.error || []) {
                list.push({
                    fub: fub.name,
                    msg: e.msg,
                    priority: e.priority,
                    time: e.time,
                    text: textOf(e),
                });
            }
        }
        return list;
    }
}

/**
 * Runs async tasks with limited concurrency.
 *
 * @template T, R
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T, index: number) => Promise<R>} fn
 * @returns {Promise<R[]>}
 */
async function mapLimit(items, limit, fn) {
    const results = new Array(items.length);
    let next = 0;
    const worker = async () => {
        while (next < items.length) {
            const i = next++;
            results[i] = await fn(items[i], i);
        }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return results;
}

module.exports = { EtaClient, EtaError, normalizeUri, mapLimit };
