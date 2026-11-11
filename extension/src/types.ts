// 共享领域类型 —— v1 数据模型

/** 文件夹类型：业务文件夹（单归属）/ 标签文件夹（多标签） */
export type FolderType = 'business' | 'tag';

/** 业务文件夹：每个收藏只归属 1 个 */
export interface Folder {
  id: string;
  name: string;
  type: FolderType;
  createdAt: number;
  /** 最近修改时间（epoch ms）。v2 同步的增量游标与 LWW 裁决依据 */
  updatedAt: number;
}

/** 一条收藏：一个网页 = 一条独立记录（快照 HTML 入库） */
export interface Capture {
  id: string;
  title: string;
  url: string;
  /** 整页或部分 DOM 的快照 HTML */
  html: string;
  /** 纯文本，用于预览与搜索 */
  text: string;
  kind: 'full' | 'partial';
  /** 业务文件夹 id（单归属），null 表示未分类 */
  folderId: string | null;
  /** 标签文件夹 id 列表（多标签） */
  tags: string[];
  createdAt: number;
  /** 最近修改时间（epoch ms）。v2 同步的增量游标与 LWW 裁决依据 */
  updatedAt: number;
}

/**
 * 删除墓碑。
 *
 * 本地删除是「真删 + 留碑」：收藏记录立刻从 IndexedDB 消失（现有 UI 全部按
 * 「记录存在」判断，不需要改成到处过滤软删），同步时靠墓碑把删除意图传上去。
 * 这样 v1 的读路径一行都不用改。
 */
export interface Tombstone {
  /** 被删记录的主键 */
  id: string;
  entity: 'capture' | 'folder';
  /** 删除发生的本地时间（epoch ms），用于增量上传与 LWW */
  updatedAt: number;
}

/** 简单键值设置（v1 暂存少量配置） */
export interface Setting {
  key: string;
  value: unknown;
}

/** 离线资源种类；脚本只存档、绝不执行 */
export type AssetKind = 'image' | 'style' | 'script' | 'font';

/**
 * 离线资源：按「原始绝对 URL」全局去重。
 * 多条收藏引用同一份资源只存一份；保存时后台异步下载，不阻塞收藏入库。
 * v0.1.4 起不只图片，外链 CSS / JS / 字体也存本地（JS 仅存档）。
 */
export type AssetStatus =
  | 'pending' // 已入队，Service Worker 被终止后可从这里续跑
  | 'saved'
  | 'failed' // 下载失败，带 failureReason，不假装已离线
  | 'awaiting_permission'; // 超过本地总量软上限，等待用户清理/放行

export interface Asset {
  /** 主键：绝对化之后的原始资源 URL */
  url: string;
  /** 0.1.3 及更早的记录没有这个字段，读取时一律按 image 处理 */
  kind?: AssetKind;
  mime: string;
  /** 图片/字体二进制；saved 才有 */
  blob?: Blob;
  /** CSS / JS 原文；这类资源不存 Blob */
  text?: string;
  /** 真实字节数（下载完成后写入，采集阶段不做任何体积估算） */
  size: number;
  status: AssetStatus;
  failureReason?: string;
  createdAt: number;
}
