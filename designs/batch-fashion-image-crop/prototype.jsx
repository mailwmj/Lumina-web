import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { RotateCcw, RotateCw } from 'lucide-react';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  Alert02Icon,
  ArrowLeft01Icon,
  Cancel01Icon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CropIcon,
  Download01Icon,
  FolderOpenIcon,
  ImageAdd01Icon,
  LanguageSquareIcon,
  MagicWand02Icon,
  Moon02Icon,
  PlusSignIcon,
  Refresh01Icon,
  Settings02Icon,
  Sun03Icon,
  Tick02Icon,
} from '@hugeicons/core-free-icons';

const SIZE_OPTIONS = [
  { value: '1440x1440', label: '1440 × 1440', ratio: 1 },
  { value: '1440x1920', label: '1440 × 1920', ratio: 0.75 },
  { value: '1440x2200', label: '1440 × 2200', ratio: 1440 / 2200 },
];

const PROJECTS = [
  ['秋冬女装主图', '2026/8/13', '2026/8/11'],
  ['七夕活动素材', '2026/8/12', '2026/8/8'],
  ['针织衫详情页', '2026/8/10', '2026/8/3'],
];

const STATUS_LABELS = {
  pending: '待生成',
  processing: '计算中',
  auto: '自动完成',
  review: '需检查',
  adjusted: '已手动调整',
  confirmed: '已确认',
  exporting: '导出中',
  exported: '已导出',
  error: '处理失败',
};

function Icon({ icon, size = 16, strokeWidth = 1.7 }) {
  return <HugeiconsIcon icon={icon} size={size} strokeWidth={strokeWidth} />;
}

function TitleBar({ screen, onBack, theme, onTheme }) {
  return (
    <div className="titlebar">
      <div className="traffic-lights" aria-hidden="true">
        <span className="traffic-light red"></span>
        <span className="traffic-light yellow"></span>
        <span className="traffic-light green"></span>
      </div>
      <div className="titlebar-center">
        {screen === 'crop' ? (
          <button className="icon-button" aria-label="返回首页" title="返回首页" onClick={onBack}>
            <Icon icon={ArrowLeft01Icon} />
          </button>
        ) : null}
        <span className="titlebar-title">{screen === 'crop' ? '图片裁剪 - Lumina' : 'Lumina'}</span>
      </div>
      <div className="titlebar-actions">
        <button className="icon-button" aria-label="切换语言" title="切换语言">
          <Icon icon={LanguageSquareIcon} />
        </button>
        <button className="icon-button" aria-label="切换主题" title="切换主题" onClick={onTheme}>
          <Icon icon={theme === 'dark' ? Sun03Icon : Moon02Icon} />
        </button>
        <button className="icon-button" aria-label="设置" title="设置">
          <Icon icon={Settings02Icon} />
        </button>
      </div>
    </div>
  );
}

function Home({ onOpenCrop }) {
  return (
    <section className="home-screen" data-screen-label="Lumina 首页">
      <div className="home-content">
        <header className="home-header">
          <div className="home-title-group">
            <h1 className="home-title">项目</h1>
            <select className="home-select" defaultValue="updated" aria-label="排序方式">
              <option value="name">名称</option>
              <option value="created">创建时间</option>
              <option value="updated">更新时间</option>
            </select>
            <select className="home-select" defaultValue="desc" aria-label="排序方向">
              <option value="asc">升序</option>
              <option value="desc">降序</option>
            </select>
          </div>
          <div className="home-actions">
            <button className="button" onClick={onOpenCrop} id="open-crop-workbench">
              <Icon icon={CropIcon} />
              图片裁剪
            </button>
            <button className="button primary">
              <Icon icon={PlusSignIcon} />
              新建项目
            </button>
          </div>
        </header>
        <div className="project-grid">
          {PROJECTS.map(([name, modified, created]) => (
            <article className="project-card" key={name}>
              <h2 className="project-name">{name}</h2>
              <p className="project-meta">修改时间: {modified}<br />创建时间: {created}</p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

function Sidebar({
  size,
  setSize,
  items,
  selectedId,
  setSelectedId,
  addFiles,
  filter,
  setFilter,
  phase,
  progress,
  phaseTotal,
  startAuto,
  requestExport,
}) {
  const fileInputRef = useRef(null);
  const reviewCount = items.filter((item) => item.status === 'review').length;
  const visibleItems = filter === 'review'
    ? items.filter((item) => item.status === 'review')
    : items;
  const hasUnconfirmedRisk = reviewCount > 0;
  const hasPending = items.some((item) => ['pending', 'error'].includes(item.status));
  const allSchemed = items.length > 0 && items.every((item) => !['pending', 'processing'].includes(item.status));
  const allExported = items.length > 0 && items.every((item) => item.status === 'exported');
  const busy = phase === 'auto' || phase === 'exporting';

  let primaryLabel = '生成裁剪方案';
  let primaryIcon = MagicWand02Icon;
  let primaryAction = startAuto;
  let primaryDisabled = !size || items.length === 0 || busy || !hasPending;

  if (phase === 'auto') {
    primaryLabel = `正在计算 ${progress}/${phaseTotal}`;
    primaryDisabled = true;
  } else if (phase === 'exporting') {
    primaryLabel = `正在导出 ${progress}/${phaseTotal}`;
    primaryIcon = Download01Icon;
    primaryDisabled = true;
  } else if (hasPending) {
    primaryAction = startAuto;
  } else if (allSchemed) {
    primaryLabel = hasUnconfirmedRisk ? `还有 ${reviewCount} 张需检查` : allExported ? '再次导出' : '确认并导出';
    primaryIcon = Download01Icon;
    primaryAction = requestExport;
    primaryDisabled = hasUnconfirmedRisk;
  }

  return (
    <aside className="sidebar">
      <div className="sidebar-controls">
        <label className="field-label" htmlFor="target-size">裁剪尺寸</label>
        <select
          id="target-size"
          className="size-select"
          value={size}
          disabled={busy}
          onChange={(event) => setSize(event.target.value)}
        >
          <option value="">请选择裁剪尺寸</option>
          {SIZE_OPTIONS.map((option) => (
            <option value={option.value} key={option.value}>{option.label}</option>
          ))}
        </select>
        <div className="upload-actions">
          <button
            className="button small"
            disabled={!size || items.length >= 100 || busy}
            onClick={() => fileInputRef.current?.click()}
          >
            <Icon icon={ImageAdd01Icon} />
            添加图片
          </button>
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/jpeg,image/png"
          multiple
          hidden
          onChange={(event) => addFiles(Array.from(event.target.files || []))}
        />
      </div>

      <div className="list-header">
        <span className="list-title">图片列表</span>
        <span className="list-count">{items.length}/100</span>
      </div>
      {items.length > 0 ? (
        <div className="filter-row">
          <button className={`filter-button ${filter === 'all' ? 'active' : ''}`} onClick={() => setFilter('all')}>全部 {items.length}</button>
          <button className={`filter-button ${filter === 'review' ? 'active' : ''}`} onClick={() => setFilter('review')}>需检查 {reviewCount}</button>
        </div>
      ) : null}
      <div className="image-list" id="image-list">
        {items.length === 0 ? null : visibleItems.length === 0 ? (
          <div className="image-list-empty">没有需要检查的图片</div>
        ) : visibleItems.map((item) => (
          <button
            className={`image-row ${selectedId === item.id ? 'selected' : ''}`}
            key={item.id}
            onClick={() => setSelectedId(item.id)}
            title={item.name}
          >
            <span className="thumb">
              <img
                src={item.src}
                alt=""
                style={{
                  objectPosition: item.objectPosition,
                  transform: `rotate(${item.rotation || 0}deg) scale(${(item.rotation || 0) % 180 === 0 ? 1 : 1.16})`,
                }}
              />
            </span>
            <span className="image-row-copy">
              <span className="image-row-name">{item.name}</span>
              <span className="image-row-meta">{item.size}</span>
            </span>
            <span className={`status-dot ${item.status}`} aria-label={STATUS_LABELS[item.status]} title={STATUS_LABELS[item.status]}></span>
          </button>
        ))}
      </div>
      <div className="sidebar-footer">
        {busy ? (
          <div className="progress-block">
            <div className="progress-copy"><span>{phase === 'auto' ? '本地计算裁剪区域' : '从原图裁剪并导出'}</span><span>{progress}/{phaseTotal}</span></div>
            <div className="progress-track"><div className="progress-fill" style={{ width: `${phaseTotal ? progress / phaseTotal * 100 : 0}%` }}></div></div>
          </div>
        ) : null}
        <button className="button primary" disabled={primaryDisabled} onClick={primaryAction} id="primary-batch-action">
          <Icon icon={primaryIcon} />
          {primaryLabel}
        </button>
      </div>
    </aside>
  );
}

function getDefaultFrame(item, size) {
  const isQuarterTurn = (item?.rotation || 0) % 180 !== 0;
  if (isQuarterTurn) {
    const width = size === '1440x1440' ? 60 : size === '1440x1920' ? 45 : 40;
    return { x: (100 - width) / 2, y: 5, w: width };
  }
  return { x: 5, y: item?.risk ? 3.5 : size === '1440x1440' ? 18 : 5, w: 90 };
}

function CropEditor({ item, size, phase, onAdjust, onConfirm, onRestore, onRotate, onPrev, onNext, index, total }) {
  const photoRef = useRef(null);
  const activePointer = useRef(null);
  const sizeOption = SIZE_OPTIONS.find((candidate) => candidate.value === size);
  const ratio = sizeOption?.ratio || 0.75;
  const [frame, setFrame] = useState({ x: 5, y: 5, w: 90 });

  useEffect(() => {
    if (!item || !size) return;
    setFrame(getDefaultFrame(item, size));
  }, [item?.id, item?.rotation, size]);

  useEffect(() => {
    const handleMove = (event) => {
      if (!activePointer.current || !photoRef.current) return;
      const rect = photoRef.current.getBoundingClientRect();
      const dx = (event.clientX - activePointer.current.startX) / rect.width * 100;
      const dy = (event.clientY - activePointer.current.startY) / rect.height * 100;
      const frameHeight = (activePointer.current.startFrame.w / 100 * rect.width / ratio) / rect.height * 100;
      if (activePointer.current.mode === 'move') {
        setFrame((current) => ({
          ...current,
          x: Math.max(0, Math.min(100 - current.w, activePointer.current.startFrame.x + dx)),
          y: Math.max(0, Math.min(100 - frameHeight, activePointer.current.startFrame.y + dy)),
        }));
      } else {
        const maxWByX = 100 - activePointer.current.startFrame.x;
        const maxWByY = (100 - activePointer.current.startFrame.y) * rect.height * ratio / rect.width;
        const nextW = Math.max(42, Math.min(maxWByX, maxWByY, activePointer.current.startFrame.w + dx));
        setFrame((current) => ({ ...current, w: nextW }));
      }
      onAdjust();
    };
    const handleUp = () => { activePointer.current = null; };
    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
    return () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
    };
  }, [onAdjust, ratio]);

  if (!item) {
    return null;
  }

  const hasScheme = !['pending', 'processing'].includes(item.status);
  const canConfirm = ['review', 'adjusted'].includes(item.status);
  const waiting = item.status === 'pending';

  const beginPointer = (event, mode) => {
    event.preventDefault();
    event.stopPropagation();
    if (!hasScheme || phase === 'exporting') return;
    activePointer.current = { mode, startX: event.clientX, startY: event.clientY, startFrame: frame };
  };

  const restore = () => {
    setFrame(getDefaultFrame(item, size));
    onRestore();
  };

  const isQuarterTurn = (item.rotation || 0) % 180 !== 0;

  return (
    <>
      <div className="editor-stage">
        <div className={`photo-wrap ${waiting ? 'waiting' : ''} ${isQuarterTurn ? 'quarter-turn' : ''}`} ref={photoRef}>
          <img
            src={item.src}
            alt={item.name}
            className={isQuarterTurn ? 'quarter-turn-image' : ''}
            style={{ objectPosition: item.objectPosition, transform: `rotate(${item.rotation || 0}deg)` }}
          />
          {hasScheme ? (
            <div
              className="crop-frame"
              style={{ left: `${frame.x}%`, top: `${frame.y}%`, width: `${frame.w}%`, aspectRatio: ratio }}
              onPointerDown={(event) => beginPointer(event, 'move')}
              id="interactive-crop-frame"
            >
              <span className="corner-mark tl"></span>
              <span className="corner-mark tr"></span>
              <span className="corner-mark bl"></span>
              <span className="crop-handle" onPointerDown={(event) => beginPointer(event, 'resize')}></span>
            </div>
          ) : null}
        </div>
        {item.status === 'review' ? (
          <div className="risk-callout">
            <Icon icon={Alert02Icon} />
            <span>模特脚部接近裁剪边界，请检查后确认。</span>
          </div>
        ) : null}
      </div>
      <div className="workspace-footer">
        <div className="footer-left">
          <button
            className="icon-button"
            disabled={['auto', 'exporting'].includes(phase)}
            onClick={() => onRotate(-90)}
            aria-label="向左旋转 90°"
            title="向左旋转 90°"
          >
            <RotateCcw size={16} strokeWidth={1.8} />
          </button>
          <button
            className="icon-button"
            disabled={['auto', 'exporting'].includes(phase)}
            onClick={() => onRotate(90)}
            aria-label="向右旋转 90°"
            title="向右旋转 90°"
          >
            <RotateCw size={16} strokeWidth={1.8} />
          </button>
          <button className="button small" disabled={!hasScheme || phase === 'exporting'} onClick={restore}>
            <Icon icon={Refresh01Icon} />
            恢复自动裁剪
          </button>
        </div>
        <div className="footer-center">
          <button className="icon-button" disabled={index <= 0} onClick={onPrev} aria-label="上一张" title="上一张"><Icon icon={ChevronLeftIcon} /></button>
          <span className="image-index">{index + 1} / {total}</span>
          <button className="icon-button" disabled={index >= total - 1} onClick={onNext} aria-label="下一张" title="下一张"><Icon icon={ChevronRightIcon} /></button>
        </div>
        <div className="footer-right">
          {canConfirm ? (
            <button className="button primary small" onClick={onConfirm} id="confirm-current-image">
              <Icon icon={Tick02Icon} />
              确认当前
            </button>
          ) : null}
        </div>
      </div>
    </>
  );
}

function Modal({ type, onClose, onConfirm, onSelectOutputDir, outputDir, itemCount, size }) {
  const isExit = type === 'exit';
  const isExport = type === 'export';
  const isFolder = type === 'folder';
  const title = isExit ? '退出图片裁剪？' : isExport ? '导出完成' : isFolder ? '选择导出文件夹' : '更换裁剪尺寸？';
  return (
    <div className="modal-backdrop" role="presentation">
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">
        <div className="modal-header">
          <h2 className="modal-title" id="modal-title">{title}</h2>
          <button className="icon-button" aria-label="关闭" onClick={onClose}><Icon icon={Cancel01Icon} /></button>
        </div>
        <div className="modal-body">
          {isExit ? (
            <p className="modal-copy">当前任务还有未导出的图片。退出后，本次裁剪区域和处理结果将被清除，无法恢复。</p>
          ) : isExport ? (
            <>
              <div className="modal-summary">
                <div className="summary-item"><span className="summary-value">{itemCount}</span><span className="summary-label">成功图片</span></div>
                <div className="summary-item"><span className="summary-value">0</span><span className="summary-label">失败图片</span></div>
                <div className="summary-item"><span className="summary-value">{size}</span><span className="summary-label">输出尺寸</span></div>
              </div>
              <div className="modal-path">{outputDir}</div>
            </>
          ) : isFolder ? (
            <div className="folder-options">
              {[
                '~/Downloads/Lumina-Crops',
                '~/Desktop/电商裁剪',
                '~/Pictures/Lumina-Crops',
              ].map((path) => (
                <button
                  className={`folder-option ${outputDir === path ? 'selected' : ''}`}
                  type="button"
                  key={path}
                  onClick={() => onSelectOutputDir(path)}
                >
                  <Icon icon={FolderOpenIcon} />
                  <span>{path}</span>
                  {outputDir === path ? <Icon icon={Tick02Icon} /> : null}
                </button>
              ))}
            </div>
          ) : null}
        </div>
        <div className="modal-footer">
          {isExit ? (
            <>
              <button className="button small" onClick={onClose}>继续处理</button>
              <button className="button primary small" onClick={onConfirm}>退出并放弃</button>
            </>
          ) : isFolder ? (
            <button className="button small" onClick={onClose}>取消</button>
          ) : (
            <button className="button primary small" onClick={onClose}>完成</button>
          )}
        </div>
      </div>
    </div>
  );
}

function Workbench({ backHandler, onExit }) {
  const [size, setSizeValue] = useState('');
  const [outputDir, setOutputDir] = useState('');
  const [items, setItems] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [filter, setFilter] = useState('all');
  const [phase, setPhase] = useState('idle');
  const [phaseItemIds, setPhaseItemIds] = useState([]);
  const [progress, setProgress] = useState(0);
  const [modal, setModal] = useState(null);
  const [toast, setToast] = useState('');

  const selectedIndex = Math.max(0, items.findIndex((item) => item.id === selectedId));
  const selectedItem = items.find((item) => item.id === selectedId) || items[0] || null;
  const dirty = items.length > 0 && items.some((item) => item.status !== 'exported');

  const showToast = (message) => {
    setToast(message);
    window.clearTimeout(showToast.timer);
    showToast.timer = window.setTimeout(() => setToast(''), 2200);
  };

  useEffect(() => {
    if (!selectedId && items.length) setSelectedId(items[0].id);
  }, [items, selectedId]);

  useEffect(() => {
    if (phase === 'idle') return undefined;
    if (progress >= phaseItemIds.length) {
      if (phase === 'auto') {
        setItems((current) => current.map((item) => phaseItemIds.includes(item.id)
          ? { ...item, status: item.risk ? 'review' : 'auto' }
          : item));
        setPhase('idle');
        const firstRisk = items.find((item) => phaseItemIds.includes(item.id) && item.risk);
        if (firstRisk) setSelectedId(firstRisk.id);
        const reviewCount = items.filter((item) => phaseItemIds.includes(item.id) && item.risk).length;
        showToast(reviewCount > 0 ? `自动裁剪方案已生成，${reviewCount} 张图片需要检查` : '自动裁剪方案已生成');
      } else if (phase === 'exporting') {
        setItems((current) => current.map((item) => phaseItemIds.includes(item.id) ? { ...item, status: 'exported' } : item));
        setPhase('idle');
        setModal('export');
      }
      return undefined;
    }
    const timer = window.setTimeout(() => {
      setProgress((current) => current + 1);
      if (phase === 'auto') {
        const processingId = phaseItemIds[progress];
        setItems((current) => current.map((item) => item.id === processingId ? { ...item, status: 'processing' } : item));
      } else if (phase === 'exporting') {
        const exportingId = phaseItemIds[progress];
        setItems((current) => current.map((item) => item.id === exportingId ? { ...item, status: 'exporting' } : item));
      }
    }, phase === 'auto' ? 105 : 90);
    return () => window.clearTimeout(timer);
  }, [phase, progress, phaseItemIds]);

  const setSize = (nextSize) => {
    if (items.some((item) => !['pending'].includes(item.status)) && nextSize !== size) {
      showToast('原型提示：实际产品中这里会先确认是否清除现有方案');
      setItems((current) => current.map((item) => ({ ...item, status: 'pending' })));
    }
    setSizeValue(nextSize);
  };

  const addFiles = (files) => {
    const remaining = Math.max(0, 100 - items.length);
    const accepted = files.filter((file) => ['image/jpeg', 'image/png'].includes(file.type) && file.size <= 60 * 1024 * 1024).slice(0, remaining);
    const next = accepted.map((file, index) => ({
      id: `local-${Date.now()}-${index}`,
      name: file.name,
      size: `${(file.size / 1024 / 1024).toFixed(1)} MB`,
      src: URL.createObjectURL(file),
      status: 'pending',
      risk: index % 7 === 4,
      objectPosition: '50% 50%',
      rotation: 0,
    }));
    setItems((current) => [...current, ...next]);
    if (!selectedId && next.length) setSelectedId(next[0].id);
    showToast(`已添加 ${next.length} 张图片${accepted.length < files.length ? `，${files.length - accepted.length} 张未添加` : ''}`);
  };

  const startPhase = (nextPhase) => {
    const allAlreadyExported = items.every((item) => item.status === 'exported');
    const targetIds = items.filter((item) => nextPhase === 'auto'
      ? ['pending', 'error'].includes(item.status)
      : item.status !== 'processing' && (allAlreadyExported || item.status !== 'exported')).map((item) => item.id);
    setPhaseItemIds(targetIds);
    setProgress(0);
    setPhase(nextPhase);
  };

  const adjustCurrent = () => {
    if (!selectedItem || ['pending', 'processing', 'exporting'].includes(selectedItem.status)) return;
    setItems((current) => current.map((item) => item.id === selectedItem.id ? { ...item, status: 'adjusted' } : item));
  };

  const confirmCurrent = () => {
    if (!selectedItem) return;
    const nextItems = items.map((item) => item.id === selectedItem.id ? { ...item, status: 'confirmed' } : item);
    setItems(nextItems);
    const nextRisk = nextItems.find((item) => item.status === 'review');
    if (nextRisk) {
      setSelectedId(nextRisk.id);
      setFilter('review');
    } else {
      setFilter('all');
      showToast('所有风险图片已确认，可以开始批量裁剪');
    }
  };

  const restoreCurrent = () => {
    if (!selectedItem) return;
    setItems((current) => current.map((item) => item.id === selectedItem.id ? { ...item, status: item.risk ? 'review' : 'auto' } : item));
  };

  const rotateCurrent = (degrees) => {
    if (!selectedItem || ['auto', 'exporting'].includes(phase)) return;
    const hadScheme = !['pending', 'processing'].includes(selectedItem.status);
    setItems((current) => current.map((item) => item.id === selectedItem.id
      ? { ...item, rotation: ((item.rotation || 0) + degrees + 360) % 360, status: 'pending' }
      : item));
    setFilter('all');
    if (hadScheme) showToast('图片方向已调整，请重新生成裁剪方案');
  };

  const requestBack = () => {
    if (dirty) setModal('exit');
    else onExit();
  };

  useEffect(() => {
    backHandler.current = requestBack;
  }, [dirty, items.length]);

  const statusClass = selectedItem?.status || 'pending';

  return (
    <section className="workbench" data-screen-label="图片裁剪工作台">
      <Sidebar
        size={size}
        setSize={setSize}
        items={items}
        selectedId={selectedItem?.id || null}
        setSelectedId={setSelectedId}
        addFiles={addFiles}
        filter={filter}
        setFilter={setFilter}
        phase={phase}
        progress={progress}
        phaseTotal={phaseItemIds.length}
        startAuto={() => startPhase('auto')}
        requestExport={() => setModal('folder')}
      />
      <main className="workspace">
        <header className="workspace-header">
          <div className="workspace-title-wrap">
            <h1 className="workspace-file">{selectedItem?.name || '图片裁剪'}</h1>
            {selectedItem ? <p className="workspace-subtitle">{selectedItem.size} · 输出 {size || '未选择'}</p> : null}
          </div>
          {selectedItem ? (
            <span className={`status-chip ${statusClass}`}><span className={`status-dot ${statusClass}`}></span>{STATUS_LABELS[selectedItem.status]}</span>
          ) : null}
        </header>
        <div className="editor-area">
          <CropEditor
            item={selectedItem}
            size={size}
            phase={phase}
            onAdjust={adjustCurrent}
            onConfirm={confirmCurrent}
            onRestore={restoreCurrent}
            onRotate={rotateCurrent}
            onPrev={() => setSelectedId(items[Math.max(0, selectedIndex - 1)]?.id)}
            onNext={() => setSelectedId(items[Math.min(items.length - 1, selectedIndex + 1)]?.id)}
            index={selectedIndex}
            total={items.length}
          />
        </div>
      </main>
      {modal ? (
        <Modal
          type={modal}
          itemCount={modal === 'export' ? phaseItemIds.length : items.length}
          size={size}
          outputDir={outputDir}
          onClose={() => setModal(null)}
          onConfirm={() => { setModal(null); onExit(); }}
          onSelectOutputDir={(path) => {
            setOutputDir(path);
            setModal(null);
            startPhase('exporting');
          }}
        />
      ) : null}
      {toast ? <div className="toast"><Icon icon={Tick02Icon} />{toast}</div> : null}
    </section>
  );
}

function App() {
  const [screen, setScreen] = useState('home');
  const [theme, setTheme] = useState('dark');
  const backHandler = useRef(() => setScreen('home'));

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  return (
    <div className="app-shell">
      <TitleBar
        screen={screen}
        theme={theme}
        onTheme={() => setTheme((current) => current === 'dark' ? 'light' : 'dark')}
        onBack={() => backHandler.current?.()}
      />
      <div className="main-area">
        {screen === 'home' ? (
          <Home onOpenCrop={() => setScreen('crop')} />
        ) : (
          <Workbench backHandler={backHandler} onExit={() => setScreen('home')} />
        )}
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')).render(<App />);
