import { ext } from './webext';
import { db } from '../db/database';
import type { Capture, FolderType } from '../types';
import { addCaptures, addFolder } from './repo';
import { bumpRevision } from './settings';
import { defaultBusinessFolder } from './seed';
import { scrubSerializedAttributes } from './offline';
import type { FoldersChangedMsg } from './messages';

/**
 * 导入逻辑抽到共享层：入口在设置页，导入记录与原有收藏独立。
 *
 * 0.1.5（debug#4）：书签树的**顶层文件夹**（书签栏 / 其他书签 …）映射为
 * 业务文件夹（单归属），更深层路径仍是标签文件夹（多标签）。
 * 这样导入后看到的「书签栏」分类会和业务文件夹在一起，而不是混进标签树。
 */
async function finishImport(
  toAdd: Omit<Capture, 'updatedAt'>[],
): Promise<number> {
  if (toAdd.length) await addCaptures(toAdd);
  // 导入可能新建文件夹；数据版本号是主通道，runtime 消息是冗余
  await bumpRevision();
  void Promise.resolve(
    ext.runtime.sendMessage({ type: 'FOLDERS_CHANGED' } satisfies FoldersChangedMsg),
  ).catch(() => {});
  return toAdd.length;
}

/** 按「类型 + 名字」复用已有文件夹，重复导入不会堆出一堆同名分类 */
async function ensureFolder(
  name: string,
  type: FolderType,
  cache: Map<string, string>,
): Promise<string> {
  const key = `${type}:${name}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const existing = (await db.folders.where('type').equals(type).toArray()).find(
    (f) => f.name === name,
  );
  const id = existing?.id ?? crypto.randomUUID();
  if (!existing) {
    await addFolder({ id, name, type, createdAt: Date.now() });
  }
  cache.set(key, id);
  return id;
}

/** 从 Chrome 书签栏导入 */
export async function importFromBookmarks(): Promise<number> {
  const tree = await ext.bookmarks.getTree();
  const cache = new Map<string, string>();
  const toAdd: Omit<Capture, 'updatedAt'>[] = [];
  const now = Date.now();

  async function walk(
    nodes: chrome.bookmarks.BookmarkTreeNode[],
    path: string[],
  ): Promise<void> {
    for (const n of nodes) {
      if (n.url) {
        const [root, ...rest] = path;
        let folderId: string | null = null;
        if (root) folderId = await ensureFolder(root, 'business', cache);

        const tagIds: string[] = [];
        for (const p of rest) {
          const id = await ensureFolder(p, 'tag', cache);
          if (!tagIds.includes(id)) tagIds.push(id);
        }
        toAdd.push({
          id: crypto.randomUUID(),
          title: n.title || n.url,
          url: n.url,
          html: '',
          text: n.title || n.url,
          kind: 'full',
          folderId,
          tags: tagIds,
          createdAt: now + toAdd.length,
        });
      } else if (n.children) {
        await walk(n.children, n.title ? [...path, n.title] : path);
      }
    }
  }

  // 跳过 title 为空的书签树根：path[0] 必须是「书签栏」这类顶层分类
  const roots = tree.flatMap((r) => (r.title ? [r] : (r.children ?? [])));
  await walk(roots, []);
  return finishImport(toAdd);
}

/** 从导出的书签 HTML 文件导入：没有书签栏层级，统一归到默认业务文件夹 */
export async function importFromHtmlFile(file: File): Promise<number> {
  const text = await file.text();
  // 导入文件也是不可信 HTML：解析前先清掉 on* 属性，否则扩展页 CSP
  // 会在 DOMParser 阶段刷 inline event handler 违规（0.1.7）。
  const doc = new DOMParser().parseFromString(
    scrubSerializedAttributes(text),
    'text/html',
  );
  const links = Array.from(doc.querySelectorAll('a[href]')) as HTMLAnchorElement[];
  const now = Date.now();
  const toAdd: Omit<Capture, 'updatedAt'>[] = [];
  const folderId = (await defaultBusinessFolder())?.id ?? null;
  for (const a of links) {
    const url = a.href;
    if (!url || /^(javascript|place|chrome|about):/i.test(url)) continue;
    const title = a.textContent?.trim() || url;
    toAdd.push({
      id: crypto.randomUUID(),
      title,
      url,
      html: '',
      text: title,
      kind: 'full',
      folderId,
      tags: [],
      createdAt: now + toAdd.length,
    });
  }
  return finishImport(toAdd);
}
