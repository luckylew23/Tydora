//! Windows 窗口视觉收尾：消除无边框透明窗口四角的 DWM 边线"毛刺"。
//!
//! 根因（tao 0.35 无边框窗口 + 阴影的实现方式）：
//! tao 对 `decorations(false) + shadow(true)` 的窗口会在 `WM_NCCALCSIZE`
//! 里把客户区向内缩进一圈（Win11 顶边 1 逻辑像素、左右下为系统边框厚度），
//! 给 DWM 留出绘制窗口阴影和 1px 窗口边线的空间。这条 DWM 边线沿窗口四边
//! 各画一圈：贴着直边时与白色内容相邻，几乎看不出来；但在四角，前端 CSS
//! `clip-path: inset(0 round 12px)` 把白色内容裁成圆角，边线便露出在圆角
//! 弧线之外，形成截图里四角的"毛刺"（一小段凸出圆角的浅色细线）。
//!
//! 修复（仅 Windows 11 build 22000+ 生效；Win10 调用返回错误码，直接忽略，
//! 行为与旧版本一致）：
//! 1. `DWMWA_BORDER_COLOR = DWMWA_COLOR_NONE` —— 隐藏 DWM 窗口边线
//!    （不影响系统阴影）；
//! 2. `DWMWA_WINDOW_CORNER_PREFERENCE = DWMWCP_ROUND` —— 让 DWM 对窗口
//!    本体（含上述缩进区）做抗锯齿圆角，系统阴影自动跟随圆角形状。
//!    DWM 圆角半径（约 8px）小于前端 CSS 的 12px，视觉上由 CSS 圆角主导，
//!    二者叠加无冲突。

use tauri::WebviewWindow;

const DWMWA_WINDOW_CORNER_PREFERENCE: u32 = 33;
const DWMWA_BORDER_COLOR: u32 = 34;
const DWMWCP_ROUND: u32 = 2;
const DWMWA_COLOR_NONE: u32 = 0xFFFF_FFFE;

#[link(name = "dwmapi")]
extern "system" {
    fn DwmSetWindowAttribute(
        hwnd: isize,
        attr: u32,
        value: *const std::ffi::c_void,
        size: u32,
    ) -> i32;
}

/// 所有 Windows 窗口创建成功后的收尾：隐藏 DWM 边线 + 启用系统圆角。
/// 失败（如 Win10 不支持这两个属性）时静默忽略，不影响窗口功能。
pub fn finish_windows_window(window: &WebviewWindow) {
    let Ok(hwnd) = window.hwnd() else {
        return;
    };
    let hwnd = hwnd.0 as isize;

    unsafe {
        let border_none: u32 = DWMWA_COLOR_NONE;
        let _ = DwmSetWindowAttribute(
            hwnd,
            DWMWA_BORDER_COLOR,
            &border_none as *const u32 as *const std::ffi::c_void,
            std::mem::size_of::<u32>() as u32,
        );

        let corner_pref: u32 = DWMWCP_ROUND;
        let _ = DwmSetWindowAttribute(
            hwnd,
            DWMWA_WINDOW_CORNER_PREFERENCE,
            &corner_pref as *const u32 as *const std::ffi::c_void,
            std::mem::size_of::<u32>() as u32,
        );
    }
}
