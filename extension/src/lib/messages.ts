// background / content / library 之间的消息契约

/** 背景 → 内容：采集整页 */
export interface CaptureFullMsg {
  type: 'CAPTURE_FULL';
}

/** 背景 → 内容：进入部分保存框选模式 */
export interface StartPartialMsg {
  type: 'START_PARTIAL_SELECT';
}

/** 内容 → 背景：整页采集结果 */
export interface CaptureFullResult {
  title: string;
  url: string;
  html: string;
  text: string;
}

/** 内容 → 背景：部分采集结果 */
export interface PartialResultMsg {
  type: 'PARTIAL_RESULT';
  title: string;
  url: string;
  html: string;
  text: string;
}

/** 背景 → 侧边栏等：一条收藏已入库，触发刷新 */
export interface CaptureSavedMsg {
  type: 'CAPTURE_SAVED';
  id: string;
}

/**
 * 设置页 → 收藏库：业务/标签文件夹发生增删改。
 * 之前文件夹 CRUD 不广播任何消息，收藏库只能等下次保存网页或刷新才重读，
 * 表现为「要过一段时间才有反应」。这条消息用于即时同步。
 */
export interface FoldersChangedMsg {
  type: 'FOLDERS_CHANGED';
}

/**
 * 后台离线资源下载完成（或用户清空离线资源）时广播。
 * 收藏库收到后清掉预览缓存，让下一次悬停重新内联最新已下载的资源。
 */
export interface AssetsChangedMsg {
  type: 'ASSETS_CHANGED';
}

/** 可见标签页 → 后台：驱动工具栏图标切换到下一帧 */
export interface IconTickMsg {
  type: 'ICON_TICK';
}
/** 内容脚本 → 后台：查询图标闪烁是否开启 */
export interface IconGetStateMsg {
  type: 'ICON_GET_STATE';
}
/** 后台 → 内容脚本：闪烁开关变化 */
export interface IconBlinkStateMsg {
  type: 'ICON_BLINK_STATE';
  blink: boolean;
}

/**
 * 收藏库（网页内左侧抽屉）的持久状态。
 * open=false 表示用户已「强制关闭」，各页面不再注入抽屉；
 * open=true 且 pinned=false 就是「自动隐藏模式」：靠近左边缘滑出，移开收起；
 * width 是用户拖出来的抽屉宽度（px），跨标签页同步。
 */
export interface LibraryState {
  open: boolean;
  pinned: boolean;
  width: number;
}

/** 内容 → 背景：页面初始化时读取状态 */
export interface LibraryGetStateMsg {
  type: 'LIBRARY_GET_STATE';
}

/** 内容 → 背景：修改状态（强制关闭 / 切换固定） */
export interface LibrarySetStateMsg {
  type: 'LIBRARY_SET_STATE';
  patch: Partial<LibraryState>;
}

/** 背景 → 内容：状态变化；reveal=true 表示刚被右键打开，先展开再转入自动隐藏 */
export interface LibraryStateMsg {
  type: 'LIBRARY_STATE';
  state: LibraryState;
  reveal?: boolean;
}

export type RuntimeMessage =
  | PartialResultMsg
  | CaptureSavedMsg
  | FoldersChangedMsg
  | AssetsChangedMsg
  | IconTickMsg
  | IconGetStateMsg
  | IconBlinkStateMsg
  | LibraryGetStateMsg
  | LibrarySetStateMsg
  | LibraryStateMsg;
/**
 * 收藏库 iframe → 内容脚本：悬停快速预览。
 * 预览浮层必须画在父页面（抽屉 iframe 之外），否则会遮住列表标题、挡住拖拽。
 */
export interface ThothPreviewShowMsg {
  source: 'thothsyn-library';
  type: 'THOTH_PREVIEW_SHOW';
  id: string;
  title: string;
  /**
   * 保存下来的快照 HTML（不是原网页 URL），且已做离线化处理。
   * 同一条目重复悬停时传空串，让父页面复用已渲染的 srcdoc，
   * 避免每次都跨 iframe 传几 MB 字符串。
   */
  html: string;
  /** 条目在 iframe 视口内的 top，用来对齐浮层 */
  y: number;
}
export interface ThothPreviewHideMsg {
  source: 'thothsyn-library';
  type: 'THOTH_PREVIEW_HIDE';
}
export type ThothPreviewMsg = ThothPreviewShowMsg | ThothPreviewHideMsg;

export type TabMessage =
  | CaptureFullMsg
  | StartPartialMsg
  | LibraryStateMsg
  | IconBlinkStateMsg;
export type TabMessageResult = CaptureFullResult | LibraryState | undefined;
