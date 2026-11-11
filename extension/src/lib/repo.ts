/**
 * 本地写入口（repository）。
 *
 * v0.1.8 起所有对 captures / folders 的写操作都从这里走，原因只有一个：
 * **每一条写都必须打上 updatedAt**，否则云同步无法判断「这条改过没有」，
 * 删除还必须同时留墓碑，否则删除意图传不到云端。
 *
 * 读路径完全没变（仍然直接读 db.captures / db.folders）：本地删除是真删，
 * 不需要像软删方案那样在每个列表、搜索、拖拽处过滤 deletedAt。
 */
import { db } from '../db/database';
import type { Capture, Folder } from '../types';

export const nowMs = (): number => Date.now();

/** 新收藏入库（自动打 updatedAt）；返回真正落库的记录 */
export async function addCapture(
  cap: Omit<Capture, 'updatedAt'>,
): Promise<Capture> {
  const rec: Capture = { ...cap, updatedAt: nowMs() };
  await db.captures.add(rec);
  return rec;
}

/** 批量入库（导入书签用），同批共用一个时间戳 */
export async function addCaptures(
  list: Omit<Capture, 'updatedAt'>[],
): Promise<number> {
  if (!list.length) return 0;
  const stamp = nowMs();
  await db.captures.bulkAdd(list.map((c) => ({ ...c, updatedAt: stamp })));
  return list.length;
}

/**
 * 修改收藏的某个字段（改名、移动文件夹、加减标签）。
 * 显式打 updatedAt —— 这是「用户改过」的唯一信号。
 */
export async function patchCapture(
  id: string,
  patch: Partial<Omit<Capture, 'id' | 'updatedAt'>>,
): Promise<void> {
  await db.captures.update(id, { ...patch, updatedAt: nowMs() });
}

/** 用户删除收藏：真删本地记录 + 留墓碑，等待下次同步上传 */
export async function removeCapture(id: string): Promise<void> {
  await db.captures.delete(id);
  await db.tombstones.put({ id, entity: 'capture', updatedAt: nowMs() });
}

/** 同步下发删除时使用：只删本地，不再留墓碑（否则会回声上传） */
export async function purgeCapture(id: string): Promise<void> {
  await db.captures.delete(id);
}

export async function addFolder(
  input: Omit<Folder, 'updatedAt'>,
): Promise<Folder> {
  const rec: Folder = { ...input, updatedAt: nowMs() };
  await db.folders.add(rec);
  return rec;
}

export async function addFolders(
  list: Omit<Folder, 'updatedAt'>[],
): Promise<number> {
  if (!list.length) return 0;
  const stamp = nowMs();
  await db.folders.bulkAdd(list.map((f) => ({ ...f, updatedAt: stamp })));
  return list.length;
}

export async function patchFolder(
  id: string,
  patch: Partial<Omit<Folder, 'id' | 'updatedAt'>>,
): Promise<void> {
  await db.folders.update(id, { ...patch, updatedAt: nowMs() });
}

/** 用户删除文件夹：真删 + 墓碑。收藏的归属清理由调用方负责（见设置页）。 */
export async function removeFolder(id: string): Promise<void> {
  await db.folders.delete(id);
  await db.tombstones.put({ id, entity: 'folder', updatedAt: nowMs() });
}

export async function purgeFolder(id: string): Promise<void> {
  await db.folders.delete(id);
}

/** 清掉某条记录对应的本地墓碑（同步下发 upsert 时用：云端既然有这条，说明没删） */
export async function clearTombstone(id: string): Promise<void> {
  await db.tombstones.delete(id);
}
