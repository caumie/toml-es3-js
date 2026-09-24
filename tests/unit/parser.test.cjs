const test = require('node:test');
const assert = require('node:assert/strict');
const { loadToml, toNative, assertParse, assertError } = require('../helpers/load-toml.cjs');

test('A01 empty document and A02 invalid input types', () => {
    const { api } = loadToml();
    assert.deepStrictEqual(Object.keys(api.parse('')), []);
    for (const value of [null, 1, [], {}, new String('x'), undefined]) {
        assert.throws(() => api.parse(value), (error) => {
            assert.equal(error.name, 'TOMLParseError');
            assert.equal(error.code, 'E_INPUT_TYPE');
            assert.deepEqual([error.index, error.line, error.column], [0, 1, 1]);
            return true;
        });
    }
});

test('A03 temporal brand and A04/A05 parse isolation', () => {
    const { api } = loadToml();
    const first = api.parse('d=2024-02-29');
    assert.equal(api.isTemporal(first.d), true);
    assert.equal(loadToml().api.isTemporal(first.d), false);
    assert.equal(api.isTemporal(null), false);
    assert.equal(api.isTemporal({ type: 'local-date', value: '2024-02-29' }), false);
    for (const value of [undefined, false, 0, '', [], new Date(0), new String('2024-02-29')]) {
        assert.equal(api.isTemporal(value), false);
    }
    assert.throws(() => api.parse('a=1\na=2'), (error) => error.code === 'E_DUPLICATE_KEY');
    const second = api.parse('a=2');
    first.extra = 3;
    assert.deepStrictEqual(toNative(second, api), { a: 2 });
    assert.deepStrictEqual(toNative(api.parse(''), api), {});
});

test('W01-W06 document trivia, newline, BOM, and invalid separators', () => {
    assertParse(assert, ' \t\n# only a comment\r\n', {});
    assertParse(assert, 'a=1 # memo\nb=2', { a: 1, b: 2 });
    assertParse(assert, 'a=1 # memo\r\nb=2', { a: 1, b: 2 });
    assertParse(assert, '\ufeffa=1', { a: 1 });
    for (const source of ['\ufeff\ufeffa=1', 'a\u3000=1', 'a=1\rb=2', 'a=1 #\u0000', 'a=1 b=2', 'a=1;', '=1', 'a=']) {
        assertError(assert, source, 'E_SYNTAX');
    }
});

test('U01-U04 Unicode scalar validation and supplementary characters', () => {
    const face = String.fromCharCode(55357, 56832);
    assertParse(assert, '"key"="' + face + '" # ' + face, { key: face });
    assertParse(assert, 's="\\U0001F600"', { s: face });
    for (const source of [String.fromCharCode(55296) + '=1', 's="' + String.fromCharCode(56320) + '"', '# ' + String.fromCharCode(55296), 's="\\uD800"', 's="\\uDC00"', 's="\\U00110000"', 's="\\uD800\\uDC00"']) {
        assertError(assert, source, 'E_UNICODE');
    }
});

test('K01-K06 keys and paths', () => {
    assertParse(assert, 'name="x"\nbare-key="v"\n1234="n"', { name: 'x', 'bare-key': 'v', '1234': 'n' });
    assertParse(assert, '""="blank"\n\'a b\'="space"', { '': 'blank', 'a b': 'space' });
    assertParse(assert, '"a.b"=1\na.b=2', { 'a.b': 1, a: { b: 2 } });
    assertParse(assert, 'a . "b.c" . d=1', { a: { 'b.c': { d: 1 } } });
    for (const key of ['__proto__', '"__proto__"', '"__prot\\u006f__"']) assertError(assert, key + '=1', 'E_UNSUPPORTED_KEY');
    for (const source of [
        'a.__proto__.x=1',
        'a={__proto__=1}',
        '["__proto__"]\nx=1',
        '[[a.__proto__]]\nx=1'
    ]) assertError(assert, source, 'E_UNSUPPORTED_KEY');
    for (const source of ['a..b=1', 'a.=1', '.a=1', '"""key"""=1']) assertError(assert, source, 'E_SYNTAX');
});

test('S01-S10 string forms, escapes, trimming, and quote boundaries', () => {
    assertParse(assert, 's="hello # = [] {}"', { s: 'hello # = [] {}' });
    assertParse(assert, "s='C:\\work\\input'", { s: 'C:\\work\\input' });
    assertParse(assert, 's="\\b\\t\\n\\f\\r\\\"\\\\\\u0041"', { s: '\b\t\n\f\r"\\A' });
    for (const source of ['s="\\q"', 's="\\e"', 's="\\x41"', 's="\\u123"', 's="line\nbreak"', 's="\u0001"', "s='line\nbreak'", 's="unfinished']) {
        assertError(assert, source, source.includes('\\q') || source.includes('\\e') || source.includes('\\x') || source.includes('\\u123') ? 'E_ESCAPE' : 'E_SYNTAX');
    }
    assertParse(assert, 'text="""\nfirst\n\nlast"""', { text: 'first\n\nlast' });
    assertParse(assert, "text='''\nfirst\n\nlast'''", { text: 'first\n\nlast' });
    assertParse(assert, 'text="""a\\\n  \n  b"""', { text: 'ab' });
    assertParse(assert, "text='''a\\\nb'''", { text: 'a\\\nb' });
    assertParse(assert, 'text="""one ""two"""', { text: 'one ""two' });
    assertError(assert, 'text="""six quotes: """"""""', 'E_SYNTAX');
    assertParse(assert, 'text="""a\r\nb"""', { text: 'a\nb' });
});

test('large string values remain exact across bounded output chunks', () => {
    const payload = 'x😀'.repeat(32768);
    const { api } = loadToml();
    const result = api.parse('payload="' + payload + '"');
    assert.equal(result.payload, payload);
    assert.equal(result.payload.length, 98304);
});

test('N01-N09 numbers, range checks, special floats and negative zero', () => {
    assertParse(assert, 'a=0\nb=+42\nc=-42\nd=1_000\ne=0b1010\nf=0o12\ng=0xA', { a: 0, b: 42, c: -42, d: 1000, e: 10, f: 10, g: 10 });
    for (const token of ['01', '-01', '1__0', '1_', '0x_A', '+0xA', '0B10', '0b2']) assertError(assert, 'a=' + token, 'E_NUMBER');
    assertParse(assert, 'a=9007199254740991\nb=-9007199254740991', { a: 9007199254740991, b: -9007199254740991 });
    for (const token of ['9007199254740992', '-9007199254740992', '0x20000000000000', '0o400000000000000000', '0b100000000000000000000000000000000000000000000000000000']) assertError(assert, 'a=' + token, 'E_INTEGER_RANGE');
    const safeMaximum = 9007199254740991n;
    for (const radix of [{ prefix: '0b', base: 2 }, { prefix: '0o', base: 8 }, { prefix: '0x', base: 16 }]) {
        const maximum = radix.prefix + safeMaximum.toString(radix.base);
        const overflow = radix.prefix + (safeMaximum + 1n).toString(radix.base);
        assertParse(assert, 'n=' + maximum, { n: 9007199254740991 });
        assertError(assert, 'n=' + overflow, 'E_INTEGER_RANGE');
    }
    assertParse(assert, 'a=1.25\nb=1e3\nc=-2E-2\nd=1_000.5', { a: 1.25, b: 1000, c: -0.02, d: 1000.5 });
    for (const token of ['.5', '1.', '1e', '1e_2', '01.0', '1abc']) assertError(assert, 'a=' + token, 'E_NUMBER');
    const { api } = loadToml();
    const special = api.parse('a=inf\nb=+inf\nc=-inf\nd=nan\ne=+nan\nf=-nan');
    assert.equal(special.a, Infinity);
    assert.equal(special.b, Infinity);
    assert.equal(special.c, -Infinity);
    for (const key of ['d', 'e', 'f']) assert.equal(Number.isNaN(special[key]), true);
    const zeros = api.parse('a=-0\nb=-0.0\nc=-1e-999\nd=1e-999');
    assert.equal(1 / zeros.a, Infinity);
    assert.equal(1 / zeros.b, -Infinity);
    assert.equal(1 / zeros.c, -Infinity);
    assert.equal(1 / zeros.d, Infinity);
    for (const token of ['1e999', '-1e999']) assertError(assert, 'a=' + token, 'E_FLOAT_RANGE');
    assertParse(assert, 'a=true\nb=false', { a: true, b: false });
    for (const token of ['TRUE', 'False', 'falsehood', 'null']) assertError(assert, 'a=' + token, 'E_SYNTAX');
});

test('D01-D08 dates and local times', () => {
    const { api } = loadToml();
    let value = api.parse('d=2024-02-29').d;
    assert.equal(api.isTemporal(value), true);
    assert.equal(value.type, 'local-date');
    assert.equal(value.value, '2024-02-29');
    for (const token of ['2023-02-29', '1900-02-29', '2024-00-01', '2024-13-01', '2024-01-00']) assertError(assert, 'd=' + token, 'E_DATE_TIME');
    assertParse(assert, 'd=2000-02-29', { d: { $temporal: 'local-date', value: '2000-02-29' } });
    value = api.parse('d=2026-09-23T12:34:56.123456789+09:00').d;
    assert.equal(value.type, 'offset-date-time');
    assert.equal(value.value, '2026-09-23T12:34:56.123456789+09:00');
    for (const token of ['2026-09-23t12:34:56z', '2026-09-23 12:34:56-00:00']) assert.equal(api.isTemporal(api.parse('d=' + token).d), true);
    assert.equal(api.parse('t=12:34:56.000001').t.type, 'local-time');
    assert.equal(api.parse('d=2026-09-23T12:34:56').d.type, 'local-date-time');
    for (const token of ['2026-09-23T12:34:56+23:59', '2026-09-23T12:34:56-23:59']) {
        assert.equal(api.parse('d=' + token).d.value, token);
    }
    for (const token of ['12:34', '2026-09-23T24:00:00', '2026-09-23T12:60:00', '2026-09-23T12:00:00+24:00', '2026-09-23T12:00:00+12:60', '12:00:00.', '2026-09-23T12:00:00.']) assertError(assert, 'd=' + token, 'E_DATE_TIME');
    assertError(assert, 'd=2026-09-23T12:00:60Z', 'E_UNSUPPORTED_LEAP_SECOND');
    assertError(assert, 'd=2026-09-23T12:00:61Z', 'E_DATE_TIME');
    assertParse(assert, 'a=[2026-09-23 12:00:00, 1]', { a: [{ $temporal: 'local-date-time', value: '2026-09-23 12:00:00' }, 1] });
});

test('R01-R05 arrays', () => {
    assertParse(assert, 'a=[]\nb=[1,"x",true]\nc=[[1],[2,3]]', { a: [], b: [1, 'x', true], c: [[1], [2, 3]] });
    assertParse(assert, 'a=[\n1, # c\n2,\n]', { a: [1, 2] });
    for (const source of ['a=[,1]', 'a=[1,,2]', 'a=[1 2]', 'a=[1']) assertError(assert, source, 'E_SYNTAX');
    assertParse(assert, 'a=["]", ","]', { a: [']', ','] });
});

test('H01-H11 tables, headers and dotted definitions', () => {
    assertParse(assert, '[output]\nquality=90', { output: { quality: 90 } });
    assertParse(assert, '[a.b]\nx=1\n[a]\ny=2', { a: { b: { x: 1 }, y: 2 } });
    assertError(assert, '[a]\n[a]', 'E_TABLE_REDEFINITION');
    assertError(assert, 'a=1\n[a]', 'E_TYPE_CONFLICT');
    assertError(assert, 'a=[]\n[a]', 'E_TYPE_CONFLICT');
    assertParse(assert, '[a]\nx=1\n[b]\nx=2', { a: { x: 1 }, b: { x: 2 } });
    for (const source of ['[a] x=1', '[a', '[a]]']) assertError(assert, source, 'E_SYNTAX');
    assertParse(assert, 'a.b=1\na.c=2', { a: { b: 1, c: 2 } });
    assertError(assert, 'a.b=1\n[a]', 'E_TABLE_REDEFINITION');
    assertParse(assert, 'a.b=1\n[a.c]\nx=2', { a: { b: 1, c: { x: 2 } } });
    assertError(assert, '[a.b]\nx=1\n[a]\nb.y=2', 'E_TABLE_REDEFINITION');
    assertParse(assert, '[a.b.c]\nx=1\n[a]\nb.y=2', { a: { b: { c: { x: 1 }, y: 2 } } });
    assertError(assert, '[a.b.c]\nx=1\n[a]\nb.y=2\n[a.b]\nz=3', 'E_TABLE_REDEFINITION');
});

test('I01-I08 inline tables, nested values and closure rules', () => {
    assertParse(assert, 'a={}\nb={x=1,y="v"}', { a: {}, b: { x: 1, y: 'v' } });
    assertParse(assert, 'a={b.c=1,b.d=2}', { a: { b: { c: 1, d: 2 } } });
    for (const source of ['a={x=1,}', 'a={x=1,\ny=2}', 'a={x=1, #comment\ny=2}']) assertError(assert, source, 'E_SYNTAX');
    assertParse(assert, 'a={b=[\n1, # comment\n2\n]}', { a: { b: [1, 2] } });
    assertError(assert, 'a={b={c=1},b.d=2}', 'E_INLINE_EXTENSION');
    assertError(assert, 'a={b=1}\na.c=2', 'E_INLINE_EXTENSION');
    assertError(assert, 'a={b=1}\n[a.c]', 'E_INLINE_EXTENSION');
    assertError(assert, 'a.b=1\na={c=2}', 'E_DUPLICATE_KEY');
    assertError(assert, 'a={b=1,b=2}', 'E_DUPLICATE_KEY');
    const { api } = loadToml();
    const result = api.parse('a={type="local-date",value="2026-09-23"}\nd=2026-09-23');
    assert.equal(api.isTemporal(result.a), false);
    assert.equal(api.isTemporal(result.d), true);
    assertParse(assert, 'a={b="""\ntext\n"""}', { a: { b: 'text\n' } });
});

test('Q01-Q07 arrays of tables and independent child tables', () => {
    assertParse(assert, '[[items]]\nid=1\n[[items]]\nid=2', { items: [{ id: 1 }, { id: 2 }] });
    assertParse(assert, '[[items]]\n[[items]]', { items: [{}, {}] });
    assertParse(assert, '[[items]]\nid=1\n[items.meta]\nlabel="first"\n[[items]]\nid=2\n[items.meta]\nlabel="second"', {
        items: [{ id: 1, meta: { label: 'first' } }, { id: 2, meta: { label: 'second' } }]
    });
    assertParse(assert, '[[a]]\n[[a.b]]\nx=1\n[[a.b]]\nx=2\n[[a]]\n[[a.b]]\nx=3', {
        a: [{ b: [{ x: 1 }, { x: 2 }] }, { b: [{ x: 3 }] }]
    });
    for (const source of ['items=[]\n[[items]]', '[items]\n[[items]]', '[[items]]\n[items]']) assertError(assert, source, 'E_TYPE_CONFLICT');
    assertParse(assert, '[[items]]\n[items.meta]\nx=1\n[[items]]\n[items.meta]\nx=2', { items: [{ meta: { x: 1 } }, { meta: { x: 2 } }] });
    assertError(assert, '[items.meta]\nx=1\n[[items]]', 'E_TYPE_CONFLICT');
    assertError(assert, '[[a.b]]\nx=1\n[a]\nb.y=2', 'E_TABLE_REDEFINITION');
});

test('L01-L05 limits, prototype safety, and depth boundaries', () => {
    assertError(assert, '__proto__=1', 'E_UNSUPPORTED_KEY');
    const safe = loadToml().api.parse('constructor=1\nprototype=2\ntoString=3\nhasOwnProperty=4');
    for (const key of ['constructor', 'prototype', 'toString', 'hasOwnProperty']) assert.equal(Object.prototype.hasOwnProperty.call(safe, key), true);
    for (const depth of [64, 65]) {
        const array = 'a=' + '['.repeat(depth) + '0' + ']'.repeat(depth);
        if (depth === 64) assert.doesNotThrow(() => loadToml().api.parse(array));
        else assertError(assert, array, 'E_DEPTH_LIMIT');
        const inline = 'a=' + '{x='.repeat(depth) + '0' + '}'.repeat(depth);
        if (depth === 64) assert.doesNotThrow(() => loadToml().api.parse(inline));
        else assertError(assert, inline, 'E_DEPTH_LIMIT');
        const header = '[' + Array.from({ length: depth }, (_, i) => 'k' + i).join('.') + ']';
        if (depth === 64) assert.doesNotThrow(() => loadToml().api.parse(header));
        else assertError(assert, header, 'E_DEPTH_LIMIT');
    }
    for (const parts of [65, 66]) {
        const dotted = Array.from({ length: parts }, (_, i) => 'k' + i).join('.') + '=1';
        if (parts === 65) assert.doesNotThrow(() => loadToml().api.parse(dotted));
        else assertError(assert, dotted, 'E_DEPTH_LIMIT');
    }
    for (const parentDepth of [62, 63]) {
        const parent = Array.from({ length: parentDepth }, (_, i) => 'k' + i).join('.');
        const source = '[' + parent + ']\n[[' + parent + '.items]]';
        if (parentDepth === 62) assert.doesNotThrow(() => loadToml().api.parse(source));
        else assertError(assert, source, 'E_DEPTH_LIMIT');
    }
    const nestedAot = '[[a]]\n[[a.b]]\n[[a.b.c]]\nx=1';
    const { api } = loadToml();
    assert.deepStrictEqual(toNative(api.parse(nestedAot), api), {
        a: [{ b: [{ c: [{ x: 1 }] }] }]
    });
    const prototype = Object.prototype.toString;
    loadToml().api.parse('constructor={x=1}\nprototype=[]');
    assert.equal(Object.prototype.toString, prototype);
    const objectKeys = Object.getOwnPropertyNames(Object.prototype).sort();
    const arrayKeys = Object.getOwnPropertyNames(Array.prototype).sort();
    for (let i = 0; i < 12; i += 1) {
        assert.doesNotThrow(() => api.parse('items=[{constructor="safe"}, 1, 2]'));
        assert.throws(() => api.parse('items=[1,,2]'), (error) => error.name === 'TOMLParseError');
    }
    assert.deepStrictEqual(Object.getOwnPropertyNames(Object.prototype).sort(), objectKeys);
    assert.deepStrictEqual(Object.getOwnPropertyNames(Array.prototype).sort(), arrayKeys);
});

test('X01-X07 error positions use original UTF-16 input offsets', () => {
    assertError(assert, 'a=1\na=2', 'E_DUPLICATE_KEY', { index: 4, line: 2, column: 1 });
    assertError(assert, 'a=1\r\na=2', 'E_DUPLICATE_KEY', { index: 5, line: 2, column: 1 });
    assertError(assert, 'x="\\q"', 'E_ESCAPE', { index: 3, line: 1, column: 4 });
    assertError(assert, 'x = "a', 'E_SYNTAX', { index: 6, line: 1, column: 7 });
    assertError(assert, 'x="\ud83d\ude00" ?', 'E_SYNTAX', { index: 7, line: 1, column: 8 });
    assertError(assert, 'a="\ud83d\ude00"\r\nb=1\r\nb=2', 'E_DUPLICATE_KEY', { index: 13, line: 3, column: 1 });
    assertError(assert, '\ufeff=1', 'E_SYNTAX', { index: 1, line: 1, column: 2 });
    assertError(assert, 'a=1\n\ta=2', 'E_DUPLICATE_KEY', { index: 5, line: 2, column: 2 });
});

test('deterministic malformed inputs never leak internal exceptions', () => {
    const { api } = loadToml();
    const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789=[]{}.,#"\\\'\r\n\t_-:+ ' +
        String.fromCharCode(55296, 56320);
    let seed = 0x5eed1234;
    let accepted = 0;
    let rejected = 0;
    for (let sample = 0; sample < 4096; sample += 1) {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        const length = seed % 96;
        let source = '';
        for (let i = 0; i < length; i += 1) {
            seed = (seed * 1664525 + 1013904223) >>> 0;
            source += alphabet.charAt(seed % alphabet.length);
        }
        try {
            api.parse(source);
            accepted += 1;
        } catch (error) {
            assert.equal(error.name, 'TOMLParseError', 'parser must not leak a host exception');
            assert.match(error.code, /^E_/);
            rejected += 1;
        }
    }
    assert.equal(accepted + rejected, 4096);
    assert.ok(rejected > 0);
});

test('ES3 API surface and single-global loading', () => {
    const { api, context } = loadToml();
    assert.deepStrictEqual(Object.keys(context), ['TOML']);
    assert.equal(typeof api.parse, 'function');
    assert.equal(typeof api.isTemporal, 'function');
});
