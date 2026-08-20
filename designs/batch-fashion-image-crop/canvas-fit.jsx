import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AlertTriangle, Check, Download, Image as ImageIcon, LoaderCircle, Sparkles } from 'lucide-react';
import {
  Editor,
  INITIAL_ITEMS,
  Modal,
  Segmented,
  Sidebar,
  TARGETS,
  TitleBar,
  imageBoxFor,
} from './canvas-fit-components.jsx';

function App() {
  const [theme, setTheme] = useState('dark');
  const [targetId, setTargetId] = useState('1440x1440');
  const [items, setItems] = useState(INITIAL_ITEMS);
  const [selectedId, setSelectedId] = useState('coat');
  const [filter, setFilter] = useState('all');
  const [modal, setModal] = useState(null);
  const [pendingTarget, setPendingTarget] = useState(null);
  const [toast, setToast] = useState('');
  const [aiForm, setAIForm] = useState({ model: 'FHL · GPT Image 2', quality: '2K', prompt: '' });

  const selectedIndex = Math.max(0, items.findIndex((item) => item.id === selectedId));
  const selected = items[selectedIndex];
  const target = TARGETS.find((candidate) => candidate.id === targetId) || TARGETS[0];

  const updateItemById = (id, change) => {
    setItems((current) => current.map((item) => {
      if (item.id !== id) return item;
      return typeof change === 'function' ? change(item) : { ...item, ...change };
    }));
  };

  const updateSelected = (patch) => updateItemById(selectedId, patch);

  useEffect(() => {
    if (!toast) return undefined;
    const timer = window.setTimeout(() => setToast(''), 2200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const changeMode = (mode) => {
    if (selected.mode === mode) return;
    updateSelected({ mode });
    setToast(mode === 'fixed' ? '当前图片已切换为固定画布' : '当前图片已切换为裁剪填满');
  };

  const requestTargetChange = (nextTarget) => {
    if (nextTarget === targetId) return;
    setPendingTarget(nextTarget);
    setModal('target');
  };

  const confirmTargetChange = () => {
    setTargetId(pendingTarget);
    setItems((current) => current.map((item) => ({
      ...item,
      crop: { offset: 50, confirmed: false },
      fixed: { ...item.fixed, zoom: 100, pan: { x: 0, y: 0 }, stage: 'compose', tool: null, selection: null, stretches: [], ai: 'idle', ready: false },
    })));
    setModal(null);
    setPendingTarget(null);
    setToast('输出尺寸已更新，单图调整已重置');
  };

  const openAI = () => {
    setAIForm((current) => ({ ...current, prompt: '' }));
    setModal('ai');
  };

  const startAI = () => {
    const taskId = selected.id;
    updateItemById(taskId, (item) => ({ ...item, fixed: { ...item.fixed, ai: 'processing', tool: null, selection: null } }));
    setModal(null);
    window.setTimeout(() => {
      updateItemById(taskId, (item) => ({ ...item, fixed: { ...item.fixed, ai: 'review' } }));
    }, 1500);
  };

  const navigate = (index) => setSelectedId(items[index].id);
  const exportable = useMemo(() => items.filter((item) => item.crop.confirmed || item.fixed.ready).length, [items]);

  return (
    <div className={`app ${theme}`} lang="zh-CN">
      <TitleBar theme={theme} onToggleTheme={() => setTheme((value) => value === 'dark' ? 'light' : 'dark')} />
      <div className="app-body">
        <Sidebar targetId={targetId} items={items} selectedId={selectedId} filter={filter}
          onTargetChange={requestTargetChange} onSelect={setSelectedId} onFilterChange={setFilter} onExport={() => setModal('export')} />
        {selected ? (
          <Editor item={selected} target={target} index={selectedIndex} total={items.length}
            onItemChange={updateSelected} onModeChange={changeMode} onNavigate={navigate} onAI={openAI} onToast={setToast} />
        ) : <EmptyEditor target={target} />}
      </div>

      {modal === 'ai' ? (
        <Modal title="确认 AI 补全" className="ai-modal" onClose={() => setModal(null)} footer={(
          <><button className="secondary-button" type="button" onClick={() => setModal(null)}>取消</button><button className="primary-button" type="button" onClick={startAI}><Sparkles size={15} />开始补全</button></>
        )}>
          <div className="ai-modal-grid">
            <div className="ai-preview-frame" style={{ aspectRatio: `${target.width} / ${target.height}` }}>
              <img src={selected.asset} alt="当前完整画布" style={(() => {
                const box = imageBoxFor(selected, target);
                return { left: `${box.x}%`, top: `${box.y}%`, width: `${box.width}%`, height: `${box.height}%` };
              })()} />
              <span><ImageIcon size={13} />完整画布</span>
            </div>
            <div className="ai-fields">
              <div className="privacy-note"><AlertTriangle size={16} /><span>AI 将读取整张画布，并只生成当前空白区域。人物和已有画面保持为保护内容。</span></div>
              <label><span>AI 模型</span><select value={aiForm.model} onChange={(event) => setAIForm({ ...aiForm, model: event.target.value })}><option>FHL · GPT Image 2</option><option>OpenAI · GPT Image 1.5</option></select></label>
              <label><span>生成清晰度</span><Segmented value={aiForm.quality} ariaLabel="生成清晰度" onChange={(quality) => setAIForm({ ...aiForm, quality })} options={[{ value: '1K', label: '1K' }, { value: '2K', label: '2K' }, { value: '4K', label: '4K' }]} /></label>
              <label><span>场景补充 <em>选填</em></span><textarea maxLength="1000" value={aiForm.prompt} placeholder="例如：延续街道地面与建筑透视" onChange={(event) => setAIForm({ ...aiForm, prompt: event.target.value })}></textarea><small>{aiForm.prompt.length}/1000</small></label>
              <p className="fee-note">图片将发送给所选模型服务商。本次生成可能产生服务商费用。</p>
            </div>
          </div>
        </Modal>
      ) : null}

      {modal === 'target' ? (
        <Modal title="更改输出尺寸" onClose={() => { setModal(null); setPendingTarget(null); }} footer={(
          <><button className="secondary-button" type="button" onClick={() => { setModal(null); setPendingTarget(null); }}>取消</button><button className="primary-button" type="button" onClick={confirmTargetChange}>确认更改</button></>
        )}>
          <div className="dialog-copy"><AlertTriangle size={20} /><div><strong>所有单图调整将重置</strong><p>裁剪位置、固定画布构图、区域拉伸和 AI 结果都会清除。</p></div></div>
        </Modal>
      ) : null}

      {modal === 'export' ? (
        <Modal title="批量导出" onClose={() => setModal(null)} footer={(
          <><button className="secondary-button" type="button" onClick={() => setModal(null)}>取消</button><button className="primary-button" type="button" disabled={!exportable} onClick={() => setModal('exporting')}><Download size={15} />导出 {exportable} 张</button></>
        )}>
          <div className="export-summary"><div><strong>{exportable}</strong><span>可导出</span></div><div><strong>{items.length - exportable}</strong><span>将跳过</span></div></div>
          <div className="export-path">~/Pictures/Lumina/图片适配/</div>
        </Modal>
      ) : null}

      {modal === 'exporting' ? <ExportProgress onComplete={() => setModal('complete')} count={exportable} /> : null}

      {modal === 'complete' ? (
        <Modal title="导出完成" onClose={() => setModal(null)} footer={(
          <><button className="secondary-button wide" type="button" onClick={() => { setModal(null); setItems([]); setSelectedId(null); }}>添加新批次</button><button className="primary-button wide" type="button" onClick={() => setModal(null)}><Check size={15} />确认</button></>
        )}>
          <div className="complete-state"><span><Check size={24} /></span><strong>已导出 {exportable} 张图片</strong><p>结果保存在 ~/Pictures/Lumina/图片适配/</p></div>
        </Modal>
      ) : null}

      {toast ? <div className="toast"><Check size={14} />{toast}</div> : null}
    </div>
  );
}

function EmptyEditor({ target }) {
  return (
    <main className="editor empty-editor">
      <header className="editor-header"><div className="file-heading"><strong>图片适配</strong><small>输出 {target.label}</small></div></header>
      <section className="workspace"><div className="empty-state"><ImageIcon size={24} /><strong>尚未添加图片</strong><span>从左侧添加图片开始</span></div></section>
    </main>
  );
}

function ExportProgress({ count, onComplete }) {
  const [progress, setProgress] = useState(12);
  useEffect(() => {
    const timer = window.setInterval(() => setProgress((value) => Math.min(100, value + 22)), 180);
    const done = window.setTimeout(onComplete, 900);
    return () => { window.clearInterval(timer); window.clearTimeout(done); };
  }, [onComplete]);
  return (
    <Modal title="正在导出" onClose={() => {}} footer={<button className="secondary-button" type="button" disabled>请稍候</button>}>
      <div className="export-progress"><LoaderCircle size={24} className="spin" /><strong>正在生成 {count} 张图片</strong><div><i style={{ width: `${progress}%` }}></i></div><span>{progress}%</span></div>
    </Modal>
  );
}

createRoot(document.getElementById('root')).render(<App />);
