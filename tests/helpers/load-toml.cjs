const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../../toml-es3.js'), 'utf8');

function loadToml(options = {}) {
    const context = vm.createContext(options.globals || {});
    if (options.beforeLoad) {
        vm.runInContext(options.beforeLoad, context, { filename: 'test-prelude.js', timeout: 1000 });
    }
    vm.runInContext(source, context, { filename: 'toml-es3.js', timeout: 1000 });
    return { api: context.TOML, context };
}

function toNative(value, api) {
    if (api.isTemporal(value)) return { $temporal: value.type, value: value.value };
    if (Array.isArray(value)) return Array.from(value, (item) => toNative(item, api));
    if (value && typeof value === 'object') {
        const result = {};
        Object.keys(value).forEach((key) => {
            Object.defineProperty(result, key, {
                value: toNative(value[key], api), enumerable: true, writable: true, configurable: true
            });
        });
        return result;
    }
    return value;
}

function assertParse(assert, sourceText, expected) {
    const { api } = loadToml();
    assert.deepStrictEqual(toNative(api.parse(sourceText), api), expected);
    return api;
}

function assertError(assert, sourceText, code, position) {
    const { api } = loadToml();
    assert.throws(() => api.parse(sourceText), (error) => {
        assert.equal(error.name, 'TOMLParseError');
        assert.equal(error.code, code);
        if (position) {
            assert.equal(error.index, position.index);
            assert.equal(error.line, position.line);
            assert.equal(error.column, position.column);
        }
        return true;
    });
    return api;
}

module.exports = { loadToml, toNative, assertParse, assertError };
