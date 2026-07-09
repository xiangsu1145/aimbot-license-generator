# Aimbot 授权码生成器

为 [Aimbot Android](https://github.com/xiangsu1145/aimbot-android) 客户端生成离线授权码。
基于 AES-128-CTR + CRC16 + Base62，固定 25 字符输出，支持 GitHub Pages 一键部署。

**项目结构：**

| 文件 | 用途 |
|------|------|
| `index.html` | **GitHub Pages 部署入口**（已混淆，可直接访问） |
| `index.source.html` | 同一页面的可读源码（修改后需重新混淆） |
| `generate.js` | Node.js CLI 版算码器（适合本地批量生成） |
| `obfuscate.js` | 用 javascript-obfuscator 重新混淆源码 |
| `package.json` | npm 依赖与脚本 |

## 在线试用

直接访问 https://xiangsu1145.github.io/aimbot-license-generator/ 即可点一下生成 48 小时有效期的授权码。

## 数据格式

**载荷**（18 字节）：
```
[4B nonce][14B AES-128-CTR 密文]
```

**明文**（14 字节，加密前）：
```
[8B  起始时间戳 (uint64 BE, Unix 秒)]
[2B  授权时长   (uint16 BE, 小时)]
[2B  版本       (uint16 BE, 当前 0x0001)]
[2B  CRC16-CCITT(前 12 字节)]
```

- **加密**：AES-128-CTR，IV = nonce(4) + 0x00 × 12 = 16 字节
- **编码**：Base62(18 字节) → 固定 25 字符
- **时间源**：timeapi.io（`https://timeapi.io/api/Time/current/zone?timeZone=UTC`）免费、CORS 友好

## 本地使用

### 网页版

```bash
# 进入网页后直接点按钮生成（密钥内置于混淆代码）
open index.html
```

### CLI 版（适合批量/自定义时长）

```bash
# 1. 生成密钥（一次性，保存到 keys/secret.key）
node -e "require('crypto').randomBytes(16).toString('hex')" > keys/secret.key

# 2. 生成授权码（交互输入时长）
node generate.js

# 3. 或直接指定时长 + 自检
node generate.js 48 --test
```

### 重新混淆（如修改了源码）

```bash
npm install          # 首次安装 javascript-obfuscator
npm run build        # 从 index.source.html 重新生成 index.html
```

混淆级别：字符串数组 + Base64 编码 + 控制流扁平化 + 死代码注入 + 自防御。

## 输出示例

```
========== 授权码生成成功 ==========
开始时间:   2026/7/9 21:10:41
授权时长:   4 小时
到期时间:   2026/7/10 01:10:41
Nonce:      f350abbf
载荷(hex):  f350abbfc031216134ac7caa911a63f69019
授权码:     22FeEXX9bO6ts9eSU8ZBsBbCr
分组显示:   22FeE-XX9bO-6ts9e-SU8ZB-sBbCr
长度:       25 字符
=====================================
```

## Android 端解码（伪代码）

```kotlin
fun decode(code: String): LicenseInfo {
    val payload = base62Decode(code)              // 18 字节
    val nonce = payload.copyOfRange(0, 4)         // 前 4 字节
    val ciphertext = payload.copyOfRange(4, 18)   // 后 14 字节
    val iv = nonce + ByteArray(12)                // IV = nonce + 12×0x00
    val plaintext = AES.decrypt(ciphertext, KEY, iv, "CTR/NoPadding")  // 14 字节

    val expectedCrc = (plaintext[12].toInt() shl 8) or plaintext[13].toInt()
    val actualCrc = crc16ccitt(plaintext.copyOfRange(0, 12))
    require(expectedCrc == actualCrc) { "CRC 校验失败" }

    val startTs = plaintext.readLongBE()          // 起始时间戳
    val hours = plaintext.readShortBE(8)          // 授权时长
    val version = plaintext.readShortBE(10)       // 版本

    val expiry = startTs + hours * 3600L
    require(System.currentTimeMillis() / 1000 < expiry) { "已过期" }

    return LicenseInfo(startTs, hours, expiry, version)
}
```

## 安全说明

- 密钥 16 字节（AES-128），存储于 `keys/secret.key`（gitignored）
- 网页混淆版会硬编码密钥到 JS——属于"挡小白"强度，专业逆向可还原
- 每次算码用 4 字节随机 nonce，同一时间戳每次码都不同，防批量预生成
- CRC16 仅用于检测输错，不防篡改（密钥在客户端可见，防篡改无意义）
- 接受"一码多用"：授权码不绑定设备，转发即生效（这是免费软件的定位）

## 故障排查

| 现象 | 原因 |
|------|------|
| `密钥文件不存在` | 需先运行密钥生成命令 |
| `API 请求超时` | 网络问题，可重试或检查代理 |
| `解析响应失败` | timeapi.io 返回格式变化，需更新 `fetchServerTime()` |
| `CRC16 校验失败` | 授权码输错，重新复制 |

## License

MIT © 2026 xiangsu
