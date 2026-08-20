import React, { useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  Check,
  ChevronLeft,
  ChevronRight,
  Crop,
  Download,
  ImagePlus,
  Languages,
  LoaderCircle,
  Maximize2,
  Minus,
  Moon,
  Move,
  Plus,
  Redo2,
  RefreshCw,
  Scan,
  Settings,
  Sparkles,
  Sun,
  Trash2,
  Undo2,
  X,
} from 'lucide-react';

export const ASSETS = {
  fullbody: './assets/model-fullbody-clean.jpg',
  coat: './assets/model-coat-clean.jpg',
  vest: './assets/model-vest-clean.jpg',
};

export const TARGETS = [
  { id: '1440x1440', label: '1440×1440', width: 1440, height: 1440 },
  { id: '1440x1920', label: '1440×1920', width: 1440, height: 1920 },
  { id: '1440x2200', label: '1440×2200', width: 1440, height: 2200 },
];

export const INITIAL_ITEMS = [
  {
    id: 'coat', name: '7.2187126.jpg', asset: ASSETS.fullbody, width: 750, height: 1140,
    fileSize: '6.8 MB', mode: 'fixed', crop: { offset: 50, confirmed: false },
    fixed: { zoom: 78, pan: { x: 7, y: 0 }, stage: 'compose', tool: null, selection: null, stretches: [], ai: 'idle', ready: false },
  },
  {
    id: 'vest', name: 'KNIT_0314.jpg', asset: ASSETS.vest, width: 780, height: 1185,
    fileSize: '5.4 MB', mode: 'crop', crop: { offset: 48, confirmed: true },
    fixed: { zoom: 82, pan: { x: 0, y: 0 }, stage: 'compose', tool: null, selection: null, stretches: [], ai: 'idle', ready: false },
  },
  {
    id: 'look', name: 'LOOK_0927.jpg', asset: ASSETS.coat, width: 790, height: 1175,
    fileSize: '8.2 MB', mode: 'fixed', crop: { offset: 54, confirmed: false },
    fixed: { zoom: 72, pan: { x: 1, y: 1 }, stage: 'fill', tool: null, selection: null, stretches: [], ai: 'idle', ready: true },
  },
];

export const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export function imageBoxFor(item, target) {
  const sourceRatio = item.width / item.height;
  const targetRatio = target.width / target.height;
  const base = sourceRatio > targetRatio
    ? { width: 100, height: 100 * targetRatio / sourceRatio }
    : { width: 100 * sourceRatio / targetRatio, height: 100 };
  const width = base.width * item.fixed.zoom / 100;
  const height = base.height * item.fixed.zoom / 100;
  return {
    x: 50 + item.fixed.pan.x - width / 2,
    y: 50 + item.fixed.pan.y - height / 2,
    width,
    height,
  };
}

export function itemStatus(item) {
  if (item.mode === 'crop') return item.crop.confirmed ? '可导出' : '待确认';
  if (item.fixed.ai === 'processing') return 'AI 补全中';
  if (item.fixed.ai === 'review') return 'AI 待确认';
  if (item.fixed.ready) return '可导出';
  return item.fixed.stage === 'compose' ? '调整构图' : '待填充';
}

export function IconButton({ label, active = false, className = '', children, ...props }) {
  return (
    <button className={`icon-button ${active ? 'active' : ''} ${className}`} aria-label={label} title={label} type="button" {...props}>
      {children}
    </button>
  );
}

export function Segmented({ value, options, onChange, ariaLabel, disabled = false, className = '' }) {
  return (
    <div className={`segmented ${className}`} role="group" aria-label={ariaLabel}>
      {options.map((option) => (
        <button key={option.value} type="button" className={value === option.value ? 'active' : ''}
          disabled={disabled || option.disabled} onClick={() => onChange(option.value)}>{option.label}</button>
      ))}
    </div>
  );
}

export function TitleBar({ theme, onToggleTheme }) {
  return (
    <header className="titlebar">
      <div className="traffic-lights" aria-hidden="true"><span></span><span></span><span></span></div>
      <div className="titlebar-center">
        <IconButton label="返回首页"><ArrowLeft size={16} /></IconButton>
        <strong>图片适配 - Lumina</strong>
      </div>
      <div className="titlebar-actions">
        <IconButton label="切换语言"><Languages size={16} /></IconButton>
        <IconButton label="切换主题" onClick={onToggleTheme}>{theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}</IconButton>
        <IconButton label="设置"><Settings size={16} /></IconButton>
      </div>
    </header>
  );
}

export function Sidebar({ targetId, items, selectedId, filter, onTargetChange, onSelect, onFilterChange, onExport }) {
  const visible = items.filter((item) => filter === 'all' || itemStatus(item) !== '可导出');
  const exportable = items.filter((item) => itemStatus(item) === '可导出').length;
  return (
    <aside className="sidebar">
      <section className="sidebar-section target-section">
        <div className="section-label">输出尺寸</div>
        <Segmented value={targetId} ariaLabel="输出尺寸" onChange={onTargetChange}
          options={TARGETS.map((target) => ({ value: target.id, label: target.label }))} />
      </section>
      <section className="sidebar-section add-section">
        <button className="secondary-button full" type="button"><ImagePlus size={15} />添加图片</button>
      </section>
      <div className="list-toolbar">
        <div className="list-filters">
          <button className={filter === 'all' ? 'active' : ''} type="button" onClick={() => onFilterChange('all')}>全部</button>
          <button className={filter === 'pending' ? 'active' : ''} type="button" onClick={() => onFilterChange('pending')}>待处理 {items.length - exportable}</button>
        </div>
        <span>{items.length}/100</span>
      </div>
      <div className="image-list">
        {visible.map((item) => {
          const status = itemStatus(item);
          return (
            <button className={`image-row ${selectedId === item.id ? 'selected' : ''}`} type="button" key={item.id} onClick={() => onSelect(item.id)}>
              <img src={item.asset} alt="" />
              <span className="image-copy">
                <strong>{item.name}</strong>
                <small>{item.mode === 'crop' ? '裁剪填满' : '固定画布'} · {item.fileSize}</small>
              </span>
              <span className={`status-dot ${status === '可导出' ? 'ready' : status.includes('AI') ? 'ai' : 'pending'}`}></span>
              <span className="row-status">{status}</span>
            </button>
          );
        })}
      </div>
      <div className="sidebar-footer">
        <button className="primary-button full" type="button" disabled={!exportable} onClick={onExport}>
          <Download size={16} />批量导出 {exportable} 张
        </button>
      </div>
    </aside>
  );
}

function pointInCanvas(event, element) {
  const rect = element.getBoundingClientRect();
  return {
    x: clamp((event.clientX - rect.left) / rect.width * 100, 0, 100),
    y: clamp((event.clientY - rect.top) / rect.height * 100, 0, 100),
  };
}

function intersects(rect, box) {
  return rect.x < box.x + box.width && rect.x + rect.width > box.x
    && rect.y < box.y + box.height && rect.y + rect.height > box.y;
}

function destinationFor(operation) {
  const { source, direction, amount } = operation;
  if (direction === 'left') return { x: source.x - amount, y: source.y, width: source.width + amount, height: source.height };
  if (direction === 'right') return { x: source.x, y: source.y, width: source.width + amount, height: source.height };
  if (direction === 'top') return { x: source.x, y: source.y - amount, width: source.width, height: source.height + amount };
  return { x: source.x, y: source.y, width: source.width, height: source.height + amount };
}

function StretchPatch({ operation, item, imageBox, live = false }) {
  const destination = destinationFor(operation);
  return (
    <div className={`stretch-patch ${live ? 'live' : ''}`} style={{ left: `${destination.x}%`, top: `${destination.y}%`, width: `${destination.width}%`, height: `${destination.height}%` }}>
      <img src={item.asset} alt="" draggable="false" style={{
        left: `${-(operation.source.x - imageBox.x) / operation.source.width * 100}%`,
        top: `${-(operation.source.y - imageBox.y) / operation.source.height * 100}%`,
        width: `${imageBox.width / operation.source.width * 100}%`,
        height: `${imageBox.height / operation.source.height * 100}%`,
      }} />
    </div>
  );
}

export function FixedCanvas({ item, target, onChange, onToast }) {
  const canvasRef = useRef(null);
  const [gesture, setGesture] = useState(null);
  const [liveStretch, setLiveStretch] = useState(null);
  const imageBox = useMemo(() => imageBoxFor(item, target), [item, target]);
  const fixed = item.fixed;
  const canvasRatio = `${target.width} / ${target.height}`;

  const updateSelection = (start, point) => ({
    x: Math.min(start.x, point.x), y: Math.min(start.y, point.y),
    width: Math.abs(point.x - start.x), height: Math.abs(point.y - start.y),
  });

  const handlePointerDown = (event) => {
    if (fixed.ai === 'processing' || fixed.ai === 'review') return;
    const point = pointInCanvas(event, canvasRef.current);
    canvasRef.current.setPointerCapture?.(event.pointerId);
    if (fixed.stage === 'fill' && fixed.tool === 'select') {
      setGesture({ type: 'select', start: point });
      onChange({ selection: { ...point, width: 0, height: 0 } });
    }
  };

  const handlePointerMove = (event) => {
    if (!gesture) return;
    const point = pointInCanvas(event, canvasRef.current);
    if (gesture.type === 'move') {
      onChange({ pan: { x: clamp(gesture.pan.x + point.x - gesture.start.x, -80, 80), y: clamp(gesture.pan.y + point.y - gesture.start.y, -80, 80) }, ready: false });
    } else if (gesture.type === 'scale') {
      const distance = Math.hypot(point.x - gesture.anchor.x, point.y - gesture.anchor.y);
      const zoom = clamp(gesture.zoom * distance / gesture.distance, 20, 200);
      const factor = zoom / gesture.zoom;
      const width = gesture.box.width * factor;
      const height = gesture.box.height * factor;
      const signX = gesture.corner.endsWith('e') ? 1 : -1;
      const signY = gesture.corner.startsWith('s') ? 1 : -1;
      const centerX = gesture.anchor.x + signX * width / 2;
      const centerY = gesture.anchor.y + signY * height / 2;
      onChange({ zoom: Math.round(zoom), pan: { x: centerX - 50, y: centerY - 50 }, ready: false });
    } else if (gesture.type === 'select') {
      onChange({ selection: updateSelection(gesture.start, point) });
    } else if (gesture.type === 'stretch') {
      const source = gesture.source;
      let amount = 0;
      if (gesture.direction === 'left') amount = clamp(source.x - point.x, 0, source.x);
      if (gesture.direction === 'right') amount = clamp(point.x - source.x - source.width, 0, 100 - source.x - source.width);
      if (gesture.direction === 'top') amount = clamp(source.y - point.y, 0, source.y);
      if (gesture.direction === 'bottom') amount = clamp(point.y - source.y - source.height, 0, 100 - source.y - source.height);
      setLiveStretch({ source, direction: gesture.direction, amount });
    }
  };

  const handlePointerUp = () => {
    if (!gesture) return;
    if (gesture.type === 'select') {
      const selection = fixed.selection;
      if (!selection || selection.width < 2 || selection.height < 2) {
        onChange({ selection: null });
        onToast('选区过小，请重新选择');
      } else if (!intersects(selection, imageBox)) {
        onChange({ selection: null });
        onToast('请在图片内容中选择需要拉伸的区域');
      }
    }
    if (gesture.type === 'stretch' && liveStretch?.amount > 0.5) {
      onChange({ stretches: [...fixed.stretches, { ...liveStretch, id: Date.now() }], selection: null, tool: null, ready: true });
      onToast(`已添加第 ${fixed.stretches.length + 1} 个拉伸区域`);
    }
    setGesture(null);
    setLiveStretch(null);
  };

  const startStretch = (event, direction) => {
    event.stopPropagation();
    if (!fixed.selection) return;
    canvasRef.current.setPointerCapture?.(event.pointerId);
    setGesture({ type: 'stretch', source: fixed.selection, direction });
  };

  const startMove = (event) => {
    event.stopPropagation();
    const point = pointInCanvas(event, canvasRef.current);
    canvasRef.current.setPointerCapture?.(event.pointerId);
    setGesture({ type: 'move', start: point, pan: fixed.pan });
  };

  const startScale = (event, corner) => {
    event.stopPropagation();
    const point = pointInCanvas(event, canvasRef.current);
    const anchor = {
      x: corner.endsWith('e') ? imageBox.x : imageBox.x + imageBox.width,
      y: corner.startsWith('s') ? imageBox.y : imageBox.y + imageBox.height,
    };
    canvasRef.current.setPointerCapture?.(event.pointerId);
    setGesture({
      type: 'scale', corner, anchor, box: imageBox, zoom: fixed.zoom,
      distance: Math.max(1, Math.hypot(point.x - anchor.x, point.y - anchor.y)),
    });
  };

  const availableDirections = {
    left: imageBox.x > 1,
    right: imageBox.x + imageBox.width < 99,
    top: imageBox.y > 1,
    bottom: imageBox.y + imageBox.height < 99,
  };
  const operations = liveStretch ? [...fixed.stretches, liveStretch] : fixed.stretches;

  return (
    <div className="canvas-shell">
      <div className={`fixed-canvas stage-${fixed.stage} tool-${fixed.tool || 'move'}`} ref={canvasRef}
        style={{ aspectRatio: canvasRatio }} onPointerDown={handlePointerDown} onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp} onPointerCancel={handlePointerUp}>
        <div className="canvas-size-label">{target.label}</div>
        <img className="placed-image" src={item.asset} alt={item.name} draggable="false"
          style={{ left: `${imageBox.x}%`, top: `${imageBox.y}%`, width: `${imageBox.width}%`, height: `${imageBox.height}%` }} />
        {fixed.stage === 'compose' ? (
          <div className="transform-box" style={{ left: `${imageBox.x}%`, top: `${imageBox.y}%`, width: `${imageBox.width}%`, height: `${imageBox.height}%` }} onPointerDown={startMove}>
            {['nw', 'ne', 'sw', 'se'].map((corner) => (
              <button key={corner} className={`transform-handle ${corner}`} type="button" aria-label="等比缩放图片" title="拖动等比缩放" onPointerDown={(event) => startScale(event, corner)}></button>
            ))}
          </div>
        ) : null}
        {operations.map((operation, index) => <StretchPatch key={operation.id || `live-${index}`} operation={operation} item={item} imageBox={imageBox} live={!operation.id} />)}
        {fixed.selection ? (
          <div className="pixel-selection" style={{ left: `${fixed.selection.x}%`, top: `${fixed.selection.y}%`, width: `${fixed.selection.width}%`, height: `${fixed.selection.height}%` }}>
            {availableDirections.left ? <button className="stretch-handle left" type="button" aria-label="向左拉伸" title="向左拉伸" onPointerDown={(event) => startStretch(event, 'left')}></button> : null}
            {availableDirections.right ? <button className="stretch-handle right" type="button" aria-label="向右拉伸" title="向右拉伸" onPointerDown={(event) => startStretch(event, 'right')}></button> : null}
            {availableDirections.top ? <button className="stretch-handle top" type="button" aria-label="向上拉伸" title="向上拉伸" onPointerDown={(event) => startStretch(event, 'top')}></button> : null}
            {availableDirections.bottom ? <button className="stretch-handle bottom" type="button" aria-label="向下拉伸" title="向下拉伸" onPointerDown={(event) => startStretch(event, 'bottom')}></button> : null}
          </div>
        ) : null}
        {fixed.ai === 'processing' ? <div className="processing-overlay"><LoaderCircle size={24} className="spin" /><strong>AI 正在补全画布</strong><span>已读取完整构图</span></div> : null}
        {fixed.ai === 'review' ? <div className="ai-result-mark"><Sparkles size={13} />AI 结果</div> : null}
      </div>
    </div>
  );
}

export function CropCanvas({ item, target, onCropChange }) {
  return (
    <div className="canvas-shell">
      <div className="crop-canvas" style={{ aspectRatio: `${target.width} / ${target.height}` }}>
        <img src={item.asset} alt={item.name} draggable="false" style={{ objectPosition: `${item.crop.offset}% 50%` }} />
        <div className="crop-grid"><i></i><i></i><i></i><i></i></div>
        <input className="crop-position" aria-label="调整裁剪位置" type="range" min="20" max="80" value={item.crop.offset} onChange={(event) => onCropChange(Number(event.target.value))} />
      </div>
    </div>
  );
}

function ModeSwitch({ item, disabled, onModeChange }) {
  return (
    <div className="mode-switch-wrap">
      <span>当前图片</span>
      <Segmented value={item.mode} disabled={disabled} ariaLabel="当前图片构图方式" onChange={onModeChange}
        options={[{ value: 'crop', label: '裁剪填满' }, { value: 'fixed', label: '固定画布' }]} />
    </div>
  );
}

export function Editor({ item, target, index, total, onItemChange, onModeChange, onNavigate, onAI, onToast }) {
  const status = itemStatus(item);
  const busy = item.fixed.ai === 'processing';
  const fixed = item.fixed;
  const changeFixed = (patch) => onItemChange({ fixed: { ...fixed, ...patch } });
  const previous = () => onNavigate(Math.max(0, index - 1));
  const next = () => onNavigate(Math.min(total - 1, index + 1));
  return (
    <main className="editor" data-screen-label="图片适配工作台">
      <header className="editor-header">
        <div className="file-heading"><strong>{item.name}</strong><small>{item.width}×{item.height} · 输出 {target.label}</small></div>
        <ModeSwitch item={item} disabled={busy || fixed.ai === 'review'} onModeChange={onModeChange} />
        <span className={`status-badge ${status === '可导出' ? 'ready' : status.includes('AI') ? 'ai' : ''}`}>
          {item.mode === 'fixed' && fixed.ai === 'idle' && !fixed.ready
            ? (fixed.stage === 'compose' ? '1/2 调整构图' : '2/2 填充空白')
            : status}
        </span>
      </header>
      <section className="workspace">
        {item.mode === 'crop'
          ? <CropCanvas item={item} target={target} onCropChange={(offset) => onItemChange({ crop: { ...item.crop, offset, confirmed: false } })} />
          : <FixedCanvas item={item} target={target} onChange={changeFixed} onToast={onToast} />}
      </section>
      <footer className="editor-footer">
        <div className="footer-left">
          {item.mode === 'crop' ? (
            <button className="secondary-button" type="button" onClick={() => onItemChange({ crop: { offset: 50, confirmed: false } })}><RefreshCw size={14} />恢复自动</button>
          ) : fixed.stage === 'compose' ? (
            <>
              <span className="control-label">整图缩放</span>
              <IconButton label="缩小" onClick={() => changeFixed({ zoom: clamp(fixed.zoom - 5, 20, 200), ready: false })}><Minus size={15} /></IconButton>
              <input className="zoom-slider" aria-label="整图缩放" type="range" min="20" max="200" value={fixed.zoom} onChange={(event) => changeFixed({ zoom: Number(event.target.value), ready: false })} />
              <span className="mono-value">{fixed.zoom}%</span>
              <IconButton label="放大" onClick={() => changeFixed({ zoom: clamp(fixed.zoom + 5, 20, 200), ready: false })}><Plus size={15} /></IconButton>
              <button className="secondary-button compact" type="button" onClick={() => changeFixed({ zoom: 100, pan: { x: 0, y: 0 }, ready: false })}><Maximize2 size={14} />完整显示</button>
            </>
          ) : (
            <>
              <IconButton label="撤销拉伸" disabled={!fixed.stretches.length} onClick={() => changeFixed({ stretches: fixed.stretches.slice(0, -1) })}><Undo2 size={15} /></IconButton>
              <IconButton label="重做拉伸" disabled><Redo2 size={15} /></IconButton>
              <span className="operation-count">{fixed.stretches.length} 个拉伸区域</span>
            </>
          )}
        </div>
        <div className="footer-center">
          {item.mode === 'fixed' && fixed.stage === 'fill' && fixed.ai === 'idle' ? (
            <div className="fill-tools">
              <button className={`tool-button ${fixed.tool === 'select' ? 'active' : ''}`} type="button" onClick={() => changeFixed({ tool: fixed.tool === 'select' ? null : 'select', selection: null })}><Scan size={15} />区域拉伸</button>
              <button className="tool-button ai" type="button" onClick={onAI}><Sparkles size={15} />AI 补全</button>
            </div>
          ) : item.mode === 'fixed' && fixed.stage === 'compose' ? (
            <div className="fill-tools future-tools" aria-label="确认构图后可用">
              <button className="tool-button" type="button" disabled title="确认构图后可用"><Scan size={15} />区域拉伸</button>
              <button className="tool-button ai" type="button" disabled title="确认构图后可用"><Sparkles size={15} />AI 补全</button>
            </div>
          ) : (
            <div className="navigator"><IconButton label="上一张" disabled={index === 0} onClick={previous}><ChevronLeft size={16} /></IconButton><span>{index + 1}/{total}</span><IconButton label="下一张" disabled={index === total - 1} onClick={next}><ChevronRight size={16} /></IconButton></div>
          )}
        </div>
        <div className="footer-right">
          {item.mode === 'crop' ? (
            <button className="primary-button" type="button" onClick={() => { onItemChange({ crop: { ...item.crop, confirmed: true } }); onToast('当前图片已确认'); }}><Check size={15} />确认当前</button>
          ) : fixed.ai === 'review' ? (
            <><button className="text-button" type="button" onClick={() => changeFixed({ ai: 'idle', stage: 'fill' })}>放弃结果</button><button className="secondary-button" type="button" onClick={onAI}><RefreshCw size={14} />重新生成</button><button className="primary-button" type="button" onClick={() => { changeFixed({ ai: 'accepted', stage: 'fill', ready: true }); onToast('AI 结果已接受'); }}><Check size={15} />接受结果</button></>
          ) : fixed.stage === 'compose' ? (
            <><button className="secondary-button" type="button" onClick={() => changeFixed({ zoom: 100, pan: { x: 0, y: 0 }, ready: false })}><RefreshCw size={14} />恢复初始</button><button className="primary-button" type="button" onClick={() => changeFixed({ stage: 'fill', tool: null, selection: null })}><Check size={15} />确认构图</button></>
          ) : (
            <><button className="text-button" type="button" onClick={() => changeFixed({ stage: 'compose', tool: null, selection: null })}>返回调整</button><button className="primary-button" type="button" onClick={() => { changeFixed({ ready: true, tool: null, selection: null }); onToast('固定画布结果已保存'); }}><Check size={15} />完成填充</button></>
          )}
        </div>
      </footer>
    </main>
  );
}

export function Modal({ title, children, footer, onClose, className = '' }) {
  return (
    <div className="modal-backdrop" role="presentation">
      <section className={`modal ${className}`} role="dialog" aria-modal="true" aria-label={title}>
        <header><strong>{title}</strong><IconButton label="关闭" onClick={onClose}><X size={16} /></IconButton></header>
        <div className="modal-body">{children}</div>
        <footer>{footer}</footer>
      </section>
    </div>
  );
}
