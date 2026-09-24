const test = require('node:test');
const assert = require('node:assert/strict');
const { checkSource } = require('../../scripts/check-es3.cjs');

test('ES3 checker accepts the project subset', () => {
    assert.doesNotThrow(() => checkSource(
        'var value = "ok"; function read(text) { return text.charAt(0); }',
        'fixture.js'
    ));
});

test('ES3 checker rejects modern syntax', () => {
    assert.throws(() => checkSource('const value = 1;', 'fixture.js'));
});

test('ES3 checker rejects host globals and newer APIs', () => {
    assert.throws(() => checkSource('app.open();', 'fixture.js'), /host or non-ES3 global/);
    assert.throws(() => checkSource('var value; value.trim();', 'fixture.js'), /forbidden API/);
    assert.throws(() => checkSource('Math.max(1, 2);', 'fixture.js'), /Math API is outside/);
    assert.throws(() => checkSource('var value; Array.isArray(value);', 'fixture.js'), /Array static APIs/);
    assert.throws(() => checkSource('Object.create(null);', 'fixture.js'), /Object API is outside/);
    assert.throws(() => checkSource('var name; Math[name]();', 'fixture.js'), /computed access/);
});

test('ES3 checker enforces project subset formatting rules', () => {
    assert.throws(() => checkSource('var values = [1,];', 'fixture.js'), /trailing commas/);
    assert.throws(() => checkSource('function outer() { if (true) { function inner() {} } }', 'fixture.js'), /block function declarations/);
    assert.throws(() => checkSource('function read(text) { return text[0]; }', 'fixture.js'), /string index access/);
});
