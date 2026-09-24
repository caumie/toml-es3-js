const fs = require('node:fs');
const path = require('node:path');
const acorn = require('acorn');
const eslintScope = require('eslint-scope');

const sourcePath = path.join(__dirname, '..', 'toml-es3.js');
const allowedGlobals = new Set([
    'Array', 'Error', 'Function', 'Math', 'NaN', 'Number', 'Object',
    'RegExp', 'String', 'Infinity', 'isFinite', 'isNaN', 'parseInt', 'undefined'
]);
const forbiddenProperties = new Set([
    'isArray', 'create', 'keys', 'defineProperty', 'freeze', 'assign',
    'forEach', 'map', 'filter', 'reduce', 'trim', 'bind', 'includes',
    'startsWith', 'endsWith', 'repeat', 'flat', 'fromEntries', 'hasOwn',
    'every', 'some', 'reduceRight', 'lastIndexOf', 'getPrototypeOf',
    'setPrototypeOf', 'defineProperties', 'seal', 'preventExtensions',
    'find', 'findIndex', 'fill', 'copyWithin', 'trimLeft', 'trimRight',
    'normalize', 'codePointAt', 'fromCodePoint', 'matchAll', 'flatMap',
    'values', 'allSettled', 'finally', 'isInteger',
    'isSafeInteger', 'parse', 'raw'
]);
const allowedMathProperties = new Set(['floor', 'abs', 'pow']);

function rootIdentifier(node) {
    while (node && node.type === 'MemberExpression') node = node.object;
    return node && node.type === 'Identifier' ? node.name : null;
}

function walk(node, visit, parent, grandparent) {
    if (!node || typeof node !== 'object') return;
    if (typeof node.type === 'string') visit(node, parent, grandparent);
    Object.keys(node).forEach(function (key) {
        const value = node[key];
        if (Array.isArray(value)) {
            value.forEach(function (child) { walk(child, visit, node, parent); });
        } else if (value && typeof value === 'object' && typeof value.type === 'string') {
            walk(value, visit, node, parent);
        }
    });
}

function checkSource(source, filename) {
    if (/[^\x00-\x7f]/.test(source)) {
        throw new Error(filename + ': implementation source must be ASCII');
    }

    const tokens = [];
    const ast = acorn.parse(source, {
        ecmaVersion: 3,
        sourceType: 'script',
        allowHashBang: false,
        locations: true,
        ranges: true,
        onToken: tokens
    });
    const scopes = eslintScope.analyze(ast, {
        // Acorn already enforces ES3 above; eslint-scope uses ES5 metadata to analyze that AST.
        ecmaVersion: 5,
        sourceType: 'script',
        optimistic: false,
        ignoreEval: false
    });
    const unresolved = scopes.globalScope.through.filter(function (reference) {
        return !allowedGlobals.has(reference.identifier.name);
    });
    if (unresolved.length) {
        const ref = unresolved[0].identifier;
        throw new Error(filename + ':' + ref.loc.start.line + ':' + ref.loc.start.column +
            ': host or non-ES3 global is not allowed: ' + ref.name);
    }

    tokens.forEach(function (token, index) {
        const previous = tokens[index - 1];
        if (previous && previous.type.label === ',' &&
                (token.type.label === ']' || token.type.label === '}')) {
            throw new Error(filename + ':' + token.loc.start.line + ': trailing commas are outside the project subset');
        }
    });

    walk(ast, function (node, parent, grandparent) {
        if (node.type === 'WithStatement' || node.type === 'ForInStatement') {
            throw new Error(filename + ':' + node.loc.start.line + ': ' + node.type + ' is outside the project subset');
        }
        if (node.type === 'FunctionDeclaration' && parent.type !== 'Program' &&
                !(parent.type === 'BlockStatement' && grandparent &&
                    (grandparent.type === 'FunctionDeclaration' || grandparent.type === 'FunctionExpression') &&
                    grandparent.body === parent)) {
            throw new Error(filename + ':' + node.loc.start.line + ': block function declarations are outside the project subset');
        }
        if (node.type === 'MemberExpression' && !node.computed && node.property.type === 'Identifier') {
            let name = node.property.name;
            const root = rootIdentifier(node.object);
            if (root === 'Math' && !allowedMathProperties.has(name)) {
                throw new Error(filename + ':' + node.loc.start.line + ': Math API is outside the project allowlist: ' + name);
            }
            if (root === 'Array') {
                throw new Error(filename + ':' + node.loc.start.line + ': Array static APIs are outside the project allowlist: ' + name);
            }
            if (root === 'String' && !(name === 'fromCharCode' && node.object.type === 'Identifier')) {
                throw new Error(filename + ':' + node.loc.start.line + ': String API is outside the project allowlist: ' + name);
            }
            if (root === 'Object') {
                const isPrototype = name === 'prototype' && node.object.type === 'Identifier';
                const isOwnCheck = name === 'hasOwnProperty' && node.object.type === 'MemberExpression' &&
                    node.object.property.name === 'prototype' && node.object.object.name === 'Object';
                const isCall = name === 'call' && node.object.type === 'MemberExpression' &&
                    node.object.property.name === 'hasOwnProperty';
                if (!isPrototype && !isOwnCheck && !isCall) {
                    throw new Error(filename + ':' + node.loc.start.line + ': Object API is outside the project allowlist: ' + name);
                }
            }
            if (forbiddenProperties.has(name)) {
                throw new Error(filename + ':' + node.loc.start.line + ': forbidden API: ' + name);
            }
        } else if (node.type === 'MemberExpression' && node.computed) {
            if (node.object.type === 'Identifier' && node.object.name === 'text') {
                throw new Error(filename + ':' + node.loc.start.line + ': string index access is outside the project subset: text[index]');
            }
            if (node.object.type === 'Identifier' && ['Math', 'Array', 'Object', 'String'].indexOf(node.object.name) !== -1) {
                throw new Error(filename + ':' + node.loc.start.line + ': computed access to standard APIs is not allowed');
            }
        }
        if (node.type === 'Literal' && node.regex && !/^[gim]*$/.test(node.regex.flags)) {
            throw new Error(filename + ':' + node.loc.start.line + ': non-ES3 regular-expression flag');
        }
    });
    return ast;
}

if (require.main === module) {
    if (!fs.existsSync(sourcePath)) {
        console.error('Missing toml-es3.js');
        process.exitCode = 1;
    } else {
        try {
            const source = fs.readFileSync(sourcePath, 'utf8');
            checkSource(source, 'toml-es3.js');
            console.log('ES3 subset OK: toml-es3.js');
        } catch (error) {
            console.error(error.message);
            process.exitCode = 1;
        }
    }
}

module.exports = { checkSource };
