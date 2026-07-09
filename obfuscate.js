#!/usr/bin/env node
// 重新混淆脚本：从 index.html 提取 JS，用 javascript-obfuscator 混淆，
// 再与原 HTML 头/尾拼接写到 index.obfuscated.html

'use strict';

const fs = require('fs');
const path = require('path');
const JavaScriptObfuscator = require('javascript-obfuscator');

const HTML_FILE = path.join(__dirname, 'index.html');
const OUT_FILE  = path.join(__dirname, 'index.obfuscated.html');

const html = fs.readFileSync(HTML_FILE, 'utf8');

// 提取 <script>...</script> 内的内容
const m = html.match(/<script>([\s\S]*?)<\/script>/);
if (!m) {
    console.error('在 index.html 中找不到 <script>');
    process.exit(1);
}
const jsSource = m[1];

console.log(`[1/3] 提取 JS: ${jsSource.length} 字符`);

const obfuscated = JavaScriptObfuscator.obfuscate(jsSource, {
    compact: true,
    target: 'browser-no-eval',
    identifierNamesGenerator: 'hexadecimal',
    renameGlobals: false,           // 不要重命名 btn/status/copyBtn 等 DOM 操作变量 — 容易出 bug
    renameProperties: false,        // 不要碰对象属性
    selfDefending: true,
    stringArray: true,
    stringArrayThreshold: 0.75,
    stringArrayEncoding: ['base64'],
    stringArrayIndexShift: true,
    stringArrayRotate: true,
    stringArrayShuffle: true,
    transformObjectKeys: true,
    unicodeEscapeSequence: false,
    numbersToExpressions: true,
    simplify: true,
    controlFlowFlattening: true,
    controlFlowFlatteningThreshold: 0.75,
    deadCodeInjection: true,
    deadCodeInjectionThreshold: 0.4
}).getObfuscatedCode();

console.log(`[2/3] 混淆完成: ${obfuscated.length} 字符`);

// 拼接：head(到 <script>) + 混淆 JS + </script>...</body>...</html>
// 把原 <script>...</script> 整段切掉，并在该位置塞回混淆 JS（前后保留 <script> / </script>）
const head = html.slice(0, m.index);
const tail = html.slice(m.index + m[0].length);
const out = head + '<script>\n' + obfuscated + '\n</script>' + tail;

fs.writeFileSync(OUT_FILE, out, 'utf8');
console.log(`[3/3] 写入 ${path.basename(OUT_FILE)}: ${out.length} 字符`);
console.log('完成。');
