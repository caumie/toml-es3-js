var TOML = (function () {
    // Public API and private temporal identity.
    // Temporal values remain distinguishable without exposing their constructor.
    if (typeof TOML !== "undefined") throw new Error("Global TOML is already defined");

    function TemporalValue(type, value) {
        this.type = type;
        this.value = value;
    }

    function isTemporal(value) {
        return value instanceof TemporalValue;
    }

    function parse(text) {
        var parser;
        if (typeof text !== "string") {
            var inputError = new Error("TOML input must be a primitive string");
            inputError.name = "TOMLParseError";
            inputError.code = "E_INPUT_TYPE";
            inputError.index = 0;
            inputError.line = 1;
            inputError.column = 1;
            throw inputError;
        }
        parser = createParser(text);
        return parser.readDocument();
    }

    // Parse-local state and error coordinates.
    // A fresh cursor and table graph keep calls independent and reentrant.
    function createParser(text) {
        var index = 0;
        var line = 1;
        var column = 1;
        var length = text.length;
        var root;
        var current;
        var MAX_DEPTH = 64;
        var MAX_SAFE_INTEGER = 9007199254740991;
        var hasOwn = Object.prototype.hasOwnProperty;

        function own(object, key) {
            return hasOwn.call(object, key);
        }

        function makeError(code, message, at) {
            var position = at;
            var errorLine = 1;
            var errorColumn = 1;
            var i = 0;
            var ch;
            if (position < 0) position = 0;
            if (position > length) position = length;
            while (i < position) {
                ch = text.charAt(i);
                if (ch === "\r" && i + 1 < position && text.charAt(i + 1) === "\n") {
                    i += 2;
                    errorLine += 1;
                    errorColumn = 1;
                } else if (ch === "\r" || ch === "\n") {
                    i += 1;
                    errorLine += 1;
                    errorColumn = 1;
                } else {
                    i += 1;
                    errorColumn += 1;
                }
            }
            var error = new Error(message);
            error.name = "TOMLParseError";
            error.code = code;
            error.index = position;
            error.line = errorLine;
            error.column = errorColumn;
            return error;
        }

        function fail(code, message, at) {
            throw makeError(code, message, at === undefined ? index : at);
        }

        // Cursor primitives preserve original UTF-16 offsets while normalizing CRLF reads.
        function peek(offset) {
            return text.charAt(index + (offset || 0));
        }

        function starts(value) {
            return text.substr(index, value.length) === value;
        }

        function advance() {
            var ch = text.charAt(index);
            if (ch === "\r") {
                index += 2;
                line += 1;
                column = 1;
                return "\n";
            }
            index += 1;
            if (ch === "\n") {
                line += 1;
                column = 1;
            } else {
                column += 1;
            }
            return ch;
        }

        function isHorizontal(ch) {
            return ch === " " || ch === "\t";
        }

        function isBareKeyChar(ch) {
            return (ch >= "A" && ch <= "Z") || (ch >= "a" && ch <= "z") ||
                (ch >= "0" && ch <= "9") || ch === "_" || ch === "-";
        }

        function isDigit(ch) {
            return ch >= "0" && ch <= "9";
        }

        function isHexDigit(ch) {
            return isDigit(ch) || (ch >= "A" && ch <= "F") || (ch >= "a" && ch <= "f");
        }

        // Document trivia is separate from array trivia because inline tables stay single-line.
        function skipHorizontal() {
            while (isHorizontal(peek())) advance();
        }

        function skipComment() {
            var code;
            if (peek() !== "#") return;
            while (index < length && peek() !== "\n" && peek() !== "\r") {
                code = text.charCodeAt(index);
                if ((code >= 0 && code <= 8) || (code >= 10 && code <= 31) || code === 127) {
                    fail("E_SYNTAX", "Control character is not permitted in a comment");
                }
                advance();
            }
        }

        function skipArrayTrivia() {
            while (true) {
                if (isHorizontal(peek()) || peek() === "\n" || peek() === "\r") {
                    advance();
                } else if (peek() === "#") {
                    skipComment();
                } else {
                    return;
                }
            }
        }

        function skipTopTrivia() {
            while (true) {
                skipHorizontal();
                if (peek() === "#") {
                    skipComment();
                    if (peek() === "\n" || peek() === "\r") advance();
                } else if (peek() === "\n" || peek() === "\r") {
                    advance();
                } else {
                    return;
                }
            }
        }

        function finishStatement() {
            skipHorizontal();
            if (peek() === "#") skipComment();
            if (peek() === "\n" || peek() === "\r") advance();
            else if (index < length) fail("E_SYNTAX", "Expected a newline or end of input");
        }

        // Validate source-wide Unicode and newline rules before token parsing begins.
        function validateSource() {
            var i = 0;
            var code;
            var next;
            while (i < length) {
                code = text.charCodeAt(i);
                if (code >= 55296 && code <= 56319) {
                    next = i + 1 < length ? text.charCodeAt(i + 1) : 0;
                    if (next < 56320 || next > 57343) fail("E_UNICODE", "Unpaired high surrogate", i);
                    i += 2;
                } else if (code >= 56320 && code <= 57343) {
                    fail("E_UNICODE", "Unpaired low surrogate", i);
                } else if (code === 13) {
                    if (i + 1 >= length || text.charCodeAt(i + 1) !== 10) {
                        fail("E_SYNTAX", "Only LF and CRLF newlines are supported", i);
                    }
                    i += 2;
                } else {
                    i += 1;
                }
            }
        }

        // Keep definition metadata beside, not inside, the object returned to callers.
        function newTable(state, depth) {
            if (depth > MAX_DEPTH) fail("E_DEPTH_LIMIT", "Container nesting exceeds 64 levels");
            return {
                value: {},
                entries: {},
                state: state,
                depth: depth
            };
        }

        function slotFor(key) {
            return "$" + key;
        }

        // Buffer string output in bounded chunks to avoid repeated large-string copying.
        function newTextBuffer() {
            return { chunks: [], pending: "" };
        }

        function appendText(buffer, value) {
            if (!value) return;
            buffer.pending += value;
            if (buffer.pending.length >= 1024) {
                buffer.chunks.push(buffer.pending);
                buffer.pending = "";
            }
        }

        function finishText(buffer) {
            if (buffer.pending) buffer.chunks.push(buffer.pending);
            return buffer.chunks.join("");
        }

        // Decode Unicode escapes as scalar values and construct UTF-16 pairs explicitly.
        function readHex(count, escapeAt) {
            var value = 0;
            var i;
            var ch;
            var digit;
            for (i = 0; i < count; i += 1) {
                ch = peek();
                if (!isHexDigit(ch)) fail("E_ESCAPE", "Invalid Unicode escape", escapeAt);
                if (ch >= "0" && ch <= "9") digit = ch.charCodeAt(0) - 48;
                else if (ch >= "A" && ch <= "F") digit = ch.charCodeAt(0) - 55;
                else digit = ch.charCodeAt(0) - 87;
                value = value * 16 + digit;
                advance();
            }
            return value;
        }

        function scalarToString(value, escapeAt) {
            var high;
            var low;
            if (value > 1114111 || (value >= 55296 && value <= 57343)) {
                fail("E_UNICODE", "Unicode escape is not a scalar value", escapeAt);
            }
            if (value <= 65535) return String.fromCharCode(value);
            value -= 65536;
            high = 55296 + Math.floor(value / 1024);
            low = 56320 + (value - Math.floor(value / 1024) * 1024);
            return String.fromCharCode(high) + String.fromCharCode(low);
        }

        function readBasicEscape(multiline) {
            var escapeAt = index;
            var ch;
            var value;
            advance();
            ch = peek();
            if (ch === "b") { advance(); return "\b"; }
            if (ch === "t") { advance(); return "\t"; }
            if (ch === "n") { advance(); return "\n"; }
            if (ch === "f") { advance(); return "\f"; }
            if (ch === "r") { advance(); return "\r"; }
            if (ch === '"') { advance(); return '"'; }
            if (ch === "\\") { advance(); return "\\"; }
            if (ch === "u") {
                advance();
                value = readHex(4, escapeAt);
                return scalarToString(value, escapeAt);
            }
            if (ch === "U") {
                advance();
                value = readHex(8, escapeAt);
                return scalarToString(value, escapeAt);
            }
            if (multiline && (ch === "\n" || ch === "\r" || isHorizontal(ch))) {
                while (isHorizontal(peek())) advance();
                if (peek() !== "\n" && peek() !== "\r") {
                    fail("E_ESCAPE", "Line continuation requires a newline", escapeAt);
                }
                advance();
                while (isHorizontal(peek()) || peek() === "\n" || peek() === "\r") advance();
                return "";
            }
            fail("E_ESCAPE", "Unknown or incomplete string escape", escapeAt);
        }

        function checkStringCode(code, multiline, quoteAt) {
            if (multiline && code === 13 && text.charAt(index + 1) === "\n") return;
            if (code === 127 || (code < 32 && code !== 9 && !(multiline && code === 10))) {
                fail("E_SYNTAX", "Control character is not permitted in a string", quoteAt);
            }
        }

        // Read all four TOML string forms while applying form-specific quote and newline rules.
        function readString(isKey) {
            var quote = peek();
            var quoteAt = index;
            var multiline;
            var basic;
            var value = newTextBuffer();
            var run;
            var i;
            var ch;

            if (quote !== '"' && quote !== "'") fail("E_SYNTAX", "Expected a quoted string");
            basic = quote === '"';
            multiline = starts(quote + quote + quote);
            if (multiline && isKey) fail("E_SYNTAX", "Multiline strings cannot be used as keys", quoteAt);
            if (multiline) {
                advance(); advance(); advance();
                if (peek() === "\n" || peek() === "\r") advance();
                while (index < length) {
                    ch = peek();
                    if (ch === "\\" && basic) {
                        appendText(value, readBasicEscape(true));
                    } else if (ch === quote) {
                        run = 0;
                        while (peek(run) === quote) run += 1;
                        if (run >= 3) {
                            if (run > 5) fail("E_SYNTAX", "Too many consecutive quotes in a multiline string");
                            for (i = 0; i < run - 3; i += 1) appendText(value, quote);
                            for (i = 0; i < run; i += 1) advance();
                            return finishText(value);
                        }
                        appendText(value, advance());
                    } else {
                        checkStringCode(text.charCodeAt(index), true, quoteAt);
                        appendText(value, advance());
                    }
                }
                fail("E_SYNTAX", "Unterminated multiline string", length);
            }

            advance();
            while (index < length) {
                ch = peek();
                if (ch === quote) {
                    advance();
                    return finishText(value);
                }
                if (ch === "\n" || ch === "\r") fail("E_SYNTAX", "Newline in a single-line string");
                if (ch === "\\" && basic) {
                    appendText(value, readBasicEscape(false));
                } else {
                    checkStringCode(text.charCodeAt(index), false, quoteAt);
                    appendText(value, advance());
                }
            }
            fail("E_SYNTAX", "Unterminated string", length);
        }

        function readKeyPart() {
            var start = index;
            var key;
            var ch;
            if (peek() === '"' || peek() === "'") {
                key = readString(true);
            } else {
                while (isBareKeyChar(peek())) advance();
                key = text.substring(start, index);
                if (key.length === 0) fail("E_SYNTAX", "Expected a key");
            }
            if (key === "__proto__") fail("E_UNSUPPORTED_KEY", "The __proto__ key is not supported", start);
            return key;
        }

        function readKeyPath() {
            var parts = [];
            skipHorizontal();
            parts.push(readKeyPart());
            while (true) {
                skipHorizontal();
                if (peek() !== ".") return parts;
                advance();
                skipHorizontal();
                parts.push(readKeyPart());
            }
        }

        // Headers resolve from the document root and update explicit/implicit table states.
        function readHeader() {
            var headerAt = index;
            var arrayOfTables = false;
            var parts;
            advance();
            if (peek() === "[") {
                advance();
                arrayOfTables = true;
            }
            skipHorizontal();
            parts = readKeyPath();
            skipHorizontal();
            if (peek() !== "]") fail("E_SYNTAX", "Expected closing table bracket", headerAt);
            advance();
            if (arrayOfTables) {
                if (peek() !== "]") fail("E_SYNTAX", "Expected second closing table bracket", headerAt);
                advance();
            }
            openHeader(parts, arrayOfTables, headerAt);
            finishStatement();
        }

        // Walk absolute header paths, including only the active element of each table array.
        function resolveHeaderParent(parts, headerAt) {
            var table = root;
            var i;
            var key;
            var entry;
            var node;
            for (i = 0; i < parts.length - 1; i += 1) {
                key = parts[i];
                entry = own(table.entries, slotFor(key)) ? table.entries[slotFor(key)] : null;
                if (!entry) {
                    node = newTable("implicit", table.depth + 1);
                    entry = { kind: "table", value: node.value, node: node };
                    table.entries[slotFor(key)] = entry;
                    table.value[key] = node.value;
                    table = node;
                } else if (entry.kind === "table") {
                    node = entry.node;
                    if (node.state === "inline-closed") fail("E_INLINE_EXTENSION", "Cannot extend a closed inline table", headerAt);
                    table = node;
                } else if (entry.kind === "aot") {
                    if (!entry.elements.length) fail("E_TYPE_CONFLICT", "Table array has no elements", headerAt);
                    table = entry.elements[entry.elements.length - 1];
                } else {
                    fail("E_TYPE_CONFLICT", "Header path crosses a non-table value", headerAt);
                }
            }
            return table;
        }

        // Apply explicit-table and table-array transitions after all parent checks succeed.
        function openHeader(parts, arrayOfTables, headerAt) {
            var parent = resolveHeaderParent(parts, headerAt);
            var key = parts[parts.length - 1];
            var slot = slotFor(key);
            var entry = own(parent.entries, slot) ? parent.entries[slot] : null;
            var node;

            if (arrayOfTables) {
                if (!entry) {
                    if (parent.depth + 2 > MAX_DEPTH) fail("E_DEPTH_LIMIT", "Container nesting exceeds 64 levels", headerAt);
                    node = newTable("aot-element", parent.depth + 2);
                    entry = { kind: "aot", value: [], elements: [] };
                    parent.entries[slot] = entry;
                    parent.value[key] = entry.value;
                } else if (entry.kind !== "aot") {
                    if (entry.kind === "table" && entry.node.state === "inline-closed") {
                        fail("E_INLINE_EXTENSION", "Cannot extend a closed inline table", headerAt);
                    }
                    fail("E_TYPE_CONFLICT", "Table array conflicts with an existing value", headerAt);
                }
                if (entry.value.length === 0 && entry.elements.length === 0) {
                    node = newTable("aot-element", parent.depth + 2);
                } else {
                    if (parent.depth + 2 > MAX_DEPTH) fail("E_DEPTH_LIMIT", "Container nesting exceeds 64 levels", headerAt);
                    node = newTable("aot-element", parent.depth + 2);
                }
                entry.elements.push(node);
                entry.value.push(node.value);
                current = node;
                return;
            }

            if (!entry) {
                node = newTable("explicit", parent.depth + 1);
                parent.entries[slot] = { kind: "table", value: node.value, node: node };
                parent.value[key] = node.value;
                current = node;
            } else if (entry.kind === "table") {
                node = entry.node;
                if (node.state === "implicit") {
                    node.state = "explicit";
                    current = node;
                } else if (node.state === "inline-closed") {
                    fail("E_INLINE_EXTENSION", "Cannot extend a closed inline table", headerAt);
                } else if (node.state === "dotted" || node.state === "explicit") {
                    fail("E_TABLE_REDEFINITION", "Table is already defined", headerAt);
                } else {
                    fail("E_TYPE_CONFLICT", "Table header conflicts with an existing value", headerAt);
                }
            } else if (entry.kind === "aot") {
                fail("E_TYPE_CONFLICT", "Table header conflicts with a table array", headerAt);
            } else {
                fail("E_TYPE_CONFLICT", "Table header conflicts with an existing value", headerAt);
            }
        }

        // Dotted assignments may create implicit tables but cannot reopen declared tables.
        function resolveAssignmentParent(table, parts, keyAt) {
            var i;
            var key;
            var slot;
            var entry;
            var node;
            for (i = 0; i < parts.length - 1; i += 1) {
                key = parts[i];
                slot = slotFor(key);
                if (table.state === "inline-closed") fail("E_INLINE_EXTENSION", "Cannot extend a closed inline table", keyAt);
                entry = own(table.entries, slot) ? table.entries[slot] : null;
                if (!entry) {
                    node = newTable("dotted", table.depth + 1);
                    entry = { kind: "table", value: node.value, node: node };
                    table.entries[slot] = entry;
                    table.value[key] = node.value;
                    table = node;
                } else if (entry.kind === "table") {
                    node = entry.node;
                    if (node.state === "inline-closed") fail("E_INLINE_EXTENSION", "Cannot extend a closed inline table", keyAt);
                    if (node.state === "implicit") node.state = "dotted";
                    if (node.state === "explicit" || node.state === "aot-element") {
                        fail("E_TABLE_REDEFINITION", "Dotted key cannot redefine a declared table", keyAt);
                    }
                    table = node;
                } else if (entry.kind === "aot") {
                    fail("E_TABLE_REDEFINITION", "Dotted key cannot redefine a table array", keyAt);
                } else {
                    fail("E_TYPE_CONFLICT", "Dotted key path crosses a non-table value", keyAt);
                }
            }
            if (table.state === "inline-closed") fail("E_INLINE_EXTENSION", "Cannot extend a closed inline table", keyAt);
            return table;
        }

        // Assignments resolve from the active table and reject duplicate or closed paths.
        function assignValue(table, parts, entry, keyAt) {
            var parent = resolveAssignmentParent(table, parts, keyAt);
            var key = parts[parts.length - 1];
            var slot = slotFor(key);
            if (own(parent.entries, slot)) fail("E_DUPLICATE_KEY", "Key is already defined", keyAt);
            parent.entries[slot] = entry;
            parent.value[key] = entry.value;
        }

        // Container readers own their separators, trivia rules, and absolute depth checks.
        function readArray(parentDepth) {
            var arrayAt = index;
            var arrayDepth = parentDepth + 1;
            var values = [];
            if (arrayDepth > MAX_DEPTH) fail("E_DEPTH_LIMIT", "Container nesting exceeds 64 levels", arrayAt);
            advance();
            skipArrayTrivia();
            if (peek() === "]") {
                advance();
                return { kind: "array", value: values };
            }
            while (index < length) {
                values.push(readValue(arrayDepth).value);
                skipArrayTrivia();
                if (peek() === "]") {
                    advance();
                    return { kind: "array", value: values };
                }
                if (peek() !== ",") fail("E_SYNTAX", "Expected comma or closing array bracket");
                advance();
                skipArrayTrivia();
                if (peek() === "]") {
                    advance();
                    return { kind: "array", value: values };
                }
                if (index >= length) break;
            }
            fail("E_SYNTAX", "Unterminated array", length);
        }

        function readInlineTable(parentDepth) {
            var inlineAt = index;
            var node = newTable("inline-open", parentDepth + 1);
            advance();
            skipHorizontal();
            if (peek() === "}") {
                advance();
                node.state = "inline-closed";
                return { kind: "table", value: node.value, node: node };
            }
            while (index < length) {
                var keyAt = index;
                var parts = readKeyPath();
                skipHorizontal();
                if (peek() !== "=") fail("E_SYNTAX", "Expected equals sign in inline table");
                advance();
                skipHorizontal();
                assignValue(node, parts, readValue(node.depth), keyAt);
                skipHorizontal();
                if (peek() === "}") {
                    advance();
                    node.state = "inline-closed";
                    return { kind: "table", value: node.value, node: node };
                }
                if (peek() !== ",") fail("E_SYNTAX", "Expected comma or closing inline-table brace");
                advance();
                skipHorizontal();
                if (peek() === "}") fail("E_SYNTAX", "Trailing comma in inline table");
            }
            fail("E_SYNTAX", "Unterminated inline table", length);
        }

        // Validate number grammar before conversion and bound integers before arithmetic rounds.
        function readNumber(token, at) {
            var decimalInteger = /^[+-]?(?:0|[1-9](?:_?[0-9])*)$/;
            var decimalFloat = /^[+-]?(?:0|[1-9](?:_?[0-9])*)(?:\.[0-9](?:_?[0-9])*)?(?:[eE][+-]?[0-9](?:_?[0-9])*)?$/;
            var basePattern;
            var sign = 1;
            var body = token;
            var base;
            var digits;
            var value = 0;
            var i;
            var code;
            var digit;
            var normalized;
            var number;

            if (/^[+-]?inf$/.test(token)) {
                return { kind: "scalar", value: token.charAt(0) === "-" ? -1 / 0 : 1 / 0 };
            }
            if (/^[+-]?nan$/.test(token)) return { kind: "scalar", value: 0 / 0 };

            if (body.charAt(0) === "+" || body.charAt(0) === "-") {
                if (body.charAt(0) === "-") sign = -1;
                body = body.substring(1);
            }
            if (/^0x/.test(body)) {
                if (sign < 0 || token.charAt(0) === "+") fail("E_NUMBER", "Sign is not allowed on a based integer", at);
                base = 16; digits = body.substring(2); basePattern = /^[0-9A-Fa-f](?:_?[0-9A-Fa-f])*$/;
            } else if (/^0o/.test(body)) {
                if (sign < 0 || token.charAt(0) === "+") fail("E_NUMBER", "Sign is not allowed on a based integer", at);
                base = 8; digits = body.substring(2); basePattern = /^[0-7](?:_?[0-7])*$/;
            } else if (/^0b/.test(body)) {
                if (sign < 0 || token.charAt(0) === "+") fail("E_NUMBER", "Sign is not allowed on a based integer", at);
                base = 2; digits = body.substring(2); basePattern = /^[01](?:_?[01])*$/;
            }

            if (base) {
                if (!basePattern.test(digits)) fail("E_NUMBER", "Invalid based integer", at);
                digits = digits.replace(/_/g, "");
                for (i = 0; i < digits.length; i += 1) {
                    code = digits.charCodeAt(i);
                    if (code >= 48 && code <= 57) digit = code - 48;
                    else if (code >= 65 && code <= 70) digit = code - 55;
                    else digit = code - 87;
                    if (value > Math.floor((MAX_SAFE_INTEGER - digit) / base)) {
                        fail("E_INTEGER_RANGE", "Integer exceeds the exact JavaScript range", at);
                    }
                    value = value * base + digit;
                }
                return { kind: "scalar", value: value };
            }

            if (!decimalFloat.test(token)) fail("E_NUMBER", "Invalid numeric literal", at);
            if (!decimalInteger.test(token)) {
                normalized = token.replace(/_/g, "");
                number = Number(normalized);
                if (!isFinite(number)) fail("E_FLOAT_RANGE", "Finite float overflows JavaScript Number", at);
                return { kind: "scalar", value: number };
            }

            normalized = token.replace(/_/g, "");
            if (normalized.charAt(0) === "+" || normalized.charAt(0) === "-") normalized = normalized.substring(1);
            for (i = 0; i < normalized.length; i += 1) {
                digit = normalized.charCodeAt(i) - 48;
                if (value > Math.floor((MAX_SAFE_INTEGER - digit) / 10)) {
                    fail("E_INTEGER_RANGE", "Integer exceeds the exact JavaScript range", at);
                }
                value = value * 10 + digit;
            }
            if (sign < 0 && value !== 0) value = -value;
            return { kind: "scalar", value: value };
        }

        // Validate calendar and clock fields directly; never use Date or host time zones.
        function validDate(year, month, day) {
            var days;
            if (month < 1 || month > 12 || day < 1) return false;
            if (month === 2) {
                days = (year % 400 === 0 || (year % 4 === 0 && year % 100 !== 0)) ? 29 : 28;
            } else if (month === 4 || month === 6 || month === 9 || month === 11) {
                days = 30;
            } else {
                days = 31;
            }
            return day <= days;
        }

        function readDateTime(token, at) {
            var datePattern = /^(\d{4})-(\d{2})-(\d{2})$/;
            var timePattern = /^(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?$/;
            var dateTimePattern = /^(\d{4}-\d{2}-\d{2})[Tt ](\d{2}:\d{2}:\d{2}(?:\.\d+)?)([Zz]|[+-]\d{2}:\d{2})?$/;
            var dateMatch = datePattern.exec(token);
            var timeMatch;
            var dateTimeMatch;
            var type;
            var dateParts;
            var timeParts;
            var offset;
            var hour;
            var minute;
            var second;

            if (dateMatch) {
                dateParts = [Number(dateMatch[1]), Number(dateMatch[2]), Number(dateMatch[3])];
                if (!validDate(dateParts[0], dateParts[1], dateParts[2])) fail("E_DATE_TIME", "Invalid calendar date", at);
                type = "local-date";
            } else {
                dateTimeMatch = dateTimePattern.exec(token);
                if (dateTimeMatch) {
                    dateMatch = datePattern.exec(dateTimeMatch[1]);
                    dateParts = [Number(dateMatch[1]), Number(dateMatch[2]), Number(dateMatch[3])];
                    if (!validDate(dateParts[0], dateParts[1], dateParts[2])) fail("E_DATE_TIME", "Invalid calendar date", at);
                    timeMatch = timePattern.exec(dateTimeMatch[2]);
                    offset = dateTimeMatch[3];
                    type = offset ? "offset-date-time" : "local-date-time";
                } else {
                    timeMatch = timePattern.exec(token);
                    type = "local-time";
                }
                if (!timeMatch) fail("E_DATE_TIME", "Invalid date-time value", at);
                timeParts = [Number(timeMatch[1]), Number(timeMatch[2]), Number(timeMatch[3])];
                hour = timeParts[0];
                minute = timeParts[1];
                second = timeParts[2];
                if (hour > 23 || minute > 59 || second > 60) fail("E_DATE_TIME", "Time component is out of range", at);
                if (second === 60) fail("E_UNSUPPORTED_LEAP_SECOND", "Leap seconds are not supported", at);
                if (offset && offset !== "Z" && offset !== "z") {
                    var offsetHour = Number(offset.substring(1, 3));
                    var offsetMinute = Number(offset.substring(4, 6));
                    if (offsetHour > 23 || offsetMinute > 59) fail("E_DATE_TIME", "UTC offset is out of range", at);
                }
            }
            return { kind: "scalar", value: new TemporalValue(type, token) };
        }

        // Dispatch atomic tokens only after scanning to a grammar-owned delimiter.
        function readAtom() {
            var at = index;
            var start = index;
            var token;
            var ch;
            var datePrefix = /^\d{4}-\d{2}-\d{2}$/;
            while (index < length) {
                ch = peek();
                if (ch === "," || ch === "]" || ch === "}" || ch === "#" || ch === ";" || ch === "\n" || ch === "\r") break;
                if (isHorizontal(ch)) {
                    if (ch === " " && datePrefix.test(text.substring(start, index)) && isDigit(peek(1))) {
                        advance();
                    } else {
                        break;
                    }
                } else {
                    advance();
                }
            }
            token = text.substring(start, index);
            if (token.length === 0) fail("E_SYNTAX", "Expected a value", at);
            if (token === "true") return { kind: "scalar", value: true };
            if (token === "false") return { kind: "scalar", value: false };
            if (/^\d{4}-\d{2}-\d{2}/.test(token) || /^\d{2}:\d{2}/.test(token)) return readDateTime(token, at);
            if (/^[+\-]?(?:inf|nan)$/.test(token) || /^[+\-0-9.]/.test(token)) return readNumber(token, at);
            fail("E_SYNTAX", "Unrecognized value", at);
        }

        function readValue(parentDepth) {
            var ch = peek();
            if (ch === '"' || ch === "'") return { kind: "scalar", value: readString(false) };
            if (ch === "[") return readArray(parentDepth);
            if (ch === "{") return readInlineTable(parentDepth);
            return readAtom();
        }

        // The document loop connects statements to the root and returns only public values.
        function readAssignment() {
            var keyAt = index;
            var parts = readKeyPath();
            var value;
            skipHorizontal();
            if (peek() !== "=") fail("E_SYNTAX", "Expected equals sign", keyAt);
            advance();
            skipHorizontal();
            if (peek() === "\n" || peek() === "\r" || peek() === "#" || index >= length) {
                fail("E_SYNTAX", "Expected a value");
            }
            value = readValue(current.depth);
            assignValue(current, parts, value, keyAt);
            finishStatement();
        }

        function readDocument() {
            root = newTable("root", 0);
            current = root;
            validateSource();
            if (peek() === "\ufeff") advance();
            skipTopTrivia();
            while (index < length) {
                if (peek() === "[") readHeader();
                else readAssignment();
                skipTopTrivia();
            }
            return root.value;
        }

        return { readDocument: readDocument };
    }

    return {
        parse: parse,
        isTemporal: isTemporal
    };
}());
