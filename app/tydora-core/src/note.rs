//! Note id / title / slug 解析与文件级 IO helpers。
//!
//! 设计：所有"看着像 note id 的字符串 → 真实文件路径"的转换都集中在这里。
//! 调用方（CLI 的 `show_note` / `cmd_edit` / `cmd_write` / `cmd_delete`）一律
//! 通过 [`resolve_note_path`]，保证：
//!
//! 1. Path traversal 一律 `Usage` 错（空、`..`、`/`/`\` 开头）
//! 2. 缺扩展名时按优先级尝试 `.md` / `.markdown` / `.mdx`
//! 3. 0 命中返回 `NotFound`
//!
//! Title 提取 [`read_note_title_from_file`] 只读文件前 4096 字节避免大文件 IO，
//! 顺序 `frontmatter.title → 首 H1`，与 GUI 端 `LocalGraph.tsx` 行为对齐。

use std::fs;
use std::io::Read;
use std::path::{Component, Path, PathBuf};

use crate::error::{CoreError, CoreResult};
use crate::frontmatter;

/// Vault 内笔记允许的扩展名（小写）。
const MARKDOWN_EXTS: [&str; 3] = ["md", "markdown", "mdx"];

/// 校验一个"vault 内相对 id"是否安全。
///
/// 拒绝（返回 `false`）：
/// - 空字符串
/// - 绝对路径：POSIX 根（`/x`）、Windows 盘符（`C:/x`、`c:x`）、UNC（`\\\\server\\share`）
/// - 任何非 `Normal` 路径组件：`.` / `..` / 根目录 / 盘符前缀
///
/// 说明：Windows 上 `Path::components()` 会把 `C:/x` 判为 `Prefix + RootDir`，
/// 但 Linux/macOS 上 `C:/x` 只是普通名 `C:`，因此盘符判定必须显式做，
/// 不能只依赖 `components()`。
pub(crate) fn is_safe_relative_id(id: &str) -> bool {
    if id.is_empty() {
        return false;
    }
    let normalized = id.replace('\\', "/");

    // 显式盘符判定（跨平台一致）：单字母 + ':'
    let bytes = normalized.as_bytes();
    if bytes.len() >= 2 && bytes[1] == b':' && bytes[0].is_ascii_alphabetic() {
        return false;
    }

    // 组件级判定：拒绝 . / .. / 根 / 盘符前缀 / 前缀
    for comp in Path::new(&normalized).components() {
        if !matches!(comp, Component::Normal(_)) {
            return false;
        }
    }
    true
}

/// `path::extension()` 是否是一个已知的 markdown 扩展名。
///
/// 不能用 `extension().is_some()`：`2024.01.05` 的 extension 是 `05`，
/// 会被误判成"已带扩展名"从而只尝试字面路径，导致 `list` 输出的 id
/// （`2024.01.05`）喂不回 `show`/`edit`/`delete`。
fn has_markdown_ext(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| MARKDOWN_EXTS.iter().any(|k| k.eq_ignore_ascii_case(e)))
        .unwrap_or(false)
}

/// 把 note id 解析为 vault 内的真实文件路径。
///
/// - `id` 形如 `inbox/welcome`，**不含扩展名**或**含扩展名**两种都接受
/// - 拒绝空字符串、`..`、`/`/`\` 开头、**盘符绝对路径**（→ `Usage`）
/// - 已知 markdown 扩展名 → 只尝试字面路径；否则依次尝试
///   字面 / `.md` / `.markdown` / `.mdx`
/// - 全部不存在 → `NotFound`
pub fn resolve_note_path(id: &str, vault: &Path) -> CoreResult<PathBuf> {
    if !is_safe_relative_id(id) {
        return Err(CoreError::usage(format!("invalid note id: {id:?}")));
    }
    let raw = id.replace('\\', "/");
    let raw_pb = PathBuf::from(&raw);
    let candidates: Vec<PathBuf> = if has_markdown_ext(&raw_pb) {
        vec![vault.join(&raw)]
    } else {
        vec![
            // 先试字面路径（兼容无扩展名但确实存在的文件）
            vault.join(&raw),
            vault.join(format!("{raw}.md")),
            vault.join(format!("{raw}.markdown")),
            vault.join(format!("{raw}.mdx")),
        ]
    };
    let mut last_tried: Option<PathBuf> = None;
    for c in &candidates {
        last_tried = Some(c.clone());
        if c.is_file() {
            return Ok(c.clone());
        }
    }
    Err(CoreError::not_found(format!(
        "note '{id}' not found (tried: {})",
        last_tried
            .map(|p| p.display().to_string())
            .unwrap_or_else(|| "<none>".into())
    )))
}

/// 把 notebook 名解析为 vault 内的目录路径。  
///
/// - `(root)` 特殊值 → vault 本身（散落在根目录的 .md 也算"笔记本"）
/// - 非空、拒绝 `..`、`/`/`\` 开头、**盘符绝对路径**
/// - 目录不存在 → `NotFound`
pub fn resolve_notebook_dir(notebook: &str, vault: &Path) -> CoreResult<PathBuf> {
    // `(root)` 先取：它含括号，走通用校验也会通过，但语义上优先处理
    if notebook == "(root)" {
        return Ok(vault.to_path_buf());
    }
    if !is_safe_relative_id(notebook) {
        return Err(CoreError::usage(format!(
            "invalid notebook name: {notebook:?}"
        )));
    }
    let p = vault.join(notebook.replace('\\', "/"));
    if p.is_dir() {
        Ok(p)
    } else {
        Err(CoreError::not_found(format!(
            "notebook '{notebook}' not found at {}",
            p.display()
        )))
    }
}

/// 把任意字符串规整成"文件名安全的 slug"。
///
/// - ASCII alphanumeric / `_` / `-` 保留
/// - 其余字符转 `-`，连续 `-` 合并为单个
/// - 首尾的 `-` / `.` 自动 strip（避免 `..` / `-` 这种无效名）
pub fn slugify_filename(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut prev_dash = false;
    for c in input.chars() {
        let keep = if c.is_alphanumeric() {
            c
        } else if c == '-' || c == '_' {
            c
        } else {
            '-'
        };
        if keep == '-' {
            if !prev_dash && !out.is_empty() {
                out.push('-');
            }
            prev_dash = true;
        } else {
            out.push(keep);
            prev_dash = false;
        }
    }
    while matches!(out.chars().last(), Some('-') | Some('.')) {
        out.pop();
    }
    out
}

/// 从磁盘读取 note 的 title。  
/// 只读前 4096 字节以避免对大文件做无谓 IO；处理顺序：
/// `frontmatter.title → 首 H1 → None`。
///
/// 截断安全：4096 字节边界可能落在多字节字符（中文/emoji）中间。此时
/// **按最后一个完整字符边界截断**，而不是报 UTF-8 错误 —— 否则一篇中文笔记
/// 就能让整个 `list` / `search` 失败（历史缺陷）。头 4096 字节完全不可解码
/// （如二进制文件被误命名为 .md）时返回 `Ok(None)`，视为"没有标题"。
///
/// IO 错误（无权限 / 不存在）以 `Err(Io)` 上抛。
pub fn read_note_title_from_file(path: &Path) -> CoreResult<Option<String>> {
    let mut file = fs::File::open(path)?;
    let mut buf = [0u8; 4096];
    let n = file.read(&mut buf)?;
    let head = match std::str::from_utf8(&buf[..n]) {
        Ok(s) => s,
        Err(e) => {
            // valid_up_to() = 最后一个完整字符的结束位置；按其截断即可。
            // 为 0 说明开头就不是合法 UTF-8，无法提取任何标题。
            let valid = e.valid_up_to();
            if valid == 0 {
                return Ok(None);
            }
            // SAFETY 语义：valid_up_to 之前的字节已被验证为合法 UTF-8
            std::str::from_utf8(&buf[..valid])
                .expect("head prefix up to valid_up_to() is valid UTF-8")
        }
    };
    let fm = frontmatter::split(head);
    Ok(fm.extract_title())
}

/// 从磁盘读取整篇 note 的 frontmatter 与 body。
///
/// 不限制大小（与 [`read_note_title_from_file`] 行为不同）。
pub fn read_note(path: &Path) -> CoreResult<frontmatter::Frontmatter> {
    let raw = fs::read_to_string(path)?;
    Ok(frontmatter::split(&raw))
}

/// 原子写：写 `<path>.tmp` 再 rename。失败时旧文件保持原状。
///
/// 用于 [`crate::vault`] 系列将来支持 edit 时复用；当前 CLI 自己实现。
pub fn atomic_write(path: &Path, content: &str) -> CoreResult<()> {
    let tmp = path.with_extension({
        // 给 .md → .md.tmp
        let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
        match ext.is_empty() {
            true => "tmp".into(),
            false => format!("{ext}.tmp"),
        }
    });
    fs::write(&tmp, content)?;
    fs::rename(&tmp, path)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn slugify_handles_spaces_and_collapses_dashes() {
        assert_eq!(slugify_filename("Hello World"), "Hello-World");
        assert_eq!(slugify_filename("a--b---c"), "a-b-c");
        assert_eq!(slugify_filename("中文 title"), "中文-title");
        assert_eq!(slugify_filename("  leading"), "leading");
        assert_eq!(slugify_filename("trailing  "), "trailing");
        assert_eq!(slugify_filename("file.name."), "file-name");
        assert_eq!(slugify_filename("safe_name-1"), "safe_name-1");
    }

    #[test]
    fn resolve_note_path_tries_md_markdown_mdx() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("a.md"), "x").unwrap();
        fs::write(dir.path().join("b.markdown"), "x").unwrap();
        fs::write(dir.path().join("c.mdx"), "x").unwrap();

        assert!(resolve_note_path("a", dir.path()).unwrap().ends_with("a.md"));
        assert!(resolve_note_path("b", dir.path()).unwrap().ends_with("b.markdown"));
        assert!(resolve_note_path("c", dir.path()).unwrap().ends_with("c.mdx"));
        assert!(matches!(
            resolve_note_path("nope", dir.path()),
            Err(CoreError::NotFound(_))
        ));
    }

    #[test]
    fn resolve_note_path_rejects_path_traversal() {
        let dir = tempdir().unwrap();
        for bad in [
            "",
            "../escape",
            "/abs/path",
            "\\abs\\path",
            "good/../../escape",
        ] {
            let r = resolve_note_path(bad, dir.path());
            assert!(matches!(r, Err(CoreError::Usage(_))), "id {bad:?} should be Usage");
        }
    }

    #[test]
    fn resolve_note_path_rejects_absolute_drive_paths() {
        // 回归：只拦 `..`/`/`/`\` 开头时，`C:/x.md` 会被 `vault.join()` 直接
        // 替换成绝对路径 → 可读/写/删 vault 外任意文件。
        let dir = tempdir().unwrap();
        for bad in [
            "C:/Windows/win.ini",
            "c:/tmp/a.md",
            "D:\\tmp\\a.md",
            "C:a.md",
            "//server/share/a.md",
            "\\\\server\\share\\a.md",
        ] {
            assert!(
                matches!(resolve_note_path(bad, dir.path()), Err(CoreError::Usage(_))),
                "id {bad:?} must be rejected as Usage"
            );
        }
    }

    #[test]
    fn resolve_note_path_handles_dotted_file_names() {
        // 回归：`2024.01.05.md` 的 id 是 `2024.01.05`（只去 markdown 扩展名），
        // 但 `Path::extension()` 对 `2024.01.05` 返回 `Some("05")`，
        // 曾导致只尝试字面路径 → `list` 输出的 id 喂不回 `show`/`edit`/`delete`。
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("2024.01.05.md"), "x").unwrap();
        let p = resolve_note_path("2024.01.05", dir.path()).unwrap();
        assert!(p.ends_with("2024.01.05.md"), "got {}", p.display());

        // 真正带 markdown 扩展名的 id 仍走字面路径
        let q = resolve_note_path("2024.01.05.md", dir.path()).unwrap();
        assert!(q.ends_with("2024.01.05.md"));
    }

    #[test]
    fn is_safe_relative_id_allows_normal_ids() {
        for good in ["a", "inbox/welcome", "a.md", "2024.01.05", "中文/笔记", "a.b.c"] {
            assert!(is_safe_relative_id(good), "id {good:?} should be allowed");
        }
        for bad in ["", ".", "..", "a/..", "/a", "C:/a", "a\\..\\b"] {
            assert!(!is_safe_relative_id(bad), "id {bad:?} should be rejected");
        }
    }

    #[test]
    fn resolve_note_path_with_explicit_extension() {
        let dir = tempdir().unwrap();
        fs::create_dir(dir.path().join("subdir")).unwrap();
        fs::write(dir.path().join("subdir").join("explicit.md"), "x").unwrap();
        let p = resolve_note_path("subdir/explicit.md", dir.path()).unwrap();
        assert!(p.ends_with("subdir/explicit.md"));
    }

    #[test]
    fn resolve_notebook_dir_handles_root_and_traversal() {
        let dir = tempdir().unwrap();
        fs::create_dir(dir.path().join("inbox")).unwrap();

        // (root) → vault 本身
        assert_eq!(
            resolve_notebook_dir("(root)", dir.path()).unwrap(),
            dir.path()
        );
        // 普通 notebook
        assert!(resolve_notebook_dir("inbox", dir.path()).unwrap().ends_with("inbox"));
        // not found
        assert!(matches!(
            resolve_notebook_dir("nope", dir.path()),
            Err(CoreError::NotFound(_))
        ));
        // path traversal
        for bad in ["../escape", "/abs", "\\abs", "good/../bad"] {
            assert!(
                matches!(
                    resolve_notebook_dir(bad, dir.path()),
                    Err(CoreError::Usage(_))
                ),
                "notebook {bad:?} should be Usage"
            );
        }
        // 盘符绝对路径（回归：曾可越权枚举 vault 外目录）
        for bad in ["C:/Users", "D:\\data", "c:tmp"] {
            assert!(
                matches!(
                    resolve_notebook_dir(bad, dir.path()),
                    Err(CoreError::Usage(_))
                ),
                "notebook {bad:?} should be Usage"
            );
        }
    }

    #[test]
    fn read_note_title_handles_multibyte_at_4k_boundary() {
        // 回归：4096 字节边界落在多字节字符中间时，原实现直接 from_utf8 报错，
        // 一篇中文笔记就能让整个 `list` / `search` 失败。
        let dir = tempdir().unwrap();

        // 构造 4096 边界落在字符中间：前缀 2 字节 + 中文循环（每字 3 字节）
        let p = dir.path().join("cn.md");
        let mut s = String::from("# ");
        s.push_str(&"中".repeat(4000));
        s.push('\n');
        fs::write(&p, &s).unwrap();
        let bytes = fs::read(&p).unwrap();
        assert!(bytes.len() > 4096);
        assert_eq!(
            bytes[4096] & 0xC0,
            0x80,
            "test fixture must cut inside a multi-byte char"
        );

        // 不应报错；标题应取到首行 H1 的内容（被 4K 截断，故只校验前缀与量级）
        let title = read_note_title_from_file(&p).expect("must not fail on 4K boundary");
        let t = title.expect("first H1 must yield a title");
        assert!(t.starts_with('中'), "unexpected title start: {:?}", &t[..t.len().min(12)]);
        assert!(
            t.chars().count() > 1000,
            "title should be the truncated H1 run, got {} chars",
            t.chars().count()
        );
        assert!(!t.ends_with('\u{FFFD}'), "must not contain replacement chars");

        // 完全不可解码（二进制）时返回 None 而非报错
        let bin = dir.path().join("bin.md");
        fs::write(&bin, [0xFFu8, 0xFE, 0x00, 0x01, 0x80]).unwrap();
        assert_eq!(read_note_title_from_file(&bin).unwrap(), None);
    }

    #[test]
    fn read_note_title_from_file_falls_back_to_h1() {
        let dir = tempdir().unwrap();
        let p = dir.path().join("a.md");
        fs::write(&p, "---\n---\n\n# Heading\n\nbody").unwrap();
        assert_eq!(read_note_title_from_file(&p).unwrap(), Some("Heading".into()));
    }

    #[test]
    fn read_note_title_from_file_returns_none_when_no_title() {
        let dir = tempdir().unwrap();
        let p = dir.path().join("a.md");
        fs::write(&p, "no frontmatter, no h1").unwrap();
        assert_eq!(read_note_title_from_file(&p).unwrap(), None);
    }

    #[test]
    fn read_note_title_from_file_truncates_to_4k() {
        let dir = tempdir().unwrap();
        let p = dir.path().join("a.md");
        let mut content = String::from("---\ntitle: At Top\n---\n\n# Lost Heading\n");
        content.push_str(&"x".repeat(8192));
        fs::write(&p, &content).unwrap();
        // title 在前 4096 字节内，应被读到
        assert_eq!(
            read_note_title_from_file(&p).unwrap(),
            Some("At Top".into())
        );
    }

    #[test]
    fn atomic_write_replaces_target() {
        let dir = tempdir().unwrap();
        let p = dir.path().join("file.md");
        fs::write(&p, "old").unwrap();
        atomic_write(&p, "new").unwrap();
        assert_eq!(fs::read_to_string(&p).unwrap(), "new");
    }
}
