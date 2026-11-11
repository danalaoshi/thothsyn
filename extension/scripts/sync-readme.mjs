/**
 * 把 docs/readme.md 编译成扩展源码里的常量 src/lib/readme-content.ts。
 *
 * readme 收藏的内容以 docs/readme.md 为唯一来源；将来换成正式使用说明时
 * 只改那份文件，重新 dev/build 即可。用编译期常量而不是运行时 fetch，
 * 是为了让这条收藏在任何情况下都不依赖 I/O，且能被 selftest 直接校验。
 * 由 npm 的 predev / prebuild / prezip 自动调用。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const source = path.resolve(root, '../docs/readme.md');
const target = path.join(root, 'src/lib/readme-content.ts');

if (!fs.existsSync(source)) {
  console.error(`[thothsyn] 找不到 readme 来源：${source}`);
  process.exit(1);
}

const markdown = fs.readFileSync(source, 'utf8');
const generated =
  '// 由 scripts/sync-readme.mjs 从 docs/readme.md 自动生成，请勿手改。\n' +
  '// 改使用说明请编辑 docs/readme.md，然后重新 dev / build。\n' +
  `export const README_MARKDOWN: string = ${JSON.stringify(markdown)};\n`;

const existing = fs.existsSync(target)
  ? fs.readFileSync(target, 'utf8')
  : null;
if (existing !== generated) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, generated, 'utf8');
  console.log(`[thothsyn] readme-content.ts 已更新 (${markdown.length} chars)`);
} else {
  console.log('[thothsyn] readme-content.ts 无变化');
}
