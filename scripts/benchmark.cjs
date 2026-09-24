const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const parserPath = path.join(root, 'toml-es3.js');
const parserSource = fs.readFileSync(parserPath, 'utf8');
const parserHash = crypto.createHash('sha256').update(parserSource).digest('hex');
const context = vm.createContext({});
vm.runInContext(parserSource, context, { filename: 'toml-es3.js' });

function makeArrayDocument(targetBytes) {
    const count = Math.max(1, Math.floor((targetBytes - 10) / 2));
    return { source: 'values=[' + Array(count).fill('1').join(',') + ']', count };
}

function median(values) {
    const sorted = values.slice().sort((left, right) => left - right);
    return sorted[Math.floor(sorted.length / 2)];
}

const sizes = [1024, 10240, 102400];
const iterations = 7;
const cases = sizes.map((targetBytes) => {
    const document = makeArrayDocument(targetBytes);
    const measurements = [];
    let result;
    for (let i = 0; i < 2; i += 1) result = context.TOML.parse(document.source);
    for (let i = 0; i < iterations; i += 1) {
        const start = performance.now();
        result = context.TOML.parse(document.source);
        measurements.push(performance.now() - start);
    }
    return {
        targetBytes,
        inputBytes: Buffer.byteLength(document.source, 'utf8'),
        arrayItems: result.values.length,
        iterations,
        medianMilliseconds: Number(median(measurements).toFixed(3)),
        minimumMilliseconds: Number(Math.min.apply(Math, measurements).toFixed(3))
    };
});

const report = {
    generatedAt: new Date().toISOString(),
    node: process.version,
    platform: process.platform,
    release: os.release(),
    architecture: process.arch,
    parserSha256: parserHash,
    cases
};
const outputPath = path.join(root, 'tests/reports/node-benchmark.json');
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
