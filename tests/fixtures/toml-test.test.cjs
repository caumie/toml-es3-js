const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { TextDecoder } = require('node:util');
const { loadToml } = require('../helpers/load-toml.cjs');

const base = path.join(__dirname, '../vendor/toml-test/v2.2.0');
const casesRoot = path.join(base, 'tests');
const manifestPath = path.join(base, 'files-toml-1.0.0');
const policyPath = path.join(__dirname, '../toml-test-policy.json');
const manifest = fs.readFileSync(manifestPath, 'utf8');
const manifestHash = crypto.createHash('sha256').update(manifest).digest('hex');
const paths = manifest.split(/\r?\n/).map((item) => item.trim()).filter((item) => item.endsWith('.toml'));
const policy = JSON.parse(fs.readFileSync(policyPath, 'utf8'));
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const { api } = loadToml();
const summary = {
    passed: 0,
    failed: 0,
    inputByteBoundary: { malformedUtf8: 0, validUtf8InvalidToml: 0 },
    classes: {}
};

Object.keys(policy.cases).forEach((fixture) => {
    const className = policy.cases[fixture].class;
    if (!summary.classes[className]) summary.classes[className] = { total: 0, passed: 0, failed: 0 };
    summary.classes[className].total += 1;
});

function daysFromCivil(year, month, day) {
    const adjustedYear = year - (month <= 2 ? 1 : 0);
    const era = Math.floor(adjustedYear / 400);
    const yearOfEra = adjustedYear - era * 400;
    const adjustedMonth = month + (month > 2 ? -3 : 9);
    const dayOfYear = Math.floor((153 * adjustedMonth + 2) / 5) + day - 1;
    const dayOfEra = yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
    return era * 146097 + dayOfEra;
}

function normalizedFraction(fraction) {
    return (fraction || '').replace(/0+$/, '');
}

function normalizedLocalDateTime(value) {
    return value.replace(/^(\d{4}-\d{2}-\d{2})[Tt ]/, '$1T')
        .replace(/\.(\d+)$/, (whole, fraction) => {
            const normalized = normalizedFraction(fraction);
            return normalized ? `.${normalized}` : '';
        });
}

function normalizedLocalTime(value) {
    return value.replace(/\.(\d+)$/, (whole, fraction) => {
        const normalized = normalizedFraction(fraction);
        return normalized ? `.${normalized}` : '';
    });
}

function temporalInstant(value) {
    const match = /^(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?([Zz]|[+-]\d{2}:\d{2})?$/.exec(value);
    assert.ok(match, `invalid temporal value: ${value}`);
    const day = daysFromCivil(Number(match[1]), Number(match[2]), Number(match[3]));
    let seconds = day * 86400 + Number(match[4]) * 3600 + Number(match[5]) * 60 + Number(match[6]);
    const offset = match[8];
    if (offset && offset !== 'Z' && offset !== 'z') {
        const minutes = Number(offset.substring(1, 3)) * 60 + Number(offset.substring(4, 6));
        seconds += offset.charAt(0) === '+' ? -minutes * 60 : minutes * 60;
    }
    return { seconds, fraction: normalizedFraction(match[7]) };
}

function assertTemporal(actual, expected, label) {
    assert.equal(api.isTemporal(actual), true, `${label}: expected a TOML temporal value`);
    const types = {
        datetime: 'offset-date-time',
        'datetime-local': 'local-date-time',
        'date-local': 'local-date',
        'time-local': 'local-time'
    };
    assert.equal(actual.type, types[expected.type], `${label}: temporal type`);
    if (expected.type === 'datetime') {
        assert.deepStrictEqual(temporalInstant(actual.value), temporalInstant(expected.value), `${label}: instant`);
    } else if (expected.type === 'datetime-local') {
        assert.equal(normalizedLocalDateTime(actual.value), normalizedLocalDateTime(expected.value), `${label}: local datetime`);
    } else if (expected.type === 'time-local') {
        assert.equal(normalizedLocalTime(actual.value), normalizedLocalTime(expected.value), `${label}: local time`);
    } else {
        assert.equal(actual.value, expected.value, `${label}: local date`);
    }
}

function assertTaggedValue(actual, expected, label) {
    if (expected && typeof expected === 'object' && !Array.isArray(expected) &&
            Object.prototype.hasOwnProperty.call(expected, 'type') &&
            Object.prototype.hasOwnProperty.call(expected, 'value')) {
        if (expected.type === 'datetime' || expected.type === 'datetime-local' ||
                expected.type === 'date-local' || expected.type === 'time-local') {
            assertTemporal(actual, expected, label);
        } else if (expected.type === 'string') {
            assert.equal(actual, expected.value, label);
        } else if (expected.type === 'bool') {
            assert.equal(actual, expected.value === 'true', label);
        } else if (expected.type === 'integer') {
            const integer = BigInt(expected.value);
            assert.ok(integer <= 9007199254740991n && integer >= -9007199254740991n, `${label}: policy failed to classify unsafe integer`);
            assert.equal(actual, Number(integer), label);
        } else if (expected.type === 'float') {
            const float = expected.value === 'inf' ? Infinity : expected.value === '-inf' ? -Infinity :
                expected.value === 'nan' ? NaN : Number(expected.value);
            assert.equal(actual, float, label);
        } else {
            assert.fail(`${label}: unknown toml-test type ${expected.type}`);
        }
        return;
    }

    if (Array.isArray(expected)) {
        assert.equal(Array.isArray(actual), true, `${label}: expected array`);
        assert.equal(actual.length, expected.length, `${label}: array length`);
        expected.forEach((item, index) => assertTaggedValue(actual[index], item, `${label}[${index}]`));
        return;
    }

    if (expected && typeof expected === 'object') {
        assert.equal(actual && typeof actual === 'object' && !api.isTemporal(actual), true, `${label}: expected table`);
        const actualKeys = Object.keys(actual).sort();
        const expectedKeys = Object.keys(expected).sort();
        assert.deepStrictEqual(actualKeys, expectedKeys, `${label}: table keys`);
        expectedKeys.forEach((key) => assertTaggedValue(actual[key], expected[key], `${label}.${key}`));
        return;
    }
    assert.equal(actual, expected, label);
}

test('toml-test v2.2.0 TOML 1.0 fixtures', async (t) => {
    assert.equal(policy.tomlTest, 'v2.2.0');
    assert.equal(policy.commit, 'ce08da1ddb075d1c7596d663c7fcba9a2ae02c5c');
    assert.equal(policy.tomlVersion, '1.0.0');
    assert.equal(policy.manifestSha256, manifestHash);
    assert.equal(policy.caseCount, paths.length);
    assert.equal(paths.length, new Set(paths).size, 'duplicate manifest entries');
    const unclassified = paths.filter((fixture) => !policy.cases[fixture]);
    const extraPolicy = Object.keys(policy.cases).filter((fixture) => !paths.includes(fixture));
    assert.deepStrictEqual(unclassified, [], 'every selected TOML fixture must be classified');
    assert.deepStrictEqual(extraPolicy, [], 'policy may only name selected fixtures');

    for (const relativePath of paths) {
        const filename = path.join(casesRoot, relativePath);
        const classification = policy.cases[relativePath];
        await t.test(relativePath, () => {
            const classSummary = summary.classes[classification.class];
            try {
                const bytes = fs.readFileSync(filename);
                if (classification.class === 'input-byte-boundary') {
                    let source;
                    try {
                        source = decoder.decode(bytes);
                    } catch (error) {
                        assert.equal(error instanceof TypeError, true, 'malformed UTF-8 decoder error');
                        summary.inputByteBoundary.malformedUtf8 += 1;
                        classSummary.passed += 1;
                        summary.passed += 1;
                        return;
                    }
                    assert.throws(() => api.parse(source), (error) => error.name === 'TOMLParseError',
                        'well-formed UTF-8 that violates the input syntax must be rejected by parse(text)');
                    summary.inputByteBoundary.validUtf8InvalidToml += 1;
                    classSummary.passed += 1;
                    summary.passed += 1;
                    return;
                }

                const source = decoder.decode(bytes);
                if (classification.class === 'implementation-limit') {
                    assert.throws(() => api.parse(source), (error) => {
                        assert.equal(error.name, 'TOMLParseError');
                        assert.equal(error.code, classification.expectedCode);
                        return true;
                    });
                } else if (classification.sourceStatus !== 'valid') {
                    assert.throws(() => api.parse(source), (error) => error.name === 'TOMLParseError');
                } else {
                    const expectedFile = filename.replace(/\.toml$/, '.json');
                    const expected = JSON.parse(fs.readFileSync(expectedFile, 'utf8'));
                    const actual = api.parse(source);
                    assertTaggedValue(actual, expected, relativePath);
                }

                classSummary.passed += 1;
                summary.passed += 1;
            } catch (error) {
                classSummary.failed += 1;
                summary.failed += 1;
                throw error;
            }
        });
    }

    const report = {
        generatedAt: new Date().toISOString(),
        node: process.version,
        platform: process.platform,
        release: os.release(),
        architecture: process.arch,
        parserSha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname, '../../toml-es3.js'))).digest('hex'),
        tomlTest: policy.tomlTest,
        commit: policy.commit,
        manifestSha256: manifestHash,
        total: paths.length,
        passed: summary.passed,
        failed: summary.failed,
        unclassified: unclassified.length,
        classes: summary.classes,
        inputByteBoundary: summary.inputByteBoundary
    };
    const reportPath = path.join(__dirname, '../reports/toml-test-report.json');
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
});
