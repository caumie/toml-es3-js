const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { loadToml, toNative } = require('../helpers/load-toml.cjs');

test('Node integration: parse a representative application configuration', () => {
    const { api } = loadToml();
    const source = [
        'title = "Export job"',
        'enabled = true',
        'formats = ["png", "jpg"]',
        'started = 2026-09-23T10:30:00Z',
        '[[servers]]',
        'name = "primary"',
        '[servers.tls]',
        'enabled = true',
        '[[servers]]',
        'name = "archive"',
        'roles = [{ name = "writer", scopes = ["read", "write"] }]',
        ''
    ].join('\n');
    const result = api.parse(source);
    assert.equal(result.title, 'Export job');
    assert.deepStrictEqual(toNative(result.formats, api), ['png', 'jpg']);
    assert.equal(api.isTemporal(result.started), true);
    assert.deepStrictEqual(toNative(result.servers, api), [
        { name: 'primary', tls: { enabled: true } },
        { name: 'archive', roles: [{ name: 'writer', scopes: ['read', 'write'] }] }
    ]);
});

test('Node integration: errors do not contaminate the next parse', () => {
    const { api } = loadToml();
    const baseline = Object.prototype.toString;
    assert.throws(() => api.parse('x=[1,,2]'), (error) => error.code === 'E_SYNTAX');
    const result = api.parse('x={constructor="safe"}');
    assert.equal(result.x.constructor, 'safe');
    assert.equal(Object.prototype.toString, baseline);
});

test('Node integration: loading never overwrites an existing TOML global', () => {
    const source = fs.readFileSync(path.join(__dirname, '../../toml-es3.js'), 'utf8');
    const existing = { owner: 'application' };
    const context = vm.createContext({ TOML: existing });
    assert.throws(() => vm.runInContext(source, context, { filename: 'toml-es3.js' }), /already defined/);
    assert.equal(context.TOML, existing);
});

test('Node integration: parser works without host globals or ES5 helper APIs', () => {
    const globals = {
        JSON: undefined,
        console: undefined,
        require: undefined,
        process: undefined,
        app: undefined,
        File: undefined
    };
    const originalGlobals = Object.keys(globals);
    const { api, context } = loadToml({
        globals,
        beforeLoad: 'Object.create=undefined; Object.keys=undefined; Object.defineProperty=undefined; ' +
            'Array.isArray=undefined; Array.prototype.forEach=undefined; String.prototype.trim=undefined;'
    });
    assert.deepStrictEqual(toNative(api.parse('answer=42\nitems=[1,2]'), api), { answer: 42, items: [1, 2] });
    assert.deepStrictEqual(Object.keys(context).sort(), [...originalGlobals, 'TOML'].sort());
});

test('Node integration: toml-es3.js is sufficient as the only runtime file', (t) => {
    const sourcePath = path.join(__dirname, '../../toml-es3.js');
    const source = fs.readFileSync(sourcePath, 'utf8');
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'toml-es3-js-single-file-'));
    const copyPath = path.join(folder, 'toml-es3.js');
    fs.copyFileSync(sourcePath, copyPath);
    t.after(() => fs.rmSync(folder, { recursive: true, force: true }));

    const context = vm.createContext({});
    vm.runInContext(fs.readFileSync(copyPath, 'utf8'), context, { filename: 'toml-es3.js', timeout: 1000 });
    assert.equal(context.TOML.parse('answer=42').answer, 42);
    assert.equal(crypto.createHash('sha256').update(source).digest('hex').length, 64);
    assert.deepStrictEqual(Object.keys(context), ['TOML']);
});

test('Node integration: package development tools are not runtime dependencies', () => {
    const packagePath = path.join(__dirname, '../../package.json');
    const packageData = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
    assert.equal(packageData.private, true);
    assert.deepStrictEqual(packageData.dependencies || {}, {});
    assert.deepStrictEqual(packageData.optionalDependencies || {}, {});
});

test('Node integration: UTF-8 configuration files are decoded by the caller', (t) => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'toml-es3-js-utf8-'));
    t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
    const filename = path.join(folder, 'settings.toml');
    fs.writeFileSync(filename, 'title = "日本語 😀"\n', 'utf8');
    const source = fs.readFileSync(filename, 'utf8');
    const { api } = loadToml();
    assert.equal(api.parse(source).title, '日本語 😀');
});
