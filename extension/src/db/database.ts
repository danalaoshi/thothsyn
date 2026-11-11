import Dexie, { type Table } from 'dexie';
import type { Asset, Capture, Folder, Setting, Tombstone } from '../types';

/**
 * 本地数据库（IndexedDB via Dexie）
 * - captures: 收藏快照（整页/部分）
 * - folders:  业务文件夹 + 标签文件夹
 * - settings: 少量配置
 * - assets:   离线图片（v0.1.3 新增，按原始 URL 全局去重）
 * - tombstones: 删除墓碑（v0.1.8 新增，供云同步传播删除）
 */
export class ThothsynDB extends Dexie {
  captures!: Table<Capture, string>;
  folders!: Table<Folder, string>;
  settings!: Table<Setting, string>;
  assets!: Table<Asset, string>;
  tombstones!: Table<Tombstone, string>;

  constructor() {
    super('thothsyn');
    this.version(1).stores({
      // *tags 为多值索引，支持按标签查询
      captures: 'id, title, folderId, createdAt, *tags',
      folders: 'id, type, name',
      settings: 'key',
    });
    // 增量升级：旧库数据全部保留，只新增 assets 表
    this.version(2).stores({
      assets: 'url, status, createdAt',
    });
    // v0.1.8：同步需要 updatedAt 游标；老记录补齐（用 createdAt 当基线，
    // 这样首次同步会把历史收藏整批上传，而不是当作「已同步」跳过）。
    // 同时给 updatedAt 建索引，增量查询不必全表扫描。
    this.version(3)
      .stores({
        captures: 'id, title, folderId, createdAt, *tags, updatedAt',
        folders: 'id, type, name, updatedAt',
        tombstones: 'id, entity, updatedAt',
      })
      .upgrade(async (tx) => {
        const stamp = Date.now();
        await tx
          .table('captures')
          .toCollection()
          .modify((c: Partial<Capture>) => {
            if (!c.updatedAt) c.updatedAt = c.createdAt ?? stamp;
          });
        await tx
          .table('folders')
          .toCollection()
          .modify((f: Partial<Folder>) => {
            if (!f.updatedAt) f.updatedAt = f.createdAt ?? stamp;
          });
      });
  }
}

export const db = new ThothsynDB();
