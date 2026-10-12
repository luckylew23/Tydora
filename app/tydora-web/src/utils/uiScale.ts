/**
 * 界面缩放（分辨率自适应）。
 *
 * 通过 Tauri 的 webview 页面缩放（setZoom，等同浏览器页面缩放）实现整体缩放：
 * 所有 CSS 像素按系数缩放，布局随视口重新排版（100vh、固定像素、弹窗定位均
 * 按浏览器缩放语义正确工作），主窗口 / 设置 / 脑图 / 图谱 / 白板等所有窗口各自生效。
 *
 * 自动模式以「当前显示器的 CSS 宽度」为基准换算（window.screen.width 已包含
 * 系统 DPI 缩放的影响，且不受页面缩放影响 —— 因此应用缩放后不会触发
 * 「视口变化 → 重算缩放」的反馈循环）：
 *
 *   scale = clamp(screen.width / 1920, 0.75, 1.25)
 *
 * 即以 1920 宽的显示器为 100% 基准：
 * - 低分辨率 / 高 DPI 小屏（1366×768、1536×864 等）按比例缩小，最低 75%，
 *   在物理字号基本不变的前提下容纳更多内容，解决"内容过大"问题；
 * - 高分辨率（2560 及以上、4K 无系统缩放）适度放大，最高 125%，改善可读性；
 * - 1920 档保持 100%，与历史显示一致。
 *
 * 用户可在 设置 → 通用 → 界面缩放 中选择"自动"或固定比例（写入
 * localStorage 的 zmd-general-settings.uiScale），所有窗口经 storage 事件实时生效。
 */

const REFERENCE_VIEWPORT_WIDTH = 1920;
const AUTO_MIN_SCALE = 0.75;
const AUTO_MAX_SCALE = 1.25;
/** 手动模式的允许范围 */
export const UI_SCALE_MIN = 0.75;
export const UI_SCALE_MAX = 1.5;

export type UiScaleSetting = "auto" | number;

export function normalizeUiScale(value: unknown): UiScaleSetting {
  if (value === "auto" || value === undefined || value === null) return "auto";
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return "auto";
  // 兼容存成 75~150 百分数的旧数据
  const ratio = n > 1.6 ? n / 100 : n;
  return Math.min(UI_SCALE_MAX, Math.max(UI_SCALE_MIN, Math.round(ratio * 100) / 100));
}

/** 显示器 CSS 宽度 → 自动缩放系数（保留 3 位小数） */
export function computeAutoUiScale(screenWidth: number = (globalThis as any).screen?.width ?? 0): number {
  if (!screenWidth) return 1;
  const scale = Math.min(AUTO_MAX_SCALE, Math.max(AUTO_MIN_SCALE, screenWidth / REFERENCE_VIEWPORT_WIDTH));
  return Math.round(scale * 1000) / 1000;
}

export function resolveUiScale(settings: { uiScale?: unknown }): number {
  const mode = normalizeUiScale(settings?.uiScale);
  return mode === "auto" ? computeAutoUiScale() : mode;
}

let lastAppliedScale = 0;

/** 应用缩放到当前 webview（页面缩放语义，等比缩放全部 UI 与文字） */
export async function applyUiScale(scale: number): Promise<void> {
  const target = Math.round(scale * 1000) / 1000;
  if (Math.abs(target - lastAppliedScale) < 0.005) return;
  // 纯浏览器环境（vite dev）无缩放能力：直接记录，避免反复尝试
  if (!("__TAURI_INTERNALS__" in window)) {
    lastAppliedScale = target;
    return;
  }
  try {
    const { getCurrentWebview } = await import("@tauri-apps/api/webview");
    await getCurrentWebview().setZoom(target);
    // 只在真正生效后记录。若在 await 之前记录，setZoom 抛错（webview 未就绪等）
    // 会让差值判据 < 0.005 永久命中，之后所有同值调用都被提前 return，
    // 缩放再也无法生效。
    lastAppliedScale = target;
  } catch (e) {
    console.error("[uiScale] 应用界面缩放失败:", e);
  }
}

export function applyUiScaleFromSettings(settings: { uiScale?: unknown }): void {
  void applyUiScale(resolveUiScale(settings));
}

/** 从 localStorage 读取通用设置并应用（供各窗口尽早调用） */
export function applyUiScaleFromStorage(): void {
  try {
    const raw = localStorage.getItem("zmd-general-settings");
    applyUiScaleFromSettings(raw ? JSON.parse(raw) : {});
  } catch {
    applyUiScaleFromSettings({});
  }
}

/**
 * 各窗口入口尽早调用：立即应用一次，并随窗口尺寸变化 / 设置变化实时更新。
 * 与 menuDensity 相同，跨窗口实时性依赖 localStorage 的 storage 事件。
 */
export function setupUiScale(): void {
  applyUiScaleFromStorage();

  let resizeTimer: ReturnType<typeof setTimeout> | undefined;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(applyUiScaleFromStorage, 150);
  });

  window.addEventListener("storage", (e) => {
    if (e.key === "zmd-general-settings") applyUiScaleFromStorage();
  });
}
