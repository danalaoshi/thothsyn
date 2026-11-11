/**
 * 校验两套 locale 并对齐，再由 zh_CN 生成 src/lib/i18n-keys.ts。
 *
 * 源码里的 UI 文案保留中文原文（便于阅读、也让回归测试稳定），
 * 运行时通过「中文原文 → i18n key」的映射取当前语言的译文。
 * 由 npm 的 predev / prebuild / prezip 自动调用。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const locales = path.join(root, 'public/_locales');
const target = path.join(root, 'src/lib/i18n-keys.ts');

const read = (lang) =>
  JSON.parse(
    fs.readFileSync(path.join(locales, lang, 'messages.json'), 'utf8'),
  );

const zh = read('zh_CN');
const en = read('en');
const zhKeys = Object.keys(zh).sort();
const enKeys = Object.keys(en).sort();

for (const k of zhKeys) {
  if (!(k in en)) throw new Error(`[i18n] en 缺少 key: ${k}`);
  const a = (zh[k].message.match(/\$\d/g) ?? []).sort().join(',');
  const b = (en[k].message.match(/\$\d/g) ?? []).sort().join(',');
  if (a !== b) {
    throw new Error(`[i18n] ${k} 的中英文占位符不一致: "${a}" vs "${b}"`);
  }
}
for (const k of enKeys) {
  if (!(k in zh)) throw new Error(`[i18n] zh_CN 缺少 key: ${k}`);
}

const keyOf = {};
const zhOfKey = {};
const duplicates = [];
for (const [key, entry] of Object.entries(zh)) {
  zhOfKey[key] = entry.message;
  if (keyOf[entry.message] && keyOf[entry.message] !== key) {
    duplicates.push(`${entry.message} (${keyOf[entry.message]} / ${key})`);
  }
  keyOf[entry.message] = key;
}
if (duplicates.length) {
  console.warn(`[i18n] 中文原文重复，后者覆盖前者：\n  ${duplicates.join('\n  ')}`);
}

const generated =
  '// 由 scripts/sync-i18n.mjs 从 public/_locales/zh_CN/messages.json 自动生成。\n' +
  '// 改文案请编辑 messages.json（两套 locale 必须同时改），然后重新 dev / build。\n' +
  `export const KEY_OF: Record<string, string> = ${JSON.stringify(keyOf, null, 2)};\n\n` +
  `export const ZH_OF_KEY: Record<string, string> = ${JSON.stringify(zhOfKey, null, 2)};\n`;

if (!fs.existsSync(target) || fs.readFileSync(target, 'utf8') !== generated) {
  fs.writeFileSync(target, generated, 'utf8');
  console.log(`[i18n] ${zhKeys.length} 条文案已校验，i18n-keys.ts 已更新`);
} else {
  console.log(`[i18n] ${zhKeys.length} 条文案已校验，无变化`);
}
