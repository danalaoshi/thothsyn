import { db } from '../db/database';
import { addFolders, patchFolder } from './repo';
import type { Folder } from '../types';

const DEFAULT_BUSINESS = ['未分类', '归档'];
/** 默认业务文件夹：刚保存的收藏都落在这里（debug#3） */
export const DEFAULT_FOLDER_NAME = '未分类';

let migrationChecked = false;

/**
 * 0.1.5：历史库里的「等待阅读」原地改名为「未分类」。
 * 只改文件夹记录的 name，不动任何 Capture 的 folderId，收藏不会丢。
 * 幂等且每个 JS 上下文只跑一次；ensureSeed 与 listBusinessFolders 都调用，
 * 这样无论先打开设置页、收藏库标签页还是只唤醒 Service Worker，名字都一致。
 */
async function renameLegacyDefault(): Promise<void> {
  if (migrationChecked) return;
  migrationChecked = true;
  const all = await db.folders.where('type').equals('business').toArray();
  const legacy = all.find((f) => f.name === '等待阅读');
  if (legacy && !all.some((f) => f.name === DEFAULT_FOLDER_NAME)) {
    await patchFolder(legacy.id, { name: DEFAULT_FOLDER_NAME });
  }
}

let seedPending: Promise<void> | undefined;

/**
 * 播种是幂等的，但两个调用点（SW 顶层 / readme 初始化）可能并发进入，
 * 两次 count() 都读到 0 就会插入两套默认文件夹。共享同一个 Promise。
 */
export function ensureSeed(): Promise<void> {
  seedPending ??= runEnsureSeed().catch((e) => {
    seedPending = undefined;
    throw e;
  });
  return seedPending;
}

async function runEnsureSeed(): Promise<void> {
  await renameLegacyDefault();
  const count = await db.folders.where('type').equals('business').count();
  if (count > 0) return;
  const now = Date.now();
  const folders: Omit<Folder, 'updatedAt'>[] = DEFAULT_BUSINESS.map(
    (name, i) => ({
      id: crypto.randomUUID(),
      name,
      type: 'business',
      createdAt: now + i,
    }),
  );
  await addFolders(folders);
}

/** 业务文件夹（单归属），按创建顺序 */
export async function listBusinessFolders(): Promise<Folder[]> {
  await renameLegacyDefault();
  return db.folders.where('type').equals('business').sortBy('createdAt');
}

/** 标签文件夹（多标签），按创建顺序 */
export async function listTagFolders(): Promise<Folder[]> {
  return db.folders.where('type').equals('tag').sortBy('createdAt');
}

/** 新收藏的默认归属：优先「未分类」，用户删掉它时退回最早的业务文件夹 */
export async function defaultBusinessFolder(): Promise<Folder | undefined> {
  const all = await listBusinessFolders();
  return all.find((f) => f.name === DEFAULT_FOLDER_NAME) ?? all[0];
}
