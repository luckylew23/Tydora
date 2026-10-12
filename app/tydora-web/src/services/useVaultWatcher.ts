import { useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { LinkIndexService } from '../wikilink';

interface FsEvent {
  kind: string;
  paths: string[];
}

// 结构性变化：文件树节点增/删/重命名。Modify(Data)（内容）/ Metadata（atime/mtime）/ Access 不算。
const STRUCTURAL_KIND_RE = /^Create\(|^Remove\(|^Modify\(Name\)/;

// 噪声路径段：跳过这些目录/文件，避免 git 操作、IDE 缓存等触发雪崩
const NOISE_SEGMENTS = [
  '.git',
  'node_modules',
  '.DS_Store',
  'Thumbs.db',
  '.svn',
  '.hg',
  '.idea',
  '.vscode',
];

function isNoisePath(p: string): boolean {
  // 统一斜杠后按段匹配，避免误伤 ".github" 等
  const norm = p.replace(/\\/g, '/');
  return NOISE_SEGMENTS.some(seg => {
    const idx = norm.indexOf('/' + seg + '/');
    if (idx >= 0) return true;
    // 文件名本身就是噪声（如根目录的 .DS_Store）
    const base = norm.slice(norm.lastIndexOf('/') + 1).toLowerCase();
    return base === seg.toLowerCase();
  });
}

export function useVaultWatcher(
  vaultPath: string | null,
  onIndexChange?: () => void,
  onStructureChange?: () => void,
  onContentChange?: (paths: string[]) => void,
) {
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const structureDebounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const contentDebounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const contentPathsRef = useRef<Set<string>>(new Set());
  const onIndexChangeRef = useRef(onIndexChange);
  const onStructureChangeRef = useRef(onStructureChange);
  const onContentChangeRef = useRef(onContentChange);
  onIndexChangeRef.current = onIndexChange;
  onStructureChangeRef.current = onStructureChange;
  onContentChangeRef.current = onContentChange;

  useEffect(() => {
    if (!vaultPath) return;

    invoke('watch_vault', { path: vaultPath }).catch(console.error);

    const unlisten = listen<FsEvent>('vault://changed', (event) => {
      const { kind, paths } = event.payload;

      // 1) 索引/图谱更新（仅 .md），沿用原 300ms debounce
      clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(async () => {
        for (const filePath of paths) {
          if (!filePath.endsWith('.md')) continue;

          if (kind.includes('Remove')) {
            LinkIndexService.removeFile(filePath);
          } else if (kind.includes('Create') || kind.includes('Modify')) {
            try {
              await LinkIndexService.updateFileLinks(filePath, vaultPath);
            } catch {
              // 文件可能正在被写入
            }
          }
        }
        onIndexChangeRef.current?.();
      }, 300);

      // 3) 编辑器内容刷新：内容被外部修改（如 AI agent 写入）时收集路径，
      //    300ms debounce 合并连续写入后批量回调。Metadata（atime/mtime）不算内容变化；
      //    即便混入噪声事件，消费方重读后内容一致也会自然跳过。
      if (kind.startsWith("Modify(") && !kind.includes("Metadata")) {
        for (const p of paths) {
          if (p.endsWith(".md") && !isNoisePath(p)) contentPathsRef.current.add(p);
        }
        if (contentPathsRef.current.size > 0) {
          clearTimeout(contentDebounceRef.current);
          contentDebounceRef.current = setTimeout(() => {
            const changed = Array.from(contentPathsRef.current);
            contentPathsRef.current.clear();
            onContentChangeRef.current?.(changed);
          }, 300);
        }
      }

      // 2) 文件树结构刷新：仅结构性变化、且非噪声路径
      if (STRUCTURAL_KIND_RE.test(kind)) {
        const hasRelevant = paths.some(p => !isNoisePath(p));
        if (hasRelevant) {
          clearTimeout(structureDebounceRef.current);
          // 500ms：批量外部操作（如 git checkout）期间合并为一次刷新
          structureDebounceRef.current = setTimeout(() => {
            onStructureChangeRef.current?.();
          }, 500);
        }
      }
    });

    return () => {
      unlisten.then(fn => fn());
      // 必须带 path：Rust 侧按目录引用计数，多窗口共享同一个 watcher。
      // 不带 path 会（兼容性地）释放全部监听，导致其他窗口静默失联。
      invoke('unwatch_vault', { path: vaultPath }).catch(console.error);
      clearTimeout(debounceRef.current);
      clearTimeout(structureDebounceRef.current);
      clearTimeout(contentDebounceRef.current);
    };
  }, [vaultPath]);
}
