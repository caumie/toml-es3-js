const fs = require('node:fs');
const path = require('node:path');

const filename = path.join(__dirname, '..', 'toml-es3.js');
const maximum = 3000;
function countLines(source) {
    if (source.length === 0) return 0;
    return source.split(/\r\n|\r|\n/).length - (/[\r\n]$/.test(source) ? 1 : 0);
}

function assertLineLimit(source, limit, name) {
    const lines = countLines(source);
    if (lines > limit) throw new Error((name || 'source') + ': ' + lines + ' lines exceeds ' + limit);
    return lines;
}

if (require.main === module) {
    if (!fs.existsSync(filename)) {
        console.error('Missing toml-es3.js');
        process.exitCode = 1;
    } else {
        try {
            const lines = assertLineLimit(fs.readFileSync(filename, 'utf8'), maximum, 'toml-es3.js');
            console.log('toml-es3.js: ' + lines + ' / ' + maximum + ' lines');
        } catch (error) {
            console.error(error.message);
            process.exitCode = 1;
        }
    }
}

module.exports = { countLines, assertLineLimit };
