#!/usr/bin/env node
// 授权码生成器
// 用法:
//   node generate.js                 # 交互输入时长
//   node generate.js <hours>         # 直接传入时长
//   node generate.js <hours> --test  # 自检：解密回放验证
//
// 载荷布局（18 字节）：
//   [4B nonce][14B AES-128-CTR 密文]
//   明文（14 字节）：
//     [8B 起始时间戳 uint64 BE]
//     [2B 授权时长   uint16 BE]
//     [2B 版本       uint16 BE]
//     [2B CRC16-CCITT(前 12 字节)]
//
// IV = nonce(4) + 0x00 × 12 = 16 字节
//
// 编码：Base62(18 字节) → 固定 25 字符（5-5-5-5-5 分组显示）

'use strict';

const crypto = require('crypto');
const https = require('https');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const KEY_FILE = path.join(__dirname, 'keys', 'secret.key');
const TIME_API = 'https://timeapi.io/api/Time/current/zone?timeZone=UTC';
const TIMEOUT_MS = 8000;
const VERSION = 0x0001;
const BASE62_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

// CRC16-CCITT (多项式 0x1021, 初值 0xFFFF)
function crc16ccitt(buf) {
    let crc = 0xFFFF;
    for (const b of buf) {
        crc ^= b << 8;
        for (let i = 0; i < 8; i++) {
            crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xFFFF : (crc << 1) & 0xFFFF;
        }
    }
    return crc;
}

function loadKey() {
    if (!fs.existsSync(KEY_FILE)) {
        throw new Error(`密钥文件不存在: ${KEY_FILE}\n请先生成密钥: node -e "require('crypto').randomBytes(16).toString('hex')" > keys/secret.key`);
    }
    const hex = fs.readFileSync(KEY_FILE, 'utf8').trim();
    if (hex.length !== 32 || !/^[0-9a-fA-F]{32}$/.test(hex)) {
        throw new Error(`密钥格式错误: 期望 32 hex 字符 (16 字节)`);
    }
    return Buffer.from(hex, 'hex');
}

// 固定长度 Base62 编码（前导 '0' 字符补齐到 length）
// 18 字节 = 144 bit，144 / log2(62) ≈ 24.19 → 固定 25 字符足够装下
function toBase62(buf, length = 25) {
    let num = 0n;
    for (const b of buf) num = num * 256n + BigInt(b);
    let result = '';
    if (num === 0n) {
        return '0'.repeat(length);
    }
    while (num > 0n) {
        const r = num % 62n;
        num = num / 62n;
        result = BASE62_ALPHABET[Number(r)] + result;
    }
    while (result.length < length) result = '0' + result;
    return result;
}

// 固定长度 Base62 解码（按 expectedBytes 字节拆分，无损恢复前导零）
function fromBase62(str, expectedBytes = 18) {
    let num = 0n;
    for (const c of str) {
        const idx = BASE62_ALPHABET.indexOf(c);
        if (idx < 0) throw new Error(`非法 Base62 字符: ${c}`);
        num = num * 62n + BigInt(idx);
    }
    const bytes = Buffer.alloc(expectedBytes);
    for (let i = 0; i < expectedBytes; i++) {
        const shift = BigInt((expectedBytes - 1 - i) * 8);
        bytes[i] = Number((num >> shift) & 0xFFn);
    }
    return bytes;
}

function fetchServerTime() {
    return new Promise((resolve, reject) => {
        const url = new URL(TIME_API);
        const req = https.get({
            hostname: url.hostname,
            path: url.pathname + url.search,
            timeout: TIMEOUT_MS,
            headers: { 'User-Agent': 'aimbot-license/1.0' }
        }, (res) => {
            if (res.statusCode !== 200) {
                reject(new Error(`API 返回 HTTP ${res.statusCode}`));
                return;
            }
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    if (!json.dateTime) throw new Error('API 返回无 dateTime 字段');
                    const ts = Math.floor(new Date(json.dateTime).getTime() / 1000);
                    if (!Number.isFinite(ts)) throw new Error('时间戳解析失败');
                    resolve(ts);
                } catch (e) {
                    reject(new Error('解析响应失败: ' + e.message));
                }
            });
        });
        req.on('timeout', () => { req.destroy(); reject(new Error(`API 请求超时 (${TIMEOUT_MS}ms)`)); });
        req.on('error', e => reject(new Error(`API 连接失败: ${e.message}`)));
    });
}

async function generate(hours) {
    const key = loadKey();
    const startTs = await fetchServerTime();
    const nonce = crypto.randomBytes(4);
    const iv = Buffer.concat([nonce, Buffer.alloc(12, 0)]);

    const plaintext = Buffer.alloc(14);
    plaintext.writeBigUInt64BE(BigInt(startTs), 0);
    plaintext.writeUInt16BE(hours, 8);
    plaintext.writeUInt16BE(VERSION, 10);
    const crc = crc16ccitt(plaintext.subarray(0, 12));
    plaintext.writeUInt16BE(crc, 12);

    const cipher = crypto.createCipheriv('aes-128-ctr', key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);

    const payload = Buffer.concat([nonce, ciphertext]);
    const code = toBase62(payload);

    return { code, startTs, hours, expiryTs: startTs + hours * 3600, nonce, payload };
}

function decrypt(code, key) {
    if (code.length !== 25) throw new Error(`授权码长度错误: 期望 25 字符, 实际 ${code.length}`);
    const payload = fromBase62(code, 18);
    const nonce = payload.subarray(0, 4);
    const ciphertext = payload.subarray(4, 18);
    const iv = Buffer.concat([nonce, Buffer.alloc(12, 0)]);
    const decipher = crypto.createDecipheriv('aes-128-ctr', key, iv);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    if (plaintext.length !== 14) throw new Error('明文长度错误');

    const expectedCrc = plaintext.readUInt16BE(12);
    const actualCrc = crc16ccitt(plaintext.subarray(0, 12));
    if (expectedCrc !== actualCrc) throw new Error('CRC16 校验失败');

    return {
        startTs: Number(plaintext.readBigUInt64BE(0)),
        hours: plaintext.readUInt16BE(8),
        version: plaintext.readUInt16BE(10)
    };
}

function prompt(question) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise(resolve => rl.question(question, ans => { rl.close(); resolve(ans.trim()); }));
}

async function main() {
    const args = process.argv.slice(2);
    const isTest = args.includes('--test');

    let hours = parseInt(args.find(a => /^\d+$/.test(a)), 10);
    if (!Number.isFinite(hours)) {
        const ans = await prompt('请输入授权时长（小时, 1-65535）: ');
        hours = parseInt(ans, 10);
    }
    if (!Number.isFinite(hours) || hours < 1 || hours > 65535) {
        console.error('错误：时长必须是 1-65535 之间的整数');
        process.exit(1);
    }

    try {
        console.log('[1/3] 正在获取服务器时间 (timeapi.io)...');
        const result = await generate(hours);
        console.log(`      服务器时间: ${new Date(result.startTs * 1000).toISOString()}`);

        const code = result.code;
        const grouped = code.match(/.{1,5}/g).join('-');

        console.log('\n========== 授权码生成成功 ==========');
        console.log(`开始时间:   ${new Date(result.startTs * 1000).toLocaleString('zh-CN')}`);
        console.log(`授权时长:   ${result.hours} 小时`);
        console.log(`到期时间:   ${new Date(result.expiryTs * 1000).toLocaleString('zh-CN')}`);
        console.log(`Nonce:      ${result.nonce.toString('hex')}`);
        console.log(`载荷(hex):  ${result.payload.toString('hex')}`);
        console.log(`授权码:     ${code}`);
        console.log(`分组显示:   ${grouped}`);
        console.log(`长度:       ${code.length} 字符`);
        console.log('=====================================');

        if (isTest) {
            console.log('\n[自检] 解密回放验证...');
            const key = loadKey();
            const decoded = decrypt(code, key);
            const ok = decoded.startTs === result.startTs
                    && decoded.hours === result.hours
                    && decoded.version === VERSION;
            console.log(`  解密结果: startTs=${decoded.startTs}, hours=${decoded.hours}, version=0x${decoded.version.toString(16).padStart(4, '0')}`);
            console.log(ok ? '  ✓ 自检通过' : '  ✗ 自检失败');
            if (!ok) process.exit(1);

            console.log('\n[自检] 错误输入容错测试...');
            const bad = code.slice(0, -1) + 'X';
            try {
                decrypt(bad, key);
                console.log('  ✗ 应该报错但没报错');
                process.exit(1);
            } catch (e) {
                console.log(`  ✓ 错误输入正确拒绝: ${e.message}`);
            }
        }
    } catch (e) {
        console.error('\n生成失败:', e.message);
        process.exit(1);
    }
}

main();