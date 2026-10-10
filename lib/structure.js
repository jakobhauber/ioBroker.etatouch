'use strict';

/** Name of the state that holds the value of a menu node which also has children. */
const NODE_VALUE_ID = '_Wert';

const TRANSLIT = { ä: 'ae', ö: 'oe', ü: 'ue', Ä: 'Ae', Ö: 'Oe', Ü: 'Ue', ß: 'ss' };

/**
 * Converts a menu name into a valid ioBroker ID segment.
 *
 * @param {string} name
 */
function sanitizeId(name) {
    const id = String(name || '')
        .replace(/[äöüÄÖÜß]/g, c => TRANSLIT[c])
        .replace(/[^A-Za-z0-9_-]+/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_+|_+$/g, '');
    return id || 'x';
}

/**
 * Last non-zero segment of a URI, used to make duplicate names unique.
 *
 * @param {string} uri
 */
function uriSuffix(uri) {
    const parts = uri.split('/').filter(p => p !== '0');
    return parts[parts.length - 1] || uri.replace(/\//g, '_');
}

/**
 * Assigns unique ID segments to a list of sibling nodes.
 *
 * @param {{name: string, uri: string}[]} nodes
 * @param {Set<string>} [reserved]
 * @returns {string[]}
 */
function uniqueIds(nodes, reserved = new Set()) {
    const base = nodes.map(n => sanitizeId(n.name));
    const counts = new Map();
    for (const b of base) {
        counts.set(b, (counts.get(b) || 0) + 1);
    }
    const used = new Set(reserved);
    return nodes.map((n, i) => {
        let id = counts.get(base[i]) > 1 || used.has(base[i]) ? `${base[i]}_${uriSuffix(n.uri)}` : base[i];
        let k = 2;
        while (used.has(id)) {
            id = `${base[i]}_${uriSuffix(n.uri)}_${k++}`;
        }
        used.add(id);
        return id;
    });
}

/**
 * Collects all URIs below the fub level (the fub itself is no variable).
 *
 * @param {any[]} menu
 * @returns {string[]}
 */
function collectUris(menu) {
    const uris = [];
    const walk = node => {
        uris.push(node.uri);
        node.children.forEach(walk);
    };
    menu.forEach(fub => fub.children.forEach(walk));
    return [...new Set(uris)];
}

/**
 * @param {string} s
 */
function looksNumeric(s) {
    // "xxx" / "---" = value currently not available (e.g. sensor not connected)
    if (/^(x+|-+)$/i.test(s.trim())) {
        return true;
    }
    if (s.includes(':')) {
        return false;
    }
    return Number.isFinite(parseFloat(s.replace(',', '.')));
}

/**
 * Decides how a variable is represented in ioBroker.
 *
 * @param {any} info varinfo (may be undefined)
 * @param {any} value current value (may be undefined)
 * @returns {'text'|'number'|'timeslot'|'string'}
 */
function kindOf(info, value) {
    const type = info ? info.type : undefined;
    if (type === 'TEXT') {
        return 'text';
    }
    if (type === 'TIMESLOT') {
        return 'timeslot';
    }
    if (type === 'DEFAULT') {
        const vv = info.validValues;
        if (vv && (vv.min !== undefined || vv.max !== undefined)) {
            return 'number';
        }
        if (!value || value.strValue === '' || looksNumeric(value.strValue)) {
            return 'number';
        }
        return 'string';
    }
    if (!info && value) {
        if (value.advTextOffset > 0) {
            return 'text';
        }
        if (value.strValue === '' || looksNumeric(value.strValue)) {
            return 'number';
        }
    }
    return 'string';
}

/**
 * CAN node number of a URI ("120/10111/0/0/1" -> "120").
 *
 * @param {string} uri
 */
function nodeOf(uri) {
    return String(uri || '').split('/')[0];
}

/**
 * Builds the ioBroker state object for one variable.
 *
 * @param {{uri: string, name: string}} node
 * @param {any} info
 * @param {any} value
 * @param {boolean} writeEnabled
 */
function buildStateObject(node, info, value, writeEnabled) {
    const kind = kindOf(info, value);
    const scaleFactor = (info && info.scaleFactor) || (value && value.scaleFactor) || 1;
    const decPlaces = (info && info.decPlaces) || (value && value.decPlaces) || 0;
    const unit = (value && value.unit) || (info && info.unit) || '';
    const isWritable = !!(info && info.isWritable) && kind !== 'string';
    const write = isWritable && writeEnabled;

    /** @type {any} */
    const common = {
        name: node.name,
        desc: (info && info.fullName) || undefined,
        read: true,
        write,
    };

    if (kind === 'text') {
        common.type = 'number';
        common.role = write ? 'level' : 'value';
        const states = {};
        for (const v of (info && info.validValues && info.validValues.values) || []) {
            states[v.raw] = v.text;
        }
        if (value && !(value.raw in states) && value.strValue) {
            states[value.raw] = value.strValue;
        }
        if (Object.keys(states).length) {
            common.states = states;
        }
    } else if (kind === 'number') {
        common.type = 'number';
        common.role = unit === '°C' ? (write ? 'level.temperature' : 'value.temperature') : write ? 'level' : 'value';
        if (unit) {
            common.unit = unit;
        }
        const vv = info && info.validValues;
        if (vv && vv.min !== undefined) {
            common.min = vv.min / scaleFactor;
        }
        if (vv && vv.max !== undefined) {
            common.max = vv.max / scaleFactor;
        }
        if (vv && vv.def !== undefined) {
            common.def = vv.def / scaleFactor;
        }
    } else {
        common.type = 'string';
        common.role = 'text';
    }

    return {
        type: 'state',
        common,
        native: {
            uri: node.uri,
            kind,
            etaType: info ? info.type : '',
            scaleFactor,
            decPlaces,
            advTextOffset: (info && info.advTextOffset) || (value && value.advTextOffset) || 0,
            isWritable,
            min: info && info.validValues ? info.validValues.min : undefined,
            max: info && info.validValues ? info.validValues.max : undefined,
        },
    };
}

/**
 * Builds the complete object list from the menu tree.
 * Variables the heating does not give access to (neither varinfo nor value, e.g. "Invalid permission")
 * are skipped, as are folders/devices without any accessible variable.
 *
 * @param {any[]} menu result of EtaClient.getMenu()
 * @param {Map<string, any>} infos uri -> varinfo
 * @param {Map<string, any>} values uri -> current value
 * @param {boolean} writeEnabled
 * @returns {{id: string, obj: any}[]}
 */
function buildObjects(menu, infos, values, writeEnabled) {
    const accessible = uri => infos.has(uri) || values.has(uri);

    /**
     * @returns {{id: string, obj: any}[]}
     */
    const walk = (nodes, prefix) => {
        const out = [];
        const ids = uniqueIds(nodes, new Set([NODE_VALUE_ID]));
        nodes.forEach((node, i) => {
            const id = `${prefix}.${ids[i]}`;
            const info = infos.get(node.uri);
            const value = values.get(node.uri);
            if (node.children.length) {
                const inner = [];
                // Menu nodes with children may carry a value themselves (e.g. state of an input)
                const hasValue = value && (value.strValue !== '' || (info && info.type !== 'DEFAULT'));
                if (hasValue) {
                    inner.push({
                        id: `${id}.${NODE_VALUE_ID}`,
                        obj: buildStateObject(node, info, value, writeEnabled),
                    });
                }
                inner.push(...walk(node.children, id));
                if (inner.length) {
                    out.push({ id, obj: { type: 'folder', common: { name: node.name }, native: { uri: node.uri } } });
                    out.push(...inner);
                }
            } else if (accessible(node.uri)) {
                out.push({ id, obj: buildStateObject(node, info, value, writeEnabled) });
            }
        });
        return out;
    };

    /** @type {{id: string, obj: any}[]} */
    const result = [];
    const fubIds = uniqueIds(menu);
    menu.forEach((fub, i) => {
        const inner = walk(fub.children, fubIds[i]);
        if (inner.length) {
            result.push({
                id: fubIds[i],
                obj: { type: 'device', common: { name: fub.name }, native: { uri: fub.uri } },
            });
            result.push(...inner);
        }
    });
    return result;
}

/**
 * Converts a value read from the ETA into the ioBroker state value.
 *
 * @param {any} native native part of the state object
 * @param {{raw: number, strValue: string}} value
 */
function toStateValue(native, value) {
    switch (native.kind) {
        case 'text':
            return Number.isFinite(value.raw) ? value.raw : null;
        case 'number':
            return Number.isFinite(value.raw) ? Number((value.raw / (native.scaleFactor || 1)).toFixed(6)) : null;
        default:
            return value.strValue;
    }
}

/**
 * Converts an ioBroker state value into the parameters for EtaClient.setVar().
 * Throws on invalid input.
 *
 * @param {any} native
 * @param {any} val
 * @param {any} [current] current value from the ETA (needed for time slots)
 * @returns {{raw: number, begin?: number, end?: number}}
 */
function toWriteParams(native, val, current) {
    const scale = native.scaleFactor || 1;
    const checkRange = raw => {
        if (native.min !== undefined && raw < native.min) {
            throw new Error(`Wert unter Minimum (${native.min / scale})`);
        }
        if (native.max !== undefined && raw > native.max) {
            throw new Error(`Wert über Maximum (${native.max / scale})`);
        }
        return raw;
    };
    if (native.kind === 'text') {
        const raw = Number(val);
        if (!Number.isInteger(raw)) {
            throw new Error(`Ungültiger Wert ${val}`);
        }
        return { raw };
    }
    if (native.kind === 'number') {
        const num = Number(val);
        if (!Number.isFinite(num)) {
            throw new Error(`Ungültiger Wert ${val}`);
        }
        return { raw: checkRange(Math.round(num * scale)) };
    }
    if (native.kind === 'timeslot') {
        const m = /^\s*(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})(?:\s+(-?\d+(?:[.,]\d+)?))?/.exec(String(val));
        if (!m) {
            throw new Error('Format "HH:MM - HH:MM" oder "HH:MM - HH:MM Wert" erwartet');
        }
        const toQuarter = (h, min) => {
            const total = Number(h) * 60 + Number(min);
            if (total % 15 !== 0 || total < 0 || total > 1440) {
                throw new Error('Zeiten müssen auf 15 Minuten fallen (00:00 - 24:00)');
            }
            return total / 15;
        };
        const begin = toQuarter(m[1], m[2]);
        const end = toQuarter(m[3], m[4]);
        const raw =
            m[5] !== undefined
                ? Math.round(Number(m[5].replace(',', '.')) * scale)
                : current && Number.isFinite(current.raw)
                  ? current.raw
                  : 0;
        return { raw, begin, end };
    }
    throw new Error('Datenpunkt ist nicht schreibbar');
}

module.exports = {
    NODE_VALUE_ID,
    sanitizeId,
    nodeOf,
    collectUris,
    buildObjects,
    toStateValue,
    toWriteParams,
};
