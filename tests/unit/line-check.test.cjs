const test = require('node:test');
const assert = require('node:assert/strict');
const { countLines, assertLineLimit } = require('../../scripts/check-lines.cjs');

test('line checker counts empty, terminated, and unterminated sources', () => {
    assert.equal(countLines(''), 0);
    assert.equal(countLines('a\nb\n'), 2);
    assert.equal(countLines('a\r\nb'), 2);
});

test('line checker accepts its limit and rejects one line over', () => {
    assert.equal(assertLineLimit('a\nb', 2, 'fixture.js'), 2);
    assert.throws(() => assertLineLimit('a\nb\nc', 2, 'fixture.js'), /3 lines exceeds 2/);
});
