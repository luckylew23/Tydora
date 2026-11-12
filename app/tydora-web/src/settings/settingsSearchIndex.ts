// settingsSearchIndex.ts
//
// 「设置项」搜索索引：命令面板（Ctrl+P）通过这份注册表索引各设置标签页内的
// 具体设置项（名称 + 描述均可搜索）。
//
// 同步约定：
// - label / desc 一律存 i18n key，运行时经 t() 解析——文案修改、语言切换自动同步；
// - 新增/修改设置项时，在 SETTINGS_SEARCH_ITEMS 里加/改一行（id = labelKey）；
// - 定位原理：Settings 挂载后按「行标题文本 === t(labelKey)」匹配 .canvas-settings-row，
//   所以 labelKey 必须与 JSX 里 row-title 用的 key 完全一致，定位才稳定。

export interface SettingsSearchItem {
  /** 稳定唯一 id，与 labelKey 相同 */
  id: string;
  /** 所属设置标签页（settings.tabs.<tab> 展示名） */
  tab: string;
  /** 设置项名称的 i18n key（须与 JSX row-title 的 key 一致） */
  labelKey: string;
  /** 描述的 i18n key 列表（纳入搜索范围） */
  descKeys: string[];
}

export const SETTINGS_SEARCH_ITEMS: SettingsSearchItem[] = [
  { id: "settings.ai.enable", tab: "ai", labelKey: "settings.ai.enable", descKeys: ["settings.ai.enableDesc", "settings.ai.usageDesc"] },
  { id: "settings.ai.provider", tab: "ai", labelKey: "settings.ai.provider", descKeys: ["settings.ai.providerDesc"] },
  { id: "settings.ai.model", tab: "ai", labelKey: "settings.ai.model", descKeys: ["settings.ai.modelDesc"] },
  { id: "settings.ai.baseUrl", tab: "ai", labelKey: "settings.ai.baseUrl", descKeys: ["settings.ai.baseUrlDesc"] },
  { id: "settings.ai.apiKey", tab: "ai", labelKey: "settings.ai.apiKey", descKeys: ["settings.ai.apiKeyDesc"] },
  { id: "settings.appearance.previewMaxWidth", tab: "editor", labelKey: "settings.appearance.previewMaxWidth", descKeys: ["settings.appearance.previewMaxWidthDesc"] },
  { id: "settings.appearance.editorFont", tab: "editor", labelKey: "settings.appearance.editorFont", descKeys: ["settings.appearance.editorFontDesc"] },
  { id: "settings.appearance.codeFont", tab: "editor", labelKey: "settings.appearance.codeFont", descKeys: ["settings.appearance.codeFontDesc"] },
  { id: "settings.appearance.fontSize", tab: "editor", labelKey: "settings.appearance.fontSize", descKeys: ["settings.appearance.fontSizeDesc"] },
  { id: "settings.appearance.codeFontSize", tab: "editor", labelKey: "settings.appearance.codeFontSize", descKeys: ["settings.appearance.codeFontSizeDesc"] },
  { id: "settings.appearance.lineHeight", tab: "editor", labelKey: "settings.appearance.lineHeight", descKeys: ["settings.appearance.lineHeightDesc"] },
  { id: "settings.appearance.paragraphSpacing", tab: "editor", labelKey: "settings.appearance.paragraphSpacing", descKeys: ["settings.appearance.paragraphSpacingDesc"] },
  { id: "settings.appearance.codeLineHeight", tab: "editor", labelKey: "settings.appearance.codeLineHeight", descKeys: ["settings.appearance.codeLineHeightDesc"] },
  { id: "settings.appearance.typewriterMode", tab: "editor", labelKey: "settings.appearance.typewriterMode", descKeys: ["settings.appearance.typewriterModeDesc"] },
  { id: "settings.appearance.showLineNumbers", tab: "editor", labelKey: "settings.appearance.showLineNumbers", descKeys: ["settings.appearance.showLineNumbersDesc"] },
  { id: "settings.appearance.codeBlockToolbarStyle", tab: "editor", labelKey: "settings.appearance.codeBlockToolbarStyle", descKeys: ["settings.appearance.codeBlockToolbarStyleDesc"] },
  { id: "settings.appearance.menuDensity", tab: "general", labelKey: "settings.appearance.menuDensity", descKeys: ["settings.appearance.menuDensityDesc"] },
  { id: "settings.appearance.autoSave", tab: "general", labelKey: "settings.appearance.autoSave", descKeys: ["settings.appearance.autoSaveDesc"] },
  { id: "settings.appearance.autoHideTopbar", tab: "general", labelKey: "settings.appearance.autoHideTopbar", descKeys: ["settings.appearance.autoHideTopbarDesc"] },
  { id: "settings.appearance.autoHideTopbarOnCollapse", tab: "general", labelKey: "settings.appearance.autoHideTopbarOnCollapse", descKeys: ["settings.appearance.autoHideTopbarOnCollapseDesc"] },
  { id: "settings.appearance.expandOutlineOnOpen", tab: "general", labelKey: "settings.appearance.expandOutlineOnOpen", descKeys: ["settings.appearance.expandOutlineOnOpenDesc"] },
  { id: "settings.appearance.showFileIcons", tab: "general", labelKey: "settings.appearance.showFileIcons", descKeys: ["settings.appearance.showFileIconsDesc"] },
  { id: "settings.mindmap.maxNodeWidth", tab: "mindmap", labelKey: "settings.mindmap.maxNodeWidth", descKeys: ["settings.mindmap.maxNodeWidthDesc"] },
  { id: "settings.mindmap.horizontalSpacing", tab: "mindmap", labelKey: "settings.mindmap.horizontalSpacing", descKeys: ["settings.mindmap.horizontalSpacingDesc"] },
  { id: "settings.mindmap.verticalSpacing", tab: "mindmap", labelKey: "settings.mindmap.verticalSpacing", descKeys: ["settings.mindmap.verticalSpacingDesc"] },
  { id: "settings.mindmap.edgeWidth", tab: "mindmap", labelKey: "settings.mindmap.edgeWidth", descKeys: ["settings.mindmap.edgeWidthDesc"] },
  { id: "settings.mindmap.initialExpandLevel", tab: "mindmap", labelKey: "settings.mindmap.initialExpandLevel", descKeys: ["settings.mindmap.initialExpandLevelDesc"] },
  { id: "settings.mindmap.animationDuration", tab: "mindmap", labelKey: "settings.mindmap.animationDuration", descKeys: ["settings.mindmap.animationDurationDesc"] },
  { id: "settings.mindmap.colorFreezeLevel", tab: "mindmap", labelKey: "settings.mindmap.colorFreezeLevel", descKeys: ["settings.mindmap.colorFreezeLevelDesc"] },
  { id: "settings.graph.openInNewWindow", tab: "graph", labelKey: "settings.graph.openInNewWindow", descKeys: ["settings.graph.openInNewWindowDesc"] },
  { id: "settings.graph.maxNodeSize", tab: "graph", labelKey: "settings.graph.maxNodeSize", descKeys: ["settings.graph.maxNodeSizeDesc"] },
  { id: "settings.graph.labelFontSize", tab: "graph", labelKey: "settings.graph.labelFontSize", descKeys: ["settings.graph.labelFontSizeDesc"] },
  { id: "settings.graph.edgeDistance", tab: "graph", labelKey: "settings.graph.edgeDistance", descKeys: ["settings.graph.edgeDistanceDesc"] },
  { id: "settings.graph.repulsion", tab: "graph", labelKey: "settings.graph.repulsion", descKeys: ["settings.graph.repulsionDesc"] },
  { id: "settings.graph.edgeOpacity", tab: "graph", labelKey: "settings.graph.edgeOpacity", descKeys: ["settings.graph.edgeOpacityDesc"] },
  { id: "settings.image.storageMode", tab: "image", labelKey: "settings.image.storageMode", descKeys: ["settings.image.storageModeDesc"] },
  { id: "settings.image.filenameFormat", tab: "image", labelKey: "settings.image.filenameFormat", descKeys: ["settings.image.filenameFormatDesc"] },
  { id: "settings.image.autoCreateAssets", tab: "image", labelKey: "settings.image.autoCreateAssets", descKeys: ["settings.image.autoCreateAssetsDesc"] },
  { id: "settings.image.storagePath", tab: "image", labelKey: "settings.image.storagePath", descKeys: ["settings.image.storagePathDesc"] },
  { id: "settings.image.uploadFeature", tab: "image", labelKey: "settings.image.uploadFeature", descKeys: ["settings.image.uploadFeatureDesc"] },
  { id: "settings.canvas.defaultLocation", tab: "canvas", labelKey: "settings.canvas.defaultLocation", descKeys: [] },
  { id: "settings.canvas.attachmentPath", tab: "canvas", labelKey: "settings.canvas.attachmentPath", descKeys: ["settings.canvas.attachmentPathDesc"] },
  { id: "settings.canvas.snapToGrid", tab: "canvas", labelKey: "settings.canvas.snapToGrid", descKeys: ["settings.canvas.snapToGridDesc"] },
  { id: "settings.canvas.gridSize", tab: "canvas", labelKey: "settings.canvas.gridSize", descKeys: [] },
  { id: "settings.canvas.snapToObjects", tab: "canvas", labelKey: "settings.canvas.snapToObjects", descKeys: ["settings.canvas.snapToObjectsDesc"] },
  { id: "settings.canvas.hideContentThreshold", tab: "canvas", labelKey: "settings.canvas.hideContentThreshold", descKeys: ["settings.canvas.hideContentThresholdDesc"] },
  { id: "settings.canvas.enableMinimap", tab: "canvas", labelKey: "settings.canvas.enableMinimap", descKeys: ["settings.canvas.enableMinimapDesc"] },
  { id: "settings.canvas.minimapPosition", tab: "canvas", labelKey: "settings.canvas.minimapPosition", descKeys: [] },
  { id: "settings.canvas.minZoom", tab: "canvas", labelKey: "settings.canvas.minZoom", descKeys: ["settings.canvas.minZoomDesc"] },
  { id: "settings.canvas.maxZoom", tab: "canvas", labelKey: "settings.canvas.maxZoom", descKeys: ["settings.canvas.maxZoomDesc"] },
  { id: "settings.canvas.textCard", tab: "canvas", labelKey: "settings.canvas.textCard", descKeys: [] },
  { id: "settings.canvas.noteCard", tab: "canvas", labelKey: "settings.canvas.noteCard", descKeys: [] },
  { id: "settings.canvas.mediaCard", tab: "canvas", labelKey: "settings.canvas.mediaCard", descKeys: [] },
  { id: "settings.cli.readOnly", tab: "cli", labelKey: "settings.cli.readOnly", descKeys: ["settings.cli.readOnlyDesc"] },
  { id: "settings.cli.format", tab: "cli", labelKey: "settings.cli.format", descKeys: [] },
  { id: "settings.terminal.colorScheme", tab: "terminal", labelKey: "settings.terminal.colorScheme", descKeys: ["settings.terminal.colorSchemeDesc"] },
  { id: "settings.terminal.fontFamily", tab: "terminal", labelKey: "settings.terminal.fontFamily", descKeys: ["settings.terminal.fontFamilyDesc"] },
  { id: "settings.terminal.fontSize", tab: "terminal", labelKey: "settings.terminal.fontSize", descKeys: ["settings.terminal.fontSizeDesc"] },
  // Vim 面板（多行 t() 书写，脚本提取不到，手工登记）
  { id: "settings.vim.enable", tab: "vim", labelKey: "settings.vim.enable", descKeys: ["settings.vim.enableDesc"] },
  { id: "settings.vim.leaderKey", tab: "vim", labelKey: "settings.vim.leaderKey", descKeys: ["settings.vim.leaderKeyDesc"] },
  { id: "settings.vim.menuTimeout", tab: "vim", labelKey: "settings.vim.menuTimeout", descKeys: ["settings.vim.menuTimeoutDesc"] },
  { id: "settings.vim.conflictKeys", tab: "vim", labelKey: "settings.vim.conflictKeys", descKeys: ["settings.vim.conflictKeysDesc"] },
  // 侧栏布局（模板字面量行，脚本无法提取；定位走 section 标题回退）
  { id: "settings.sidebar.title", tab: "editor", labelKey: "settings.sidebar.title", descKeys: ["settings.sidebar.desc"] },
];

export function findSettingsSearchItem(id: string): SettingsSearchItem | undefined {
  return SETTINGS_SEARCH_ITEMS.find((item) => item.id === id);
}
