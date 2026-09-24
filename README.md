# toml-es3-js

ES3対応のTOML 1.0.0パーサーです。`toml-es3.js` 単一ファイルで動作し、実行時依存はありません。スクリプトとして読み込むと、グローバルの `TOML` を利用できます。

## 使い方

次のTOMLを文字列として読み込み、`tomlText` に渡します。

```toml
title = "Example"
enabled = true
retries = 3
ratio = 0.75
tags = ["web", "api"]
created = 2026-09-24T10:30:00Z
meeting = 2026-09-24T10:30:00
birthday = 2026-09-24
alarm = 10:30:00
options = { cache = true }

[render]
quality = 90

[[servers]]
host = "example.com"
```

```javascript
var config = TOML.parse(tomlText);
```

`config` の内容は次のようになります。日時の値は、ここでは中身をJSON形式で示しています。

```json
{
  "title": "Example",
  "enabled": true,
  "retries": 3,
  "ratio": 0.75,
  "tags": ["web", "api"],
  "created": { "type": "offset-date-time", "value": "2026-09-24T10:30:00Z" },
  "meeting": { "type": "local-date-time", "value": "2026-09-24T10:30:00" },
  "birthday": { "type": "local-date", "value": "2026-09-24" },
  "alarm": { "type": "local-time", "value": "10:30:00" },
  "options": { "cache": true },
  "render": { "quality": 90 },
  "servers": [{ "host": "example.com" }]
}
```

`TOML.parse(text)` は文字列を受け取り、通常のJavaScriptオブジェクトを返します。日時4種は `Date` に変換せず、`type`（`offset-date-time`、`local-date-time`、`local-date`、`local-time`）と入力原文の `value` を持つ専用オブジェクトにします。ファイルの読み込みとUTF-8デコードは呼び出し側で行ってください。解析エラーは `TOMLParseError` として送出され、`code`、`index`、`line`、`column` を持ちます。

## TOML 1.0.0対応

`toml-lang/toml-test` v2.2.0のTOML 1.0.0用ケース679件のうち、必須の678件はすべて通過し、失敗0件です。残る1件はtoml-langが任意としている64ビット整数の境界値のケースです。JavaScriptの `number` で正確に表現できる整数範囲を超えるため、`E_INTEGER_RANGE` で拒否します。

主な制限は次のとおりです。

- 整数はJavaScriptで正確に表現できる範囲（±9,007,199,254,740,991）に限ります。
- `__proto__` キー、64を超えるコンテナ深さ、うるう秒は受け付けません。
- 有限の浮動小数点数がJavaScriptの `number` で無限大にオーバーフローする場合は拒否します。

## テスト

```sh
npm ci
npm test
```
