import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  AlertTriangle,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Check,
  ChevronLeft,
  ChevronRight,
  Download,
  ImagePlus,
  Languages,
  LoaderCircle,
  Moon,
  Move,
  Plus,
  RefreshCw,
  RotateCcw,
  RotateCw,
  Settings,
  Sparkles,
  Sun,
  WandSparkles,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';

const ASSETS = {
  fullbody: './assets/model-fullbody-clean.jpg',
};

const TARGETS = [
  { id: '1440x1440', label: '1440×1440', width: 1440, height: 1440 },
  { id: '1440x1920', label: '1440×1920', width: 1440, height: 1920 },
  { id: '1440x2200', label: '1440×2200', width: 1440, height: 2200 },
];

const INITIAL_BATCH = {
  composition: 'preserve',
  fill: 'edge',
  model: 'FHL · GPT Image 2',
  quality: '2K',
  description: '',
  zoom: 100,
  pan: { x: -1, y: 0 },
  sampleMode: 'auto',
  sampleDirection: 'left',
  sampleWidth: 10,
};

const INITIAL_ITEMS = [
  {
    id: 'coat',
    name: '7.2187126.jpg',
    asset: ASSETS.fullbody,
    width: 750,
    height: 1140,
    fileSize: '6.8 MB',
    followBatch: true,
    settings: null,
    status: 'review',
  },
  {
    id: 'ai-look',
    name: 'LOOK_0927.jpg',
    asset: ASSETS.fullbody,
    width: 750,
    height: 1140,
    fileSize: '8.2 MB',
    followBatch: false,
    settings: {
      ...INITIAL_BATCH,
      fill: 'ai',
      zoom: 72,
      pan: { x: 0, y: 0 },
      description: '延续街道地面和建筑透视，保持原有光线。',
    },
    status: 'ai-pending',
  },
  {
    id: 'vest',
    name: 'KNIT_0314.jpg',
    asset: ASSETS.fullbody,
    width: 750,
    height: 1140,
    fileSize: '5.4 MB',
    followBatch: false,
    settings: {
      ...INITIAL_BATCH,
      composition: 'crop',
      fill: 'edge',
      zoom: 100,
      pan: { x: 0, y: 0 },
    },
    status: 'auto',
  },
];

const STATUS_LABELS = {
  auto: '自动完成',
  review: '需检查',
  adjusted: '已调整',
  confirmed: '已确认',
  'ai-pending': '待 AI 补全',
  'ai-processing': 'AI 补全中',
  'ai-review': 'AI 待确认',
  exporting: '导出中',
  exported: '已导出',
  error: '处理失败',
};

function resolveSettings(item, batch) {
  return item?.followBatch ? batch : (item?.settings || batch);
}

function statusForSettings(settings) {
  if (settings.composition === 'crop') return 'auto';
  return settings.fill === 'ai' ? 'ai-pending' : 'review';
}

function IconButton({ label, children, className = '', ...props }) {
  return (
    <button className={`icon-button ${className}`} aria-label={label} title={label} type="button" {...props}>
      {children}
    </button>
  );
}

function Segmented({ value, options, onChange, className = '', disabled = false, ariaLabel }) {
  return (
    <div className={`segmented ${className}`} role="group" aria-label={ariaLabel}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className={value === option.value ? 'active' : ''}
          disabled={disabled || option.disabled}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function TitleBar({ theme, onToggleTheme }) {
  return (
    <header className="titlebar">
      <div className="traffic-lights" aria-hidden="true">
        <span className="traffic-light red"></span>
        <span className="traffic-light yellow"></span>
        <span className="traffic-light green"></span>
      </div>
      <div className="titlebar-center">
        <IconButton label="返回首页"><ArrowLeft size={16} strokeWidth={1.8} /></IconButton>
        <span className="titlebar-title">图片适配 - Lumina</span>
      </div>
      <div className="titlebar-actions">
        <IconButton label="切换语言"><Languages size={16} strokeWidth={1.8} /></IconButton>
        <IconButton label="切换主题" onClick={onToggleTheme}>
          {theme === 'dark' ? <Sun size={16} strokeWidth={1.8} /> : <Moon size={16} strokeWidth={1.8} />}
        </IconButton>
        <IconButton label="设置"><Settings size={16} strokeWidth={1.8} /></IconButton>
      </div>
    </header>
  );
}

function SettingsPanel({
  targetId,
  onTargetChange,
  scope,
  onScopeChange,
  settings,
  selected,
  onSettingChange,
  onRestoreBatch,
  busy,
}) {
  const isSingle = selected && !selected.followBatch;
  return (
    <div className="settings-panel">
      <div className="field-block">
        <div className="field-row">
          <span className="field-label">输出尺寸</span>
        </div>
        <Segmented
          value={targetId}
          disabled={busy}
          ariaLabel="输出尺寸"
          onChange={onTargetChange}
          options={TARGETS.map((target) => ({ value: target.id, label: target.label }))}
        />
      </div>

      <div className="field-block">
        <div className="field-row">
          <span className="field-label">设置范围</span>
          <span className={`scope-note ${isSingle ? 'single' : ''}`}>
            {isSingle ? '单图设置' : '跟随批次'}
            {isSingle ? <button type="button" disabled={busy} onClick={onRestoreBatch}>恢复批次</button> : null}
          </span>
        </div>
        <Segmented
          value={scope}
          className="scope"
          disabled={busy}
          ariaLabel="设置范围"
          onChange={onScopeChange}
          options={[
            { value: 'batch', label: '整批默认' },
            { value: 'current', label: '当前图片' },
          ]}
        />
      </div>

      <div className="field-block">
        <div className="field-row"><span className="field-label">构图方式</span></div>
        <Segmented
          value={settings.composition}
          disabled={busy}
          ariaLabel="构图方式"
          onChange={(value) => onSettingChange({ composition: value })}
          options={[
            { value: 'crop', label: '裁剪填满' },
            { value: 'preserve', label: '保全画面' },
          ]}
        />
      </div>

      {settings.composition === 'preserve' ? (
        <div className="field-block">
          <div className="field-row"><span className="field-label">空白填充</span></div>
          <Segmented
            value={settings.fill}
            disabled={busy}
            ariaLabel="空白填充"
            onChange={(value) => onSettingChange({ fill: value })}
            options={[
              { value: 'edge', label: '边缘延展' },
              { value: 'ai', label: 'AI 补全' },
            ]}
          />
        </div>
      ) : null}

      {settings.composition === 'preserve' && settings.fill === 'ai' ? (
        <>
          <div className="field-block">
            <div className="field-row"><span className="field-label">AI 模型</span></div>
            <select
              className="select-field"
              value={settings.model}
              disabled={busy}
              onChange={(event) => onSettingChange({ model: event.target.value })}
            >
              <option>FHL · GPT Image 2</option>
              <option>OpenAI · gpt-image-1.5</option>
              <option>Gemini · 3 Pro Image</option>
            </select>
          </div>
          <div className="field-block">
            <div className="field-row"><span className="field-label">生成清晰度</span></div>
            <Segmented
              value={settings.quality}
              disabled={busy}
              ariaLabel="生成清晰度"
              onChange={(value) => onSettingChange({ quality: value })}
              options={[
                { value: '1K', label: '1K' },
                { value: '2K', label: '2K' },
                { value: '4K', label: '4K' },
              ]}
            />
          </div>
          <div className="field-block">
            <div className="field-row"><span className="field-label">场景补充</span></div>
            <textarea
              className="text-field"
              maxLength={1000}
              value={settings.description}
              disabled={busy}
              placeholder="例如：延续街道、建筑和地面透视，保持原有光线"
              onChange={(event) => onSettingChange({ description: event.target.value })}
            ></textarea>
            <div className="char-count">{settings.description.length}/1000</div>
          </div>
        </>
      ) : null}
    </div>
  );
}

function Sidebar({
  batch,
  targetId,
  onTargetChange,
  scope,
  onScopeChange,
  settings,
  selected,
  onSettingChange,
  onRestoreBatch,
  items,
  selectedId,
  onSelect,
  filter,
  onFilterChange,
  phase,
  primary,
  onPrimary,
  onAdd,
}) {
  const reviewCount = items.filter((item) => ['review', 'ai-review'].includes(item.status)).length;
  const aiCount = items.filter((item) => item.status === 'ai-pending').length;
  const visible = items.filter((item) => {
    if (filter === 'review') return ['review', 'ai-review'].includes(item.status);
    if (filter === 'ai') return ['ai-pending', 'ai-processing', 'ai-review'].includes(item.status);
    return true;
  });
  const busy = Boolean(phase);

  return (
    <aside className="sidebar">
      <SettingsPanel
        targetId={targetId}
        onTargetChange={onTargetChange}
        scope={scope}
        onScopeChange={onScopeChange}
        settings={settings}
        selected={selected}
        onSettingChange={onSettingChange}
        onRestoreBatch={onRestoreBatch}
        busy={busy}
      />
      <div className="add-area">
        <button className="button small" type="button" disabled={busy} onClick={onAdd}>
          <ImagePlus size={14} strokeWidth={1.8} />
          添加图片
        </button>
      </div>
      <div className="list-toolbar">
        <div className="filter-row">
          <button className={`filter-button ${filter === 'all' ? 'active' : ''}`} type="button" onClick={() => onFilterChange('all')}>全部</button>
          <button className={`filter-button review ${filter === 'review' ? 'active' : ''}`} type="button" onClick={() => onFilterChange('review')}>待检查 {reviewCount || ''}</button>
          <button className={`filter-button ${filter === 'ai' ? 'active' : ''}`} type="button" onClick={() => onFilterChange('ai')}>待补全 {aiCount || ''}</button>
        </div>
        <span className="list-count">{items.length}/100</span>
      </div>
      <div className="image-list" id="prototype-image-list">
        {visible.map((item) => {
          const itemSettings = resolveSettings(item, batch);
          return (
            <button
              className={`image-row ${selectedId === item.id ? 'selected' : ''}`}
              type="button"
              key={item.id}
              onClick={() => onSelect(item.id)}
              title={item.name}
            >
              <span className="thumb"><img src={item.asset} alt="" /></span>
              <span className="image-copy">
                <span className="image-name">{item.name}</span>
                <span className="image-meta">{itemSettings.composition === 'crop' ? '裁剪填满' : itemSettings.fill === 'ai' ? '保全画面 · AI' : '保全画面 · 延展'}</span>
              </span>
              <span className="image-state">
                <span className={`status-dot ${item.status}`} title={STATUS_LABELS[item.status]}></span>
                <span className={`source-tag ${item.followBatch ? '' : 'single'}`}>{item.followBatch ? '跟随批次' : '单图设置'}</span>
              </span>
            </button>
          );
        })}
      </div>
      <div className="sidebar-footer">
        {phase ? (
          <div className="progress-block">
            <div className="progress-copy">
              <span>{phase.type === 'ai' ? 'AI 补全' : '生成并导出'}</span>
              <span>{phase.progress}/{phase.ids.length}</span>
            </div>
            <div className="progress-track"><div className="progress-fill" style={{ width: `${phase.ids.length ? phase.progress / phase.ids.length * 100 : 0}%` }}></div></div>
          </div>
        ) : null}
        <button className="button primary" type="button" disabled={primary.disabled} onClick={onPrimary} id="primary-batch-action">
          {phase ? <LoaderCircle className="spinner" size={15} /> : primary.kind === 'ai' ? <Sparkles size={15} /> : <Download size={15} />}
          {primary.label}
        </button>
      </div>
    </aside>
  );
}

function drawChecker(ctx, size) {
  const step = 28;
  for (let y = 0; y < size; y += step) {
    for (let x = 0; x < size; x += step) {
      ctx.fillStyle = ((x / step + y / step) % 2 === 0) ? '#d9dde1' : '#cdd2d7';
      ctx.fillRect(x, y, step, step);
    }
  }
}

function geometryFor(item, settings, size = 900) {
  const scale = Math.min(size / item.width, size / item.height) * (settings.zoom / 100);
  const width = item.width * scale;
  const height = item.height * scale;
  const freeX = Math.max(0, size - width);
  const freeY = Math.max(0, size - height);
  const x = freeX / 2 + settings.pan.x * freeX / 2;
  const y = freeY / 2 + settings.pan.y * freeY / 2;
  return { x, y, width, height, freeX, freeY };
}

function drawEdgeExtension(ctx, image, item, settings, size) {
  const geometry = geometryFor(item, settings, size);
  const { x, y, width, height } = geometry;
  const right = Math.max(0, size - x - width);
  const sampleX = Math.max(1, Math.round(image.naturalWidth * settings.sampleWidth / 100));

  ctx.fillStyle = '#e7eaee';
  ctx.fillRect(0, 0, size, size);
  if (x > 0) ctx.drawImage(image, 0, 0, sampleX, image.naturalHeight, 0, y, x, height);
  if (right > 0) ctx.drawImage(image, image.naturalWidth - sampleX, 0, sampleX, image.naturalHeight, x + width, y, right, height);
  ctx.drawImage(image, x, y, width, height);
  return geometry;
}

function PreserveCanvas({ item, settings, onPanChange, processing }) {
  const canvasRef = useRef(null);
  const dragRef = useRef(null);
  const geometry = useMemo(() => geometryFor(item, settings, 100), [item, settings.zoom, settings.pan.x, settings.pan.y]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const context = canvas.getContext('2d');
    const image = new Image();
    image.src = item.asset;
    image.onload = () => {
      context.clearRect(0, 0, 900, 900);
      if (settings.fill === 'edge') {
        drawEdgeExtension(context, image, item, settings, 900);
      } else {
        drawChecker(context, 900);
        const next = geometryFor(item, settings, 900);
        context.drawImage(image, next.x, next.y, next.width, next.height);
      }
    };
    return () => { image.onload = null; };
  }, [item.asset, item.height, item.width, settings.fill, settings.pan.x, settings.pan.y, settings.sampleWidth, settings.zoom]);

  const beginDrag = (event) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { x: event.clientX, y: event.clientY, pan: settings.pan };
  };

  const moveDrag = (event) => {
    if (!dragRef.current) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const freeX = Math.max(1, rect.width - rect.width * geometry.width / 100);
    const freeY = Math.max(1, rect.height - rect.height * geometry.height / 100);
    const nextX = dragRef.current.pan.x + (event.clientX - dragRef.current.x) * 2 / freeX;
    const nextY = dragRef.current.pan.y + (event.clientY - dragRef.current.y) * 2 / freeY;
    onPanChange({ x: Math.max(-1, Math.min(1, nextX)), y: Math.max(-1, Math.min(1, nextY)) });
  };

  const endDrag = () => { dragRef.current = null; };
  const bandSize = `${settings.sampleWidth}%`;

  return (
    <div
      className="canvas-shell"
      id="preserve-canvas"
      onPointerDown={beginDrag}
      onPointerMove={moveDrag}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    >
      <canvas ref={canvasRef} width="900" height="900"></canvas>
      <div
        className="image-boundary"
        style={{ left: `${geometry.x}%`, top: `${geometry.y}%`, width: `${geometry.width}%`, height: `${geometry.height}%` }}
      >
        {settings.fill === 'edge' && settings.sampleMode === 'manual' ? (
          <span
            className={`sample-band ${settings.sampleDirection}`}
            style={['left', 'right'].includes(settings.sampleDirection) ? { width: bandSize } : { height: bandSize }}
          ></span>
        ) : null}
      </div>
      {processing ? (
        <div className="processing-overlay">
          <div className="processing-copy"><LoaderCircle className="spinner" size={16} />正在等待模型返回结果</div>
        </div>
      ) : null}
    </div>
  );
}

function CropEditor({ item, target, onAdjust }) {
  const [top, setTop] = useState(20);
  const dragRef = useRef(null);
  const ratio = target.width / target.height;
  const frameWidth = 86;
  const frameHeight = frameWidth / ratio * (2 / 3);
  const maxTop = Math.max(0, 100 - frameHeight);

  useEffect(() => {
    setTop(Math.max(0, (100 - frameHeight) / 2));
  }, [frameHeight, item.id]);

  const begin = (event) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { y: event.clientY, top };
  };

  const move = (event) => {
    if (!dragRef.current) return;
    const rect = event.currentTarget.parentElement.getBoundingClientRect();
    const next = dragRef.current.top + (event.clientY - dragRef.current.y) / rect.height * 100;
    setTop(Math.max(0, Math.min(maxTop, next)));
    onAdjust();
  };

  return (
    <div className="crop-photo" id="crop-frame-mode">
      <img src={item.asset} alt={item.name} />
      <div
        className="crop-frame"
        style={{ top: `${top}%`, aspectRatio: ratio }}
        onPointerDown={begin}
        onPointerMove={move}
        onPointerUp={() => { dragRef.current = null; }}
      >
        <span className="corner tl"></span>
        <span className="corner tr"></span>
        <span className="corner bl"></span>
        <span className="crop-handle"></span>
      </div>
    </div>
  );
}

function ControlStrip({ settings, onSettingChange }) {
  if (settings.composition !== 'preserve') return null;
  return (
    <div className="control-strip" id="preserve-controls">
      <div className="control-group">
        <span className="control-label">整图缩放</span>
        <ZoomOut size={14} color="var(--muted)" />
        <input
          className="range"
          type="range"
          min="50"
          max="100"
          value={settings.zoom}
          onChange={(event) => onSettingChange({ zoom: Number(event.target.value) })}
          aria-label="整图缩放"
        />
        <ZoomIn size={14} color="var(--muted)" />
        <span className="control-value">{settings.zoom}%</span>
      </div>
      {settings.fill === 'edge' ? (
        <>
          <span className="control-divider"></span>
          <div className="control-group">
            <span className="control-label">边缘取样</span>
            <div className="compact-segmented">
              <button className={settings.sampleMode === 'auto' ? 'active' : ''} type="button" onClick={() => onSettingChange({ sampleMode: 'auto' })}>自动</button>
              <button className={settings.sampleMode === 'manual' ? 'active' : ''} type="button" onClick={() => onSettingChange({ sampleMode: 'manual' })}>手动</button>
            </div>
          </div>
          {settings.sampleMode === 'manual' ? (
            <>
              <div className="direction-row" aria-label="取样方向">
                {[
                  ['left', ArrowLeft, '左'],
                  ['right', ArrowRight, '右'],
                  ['top', ArrowUp, '上'],
                  ['bottom', ArrowDown, '下'],
                ].map(([value, DirectionIcon, label]) => (
                  <button
                    key={value}
                    type="button"
                    className={`direction-button ${settings.sampleDirection === value ? 'active' : ''}`}
                    onClick={() => onSettingChange({ sampleDirection: value })}
                    aria-label={`${label}侧取样`}
                    title={`${label}侧取样`}
                  >
                    <DirectionIcon size={13} />
                  </button>
                ))}
              </div>
              <div className="control-group">
                <input
                  className="range"
                  type="range"
                  min="2"
                  max="30"
                  value={settings.sampleWidth}
                  onChange={(event) => onSettingChange({ sampleWidth: Number(event.target.value) })}
                  aria-label="取样宽度"
                />
                <span className="control-value">{settings.sampleWidth}%</span>
              </div>
            </>
          ) : null}
        </>
      ) : (
        <>
          <span className="control-divider"></span>
          <div className="control-group">
            <Sparkles size={14} color="var(--accent)" />
            <span className="control-label">{settings.model}</span>
            <span className="control-value">{settings.quality}</span>
          </div>
        </>
      )}
    </div>
  );
}

function Editor({
  item,
  settings,
  target,
  index,
  total,
  onPrev,
  onNext,
  onSettingChange,
  onAdjust,
  onConfirm,
  onStartAi,
  onAcceptAi,
  onRegenerateAi,
  onBackFromAi,
  onRestore,
}) {
  const isAiReview = item.status === 'ai-review';
  const processing = item.status === 'ai-processing';
  const notice = settings.composition === 'crop'
    ? '当前比例会裁掉较多画面，可调整裁剪区域或切换为保全画面。'
    : settings.fill === 'edge'
      ? '边缘延展适合简单背景，请检查人物、商品和复杂纹理附近是否变形。'
      : isAiReview
        ? 'AI 结果可能改变原图内容，请检查人物、服装和背景衔接。'
        : null;

  return (
    <main className="workspace">
      <header className="workspace-header">
        <div className="workspace-title-wrap">
          <h1 className="workspace-file">{item.name}</h1>
          <p className="workspace-subtitle">{item.width}×{item.height} · 输出 {target.width}×{target.height}</p>
        </div>
        <div className="header-status">
          {!item.followBatch ? <span className="status-chip">单图设置</span> : null}
          <span className={`status-chip ${item.status}`}><span className={`status-dot ${item.status}`}></span>{STATUS_LABELS[item.status]}</span>
        </div>
      </header>
      <div className="editor-area">
        <div className="editor-stage">
          {settings.composition === 'crop' ? (
            <CropEditor item={item} target={target} onAdjust={onAdjust} />
          ) : isAiReview ? (
            <div className="canvas-shell"><img className="ai-result-image" src={ASSETS.fullbody} alt="AI 补全结果" /></div>
          ) : (
            <PreserveCanvas
              item={item}
              settings={settings}
              processing={processing}
              onPanChange={(pan) => onSettingChange({ pan })}
            />
          )}
          {notice ? <div className="notice"><AlertTriangle size={14} />{notice}</div> : null}
        </div>
        <ControlStrip settings={settings} onSettingChange={onSettingChange} />
        <footer className="workspace-footer">
          <div className="footer-left">
            <IconButton label="向左旋转 90°"><RotateCcw size={15} /></IconButton>
            <IconButton label="向右旋转 90°"><RotateCw size={15} /></IconButton>
            <button className="button small" type="button" disabled={processing || isAiReview} onClick={onRestore}>
              <RefreshCw size={13} />
              <span>恢复自动</span>
            </button>
          </div>
          <div className="footer-center">
            <IconButton label="上一张" disabled={index <= 0} onClick={onPrev}><ChevronLeft size={16} /></IconButton>
            <span className="image-index">{index + 1}/{total}</span>
            <IconButton label="下一张" disabled={index >= total - 1} onClick={onNext}><ChevronRight size={16} /></IconButton>
          </div>
          <div className="footer-right">
            {isAiReview ? (
              <>
                <button className="button small ghost" type="button" onClick={onBackFromAi}>返回调整</button>
                <button className="button small" type="button" onClick={onRegenerateAi}><RefreshCw size={13} />重新生成</button>
                <button className="button small primary" type="button" onClick={onAcceptAi}><Check size={13} />接受结果</button>
              </>
            ) : item.status === 'ai-pending' ? (
              <button className="button small primary" type="button" onClick={onStartAi}><WandSparkles size={13} />补全当前</button>
            ) : processing ? (
              <button className="button small" type="button" disabled><LoaderCircle className="spinner" size={13} />补全中</button>
            ) : ['review', 'adjusted'].includes(item.status) ? (
              <button className="button small primary" type="button" onClick={onConfirm}><Check size={13} />确认当前</button>
            ) : null}
          </div>
        </footer>
      </div>
    </main>
  );
}

function Modal({ modal, settings, onClose, onConfirm, onNewBatch }) {
  if (!modal) return null;
  const isAi = modal.type === 'ai';
  return (
    <div className="modal-backdrop" role="presentation">
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">
        <div className="modal-header">
          <h2 className="modal-title" id="modal-title">{isAi ? '开始 AI 补全？' : '导出完成'}</h2>
          <IconButton label="关闭" onClick={onClose}><X size={16} /></IconButton>
        </div>
        <div className="modal-body">
          {isAi ? (
            <>
              <p className="modal-copy">将向所选服务商发送待补全图片及相关描述。图片不会发送给其他模型。</p>
              <div className="modal-facts">
                <div className="modal-fact"><span>待补全图片</span><span>{modal.ids.length} 张</span></div>
                <div className="modal-fact"><span>模型服务商</span><span>{settings.model}</span></div>
                <div className="modal-fact"><span>上传范围</span><span>当前图片与场景补充</span></div>
                <div className="modal-fact"><span>生成清晰度</span><span>{settings.quality}</span></div>
              </div>
              <p className="modal-warning">本次操作可能产生模型服务商费用。AI 返回后需要逐张接受。</p>
            </>
          ) : (
            <>
              <div className="export-summary">
                <div className="summary-cell"><span className="summary-value">3</span><span className="summary-label">成功图片</span></div>
                <div className="summary-cell"><span className="summary-value">0</span><span className="summary-label">失败图片</span></div>
              </div>
              <div className="export-path">~/Downloads/Lumina-Adapted</div>
            </>
          )}
        </div>
        <div className="modal-footer">
          {isAi ? (
            <>
              <button className="button small" type="button" onClick={onClose}>取消</button>
              <button className="button small primary" type="button" onClick={onConfirm}><Sparkles size={13} />开始补全</button>
            </>
          ) : (
            <>
              <button className="button small" type="button" onClick={onClose}>确认</button>
              <button className="button small primary" type="button" onClick={onNewBatch}><Plus size={13} />添加新批次</button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function App() {
  const [theme, setTheme] = useState('dark');
  const [targetId, setTargetId] = useState('1440x1440');
  const [scope, setScope] = useState('batch');
  const [batch, setBatch] = useState(INITIAL_BATCH);
  const [items, setItems] = useState(INITIAL_ITEMS);
  const [selectedId, setSelectedId] = useState('coat');
  const [filter, setFilter] = useState('all');
  const [phase, setPhase] = useState(null);
  const [modal, setModal] = useState(null);
  const [toast, setToast] = useState('');

  const selectedIndex = Math.max(0, items.findIndex((item) => item.id === selectedId));
  const selected = items[selectedIndex] || items[0];
  const settings = resolveSettings(selected, batch);
  const target = TARGETS.find((entry) => entry.id === targetId) || TARGETS[0];

  const showToast = (message) => {
    setToast(message);
    window.clearTimeout(showToast.timer);
    showToast.timer = window.setTimeout(() => setToast(''), 2200);
  };

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    if (!phase) return undefined;
    if (phase.progress >= phase.ids.length) {
      if (phase.type === 'export') {
        setItems((current) => current.map((item) => ({ ...item, status: 'exported' })));
        setModal({ type: 'export' });
      }
      setPhase(null);
      return undefined;
    }
    const timer = window.setTimeout(() => {
      const id = phase.ids[phase.progress];
      if (phase.type === 'ai') {
        setItems((current) => current.map((item) => item.id === id ? { ...item, status: 'ai-review' } : item));
        setSelectedId(id);
        setFilter('all');
      }
      setPhase((current) => current ? { ...current, progress: current.progress + 1 } : current);
    }, phase.type === 'ai' ? 1150 : 420);
    return () => window.clearTimeout(timer);
  }, [phase]);

  const updateSettings = (patch) => {
    if (phase) return;
    if (scope === 'batch') {
      const nextBatch = { ...batch, ...patch };
      setBatch(nextBatch);
      setItems((current) => current.map((item) => item.followBatch
        ? { ...item, status: statusForSettings(nextBatch) }
        : item));
      showToast('批次默认已更新，单图设置保持不变');
      return;
    }
    const nextSettings = { ...settings, ...patch };
    setItems((current) => current.map((item) => item.id === selected.id
      ? { ...item, followBatch: false, settings: nextSettings, status: statusForSettings(nextSettings) }
      : item));
  };

  const updateCurrentItem = (updater) => {
    setItems((current) => current.map((item) => item.id === selected.id ? updater(item) : item));
  };

  const restoreBatch = () => {
    updateCurrentItem((item) => ({ ...item, followBatch: true, settings: null, status: statusForSettings(batch) }));
    setScope('batch');
    showToast('当前图片已恢复批次设置');
  };

  const restoreAutomatic = () => {
    const defaults = settings.composition === 'crop'
      ? settings
      : { ...settings, zoom: 100, pan: { x: 0, y: 0 }, sampleMode: 'auto', sampleWidth: 10 };
    if (selected.followBatch && scope === 'batch') {
      setBatch(defaults);
    } else {
      updateCurrentItem((item) => ({ ...item, followBatch: false, settings: defaults, status: statusForSettings(defaults) }));
    }
    showToast('已恢复自动构图');
  };

  const adjustCurrent = () => {
    if (selected.status === 'review') updateCurrentItem((item) => ({ ...item, status: 'adjusted' }));
  };

  const confirmCurrent = () => {
    updateCurrentItem((item) => ({ ...item, status: 'confirmed' }));
    const next = items.find((item) => item.id !== selected.id && ['review', 'ai-review'].includes(item.status));
    if (next) setSelectedId(next.id);
    else showToast('当前结果已确认');
  };

  const openAi = (ids) => setModal({ type: 'ai', ids });

  const confirmAi = () => {
    const ids = modal.ids;
    setModal(null);
    setItems((current) => current.map((item) => ids.includes(item.id) ? { ...item, status: 'ai-processing' } : item));
    setPhase({ type: 'ai', ids, progress: 0 });
  };

  const acceptAi = () => {
    updateCurrentItem((item) => ({ ...item, status: 'confirmed' }));
    showToast('AI 结果已接受，可以参与批量导出');
  };

  const backFromAi = () => {
    updateCurrentItem((item) => ({ ...item, status: 'ai-pending' }));
    showToast('AI 结果已清除，可继续调整构图');
  };

  const aiPendingIds = items.filter((item) => item.status === 'ai-pending').map((item) => item.id);
  const blockers = items.filter((item) => ['review', 'ai-review', 'ai-processing', 'error'].includes(item.status));
  let primary = { kind: 'export', label: '确认并导出', disabled: false };
  if (phase) {
    primary = { kind: phase.type, label: phase.type === 'ai' ? `AI 补全中 ${phase.progress}/${phase.ids.length}` : `正在导出 ${phase.progress}/${phase.ids.length}`, disabled: true };
  } else if (aiPendingIds.length > 0) {
    primary = { kind: 'ai', label: `批量补全 ${aiPendingIds.length} 张`, disabled: false };
  } else if (blockers.length > 0) {
    primary = { kind: 'export', label: `还有 ${blockers.length} 张需检查`, disabled: true };
  }

  const handlePrimary = () => {
    if (aiPendingIds.length > 0) {
      openAi(aiPendingIds);
      return;
    }
    if (blockers.length > 0) return;
    const ids = items.map((item) => item.id);
    setItems((current) => current.map((item) => ({ ...item, status: 'exporting' })));
    setPhase({ type: 'export', ids, progress: 0 });
  };

  const addDemoImage = () => {
    const id = `added-${Date.now()}`;
    setItems((current) => [...current, {
      id,
      name: 'NEW_LOOK.jpg',
      asset: ASSETS.fullbody,
      width: 750,
      height: 1140,
      fileSize: '7.1 MB',
      followBatch: true,
      settings: null,
      status: statusForSettings(batch),
    }]);
    setSelectedId(id);
    showToast('已添加 1 张图片');
  };

  const startNewBatch = () => {
    setItems([]);
    setModal(null);
    setSelectedId(null);
    showToast('已清空图片，保留当前批次设置');
  };

  if (!selected) {
    return (
      <div className="app-shell">
        <TitleBar theme={theme} onToggleTheme={() => setTheme((value) => value === 'dark' ? 'light' : 'dark')} />
        <div className="main-area">
          <section className="workbench" data-screen-label="图片适配工作台">
            <aside className="sidebar"><div className="add-area"><button className="button small" onClick={addDemoImage}><ImagePlus size={14} />添加图片</button></div></aside>
            <main className="workspace"></main>
          </section>
        </div>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <TitleBar theme={theme} onToggleTheme={() => setTheme((value) => value === 'dark' ? 'light' : 'dark')} />
      <div className="main-area">
        <section className="workbench" data-screen-label="图片适配工作台">
          <Sidebar
            batch={batch}
            targetId={targetId}
            onTargetChange={(value) => { setTargetId(value); showToast('输出尺寸已更新，现有方案重新计算'); }}
            scope={scope}
            onScopeChange={setScope}
            settings={settings}
            selected={selected}
            onSettingChange={updateSettings}
            onRestoreBatch={restoreBatch}
            items={items}
            selectedId={selected.id}
            onSelect={(id) => { setSelectedId(id); setScope('current'); }}
            filter={filter}
            onFilterChange={setFilter}
            phase={phase}
            primary={primary}
            onPrimary={handlePrimary}
            onAdd={addDemoImage}
          />
          <Editor
            item={selected}
            settings={settings}
            target={target}
            index={selectedIndex}
            total={items.length}
            onPrev={() => setSelectedId(items[Math.max(0, selectedIndex - 1)]?.id)}
            onNext={() => setSelectedId(items[Math.min(items.length - 1, selectedIndex + 1)]?.id)}
            onSettingChange={updateSettings}
            onAdjust={adjustCurrent}
            onConfirm={confirmCurrent}
            onStartAi={() => openAi([selected.id])}
            onAcceptAi={acceptAi}
            onRegenerateAi={() => openAi([selected.id])}
            onBackFromAi={backFromAi}
            onRestore={restoreAutomatic}
          />
        </section>
      </div>
      <Modal
        modal={modal}
        settings={settings}
        onClose={() => setModal(null)}
        onConfirm={confirmAi}
        onNewBatch={startNewBatch}
      />
      {toast ? <div className="toast"><Check size={14} />{toast}</div> : null}
    </div>
  );
}

createRoot(document.getElementById('root')).render(<App />);
