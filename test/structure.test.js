'use strict';

const assert = require('assert');
const { sanitizeId, buildObjects, toStateValue, toWriteParams } = require('../lib/structure');

describe('structure', () => {
    it('sanitizes ids', () => {
        assert.strictEqual(sanitizeId('HK Hof Fußboden'), 'HK_Hof_Fussboden');
        assert.strictEqual(sanitizeId('Part.-Absch.'), 'Part_-Absch');
        assert.strictEqual(sanitizeId('Eingänge'), 'Eingaenge');
    });

    it('makes duplicate names unique and creates node values', () => {
        const menu = [
            {
                uri: '24/10561',
                name: 'Kessel',
                children: [
                    {
                        uri: '24/10561/0/11031/0',
                        name: 'Wassermangel',
                        children: [
                            { uri: '24/10561/0/11031/2016', name: 'Eingang', children: [] },
                            { uri: '24/10561/0/11031/2017', name: 'Eingang', children: [] },
                        ],
                    },
                ],
            },
        ];
        const infos = new Map([
            ['24/10561/0/11031/0', { type: 'TEXT', scaleFactor: 1, isWritable: false, validValues: null }],
        ]);
        const values = new Map([['24/10561/0/11031/0', { raw: 1051, strValue: 'OK', advTextOffset: 1050 }]]);
        const ids = buildObjects(menu, infos, values, false).map(o => o.id);
        assert.deepStrictEqual(ids, [
            'Kessel',
            'Kessel.Wassermangel',
            'Kessel.Wassermangel._Wert',
            'Kessel.Wassermangel.Eingang_2016',
            'Kessel.Wassermangel.Eingang_2017',
        ]);
    });

    it('converts values', () => {
        assert.strictEqual(toStateValue({ kind: 'number', scaleFactor: 10 }, { raw: 605, strValue: '60,5' }), 60.5);
        assert.strictEqual(toStateValue({ kind: 'text' }, { raw: 1802, strValue: 'Aus' }), 1802);
        assert.strictEqual(toStateValue({ kind: 'timeslot' }, { raw: 0, strValue: '00:00 - 24:00' }), '00:00 - 24:00');
    });

    it('builds write parameters', () => {
        assert.deepStrictEqual(toWriteParams({ kind: 'number', scaleFactor: 10, min: 0, max: 950 }, 60), { raw: 600 });
        assert.throws(() => toWriteParams({ kind: 'number', scaleFactor: 10, min: 0, max: 950 }, 100));
        assert.deepStrictEqual(toWriteParams({ kind: 'timeslot', scaleFactor: 10 }, '06:00 - 12:30 40'), {
            raw: 400,
            begin: 24,
            end: 50,
        });
        assert.throws(() => toWriteParams({ kind: 'string' }, 'x'));
    });
});
