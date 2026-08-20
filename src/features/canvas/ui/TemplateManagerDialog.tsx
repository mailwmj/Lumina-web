import { useState, useCallback } from 'react';
import { X, Plus, Trash2, Edit2 } from '@/components/ui/icons';
import { useTranslation } from 'react-i18next';
import { usePromptTemplateStore } from '@/stores/promptTemplateStore';
import { type PromptTemplate } from '@/features/canvas/domain/promptTemplate';
import { UI_DIALOG_TRANSITION_MS } from '@/components/ui/motion';
import { useDialogTransition } from '@/components/ui/useDialogTransition';
import { UiButton, UiIconButton } from '@/components/ui';

interface TemplateManagerDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onSelectTemplate?: (template: PromptTemplate) => void;
}

const STYLE_OPTIONS = [
  { value: 'cinematic', label: '电影感' },
  { value: 'anime', label: '动漫风格' },
  { value: 'photorealistic', label: '写实摄影' },
  { value: 'watercolor', label: '水彩画' },
  { value: 'oil-painting', label: '油画' },
  { value: 'sketch', label: '素描' },
  { value: 'minimalist', label: '极简主义' },
];

const COLOR_OPTIONS = [
  { value: 'vibrant', label: '鲜艳' },
  { value: 'muted', label: '低饱和' },
  { value: 'natural', label: '自然' },
  { value: 'warm', label: '暖色调' },
  { value: 'cool', label: '冷色调' },
  { value: 'monochrome', label: '黑白' },
];

const DETAIL_OPTIONS = [
  { value: 'low', label: '低' },
  { value: 'medium', label: '中' },
  { value: 'high', label: '高' },
];

export function TemplateManagerDialog({
  isOpen,
  onClose,
  onSelectTemplate,
}: TemplateManagerDialogProps) {
  const { t } = useTranslation();
  const { shouldRender, isVisible } = useDialogTransition(isOpen, UI_DIALOG_TRANSITION_MS);
  const templates = usePromptTemplateStore((state) => state.templates);
  const addTemplate = usePromptTemplateStore((state) => state.addTemplate);
  const updateTemplate = usePromptTemplateStore((state) => state.updateTemplate);
  const deleteTemplate = usePromptTemplateStore((state) => state.deleteTemplate);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [formData, setFormData] = useState({
    name: '',
    description: '',
    style: '',
    color: '',
    detail: 'medium' as 'low' | 'medium' | 'high',
    customPrompt: '',
  });

  const handleCreate = useCallback(() => {
    setIsCreating(true);
    setEditingId(null);
    setFormData({
      name: '',
      description: '',
      style: '',
      color: '',
      detail: 'medium',
      customPrompt: '',
    });
  }, []);

  const handleEdit = useCallback((template: PromptTemplate) => {
    setIsCreating(false);
    setEditingId(template.id);
    setFormData({
      name: template.name,
      description: template.description ?? '',
      style: template.style ?? '',
      color: template.color ?? '',
      detail: template.detail ?? 'medium',
      customPrompt: template.customPrompt ?? '',
    });
  }, []);

  const handleSave = useCallback(() => {
    if (!formData.name.trim()) {
      return;
    }

    if (editingId) {
      updateTemplate(editingId, formData);
    } else {
      addTemplate(formData);
    }

    setIsCreating(false);
    setEditingId(null);
  }, [editingId, formData, addTemplate, updateTemplate]);

  const handleDelete = useCallback((id: string) => {
    deleteTemplate(id);
  }, [deleteTemplate]);

  const handleCancel = useCallback(() => {
    setIsCreating(false);
    setEditingId(null);
  }, []);

  if (!shouldRender) {
    return null;
  }

  return (
    <div
      className={`fixed inset-0 z-50 flex items-center justify-center transition-opacity duration-${UI_DIALOG_TRANSITION_MS} ${
        isVisible ? 'opacity-100' : 'opacity-0'
      }`}
      style={{ backgroundColor: 'rgba(0, 0, 0, 0.6)' }}
      onClick={onClose}
    >
      <div
        className="max-h-[80vh] w-[min(560px,calc(100vw-24px))] overflow-hidden rounded-[10px] border border-[var(--ui-border-soft)] bg-[var(--ui-surface-panel)] shadow-[var(--ui-shadow-panel)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-[var(--ui-border-soft)] px-5 py-3.5">
          <h2 className="text-base font-semibold text-text-dark">{t('template.manage', '模板管理')}</h2>
          <UiIconButton
            label={t('common.close')}
            onClick={onClose}
            className="h-8 w-8 border-transparent bg-transparent"
          >
            <X className="h-5 w-5 text-text-muted" />
          </UiIconButton>
        </div>

        <div className="max-h-[60vh] overflow-y-auto p-6">
          {(isCreating || editingId) ? (
            <div className="space-y-4">
              <div>
                <label className="mb-1.5 block text-sm text-text-muted">
                  {t('template.name', '模板名称')}
                </label>
                <input
                  type="text"
                  value={formData.name}
                  onChange={(e) => setFormData((f) => ({ ...f, name: e.target.value }))}
                  className="w-full rounded-lg border border-border-dark bg-bg-dark px-3 py-2 text-sm text-text-dark placeholder:text-text-muted/50 focus:border-accent/50 focus:outline-none"
                  placeholder={t('template.namePlaceholder', '输入模板名称')}
                />
              </div>

              <div>
                <label className="mb-1.5 block text-sm text-text-muted">
                  {t('template.description', '描述')}
                </label>
                <input
                  type="text"
                  value={formData.description}
                  onChange={(e) => setFormData((f) => ({ ...f, description: e.target.value }))}
                  className="w-full rounded-lg border border-border-dark bg-bg-dark px-3 py-2 text-sm text-text-dark placeholder:text-text-muted/50 focus:border-accent/50 focus:outline-none"
                  placeholder={t('template.descriptionPlaceholder', '简短描述此模板')}
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="mb-1.5 block text-sm text-text-muted">
                    {t('template.style', '画面风格')}
                  </label>
                  <select
                    value={formData.style}
                    onChange={(e) => setFormData((f) => ({ ...f, style: e.target.value }))}
                    className="w-full rounded-lg border border-border-dark bg-bg-dark px-3 py-2 text-sm text-text-dark focus:border-accent/50 focus:outline-none"
                  >
                    <option value="">{t('common.select', '请选择')}</option>
                    {STYLE_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>{opt.label}</option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="mb-1.5 block text-sm text-text-muted">
                    {t('template.color', '色调')}
                  </label>
                  <select
                    value={formData.color}
                    onChange={(e) => setFormData((f) => ({ ...f, color: e.target.value }))}
                    className="w-full rounded-lg border border-border-dark bg-bg-dark px-3 py-2 text-sm text-text-dark focus:border-accent/50 focus:outline-none"
                  >
                    <option value="">{t('common.select', '请选择')}</option>
                    {COLOR_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>{opt.label}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div>
                <label className="mb-1.5 block text-sm text-text-muted">
                  {t('template.detail', '细节程度')}
                </label>
                <div className="flex gap-2">
                  {DETAIL_OPTIONS.map((opt) => (
                    <button
                      key={opt.value}
                      onClick={() => setFormData((f) => ({ ...f, detail: opt.value as 'low' | 'medium' | 'high' }))}
                      className={`flex-1 rounded-lg border px-3 py-2 text-sm transition-colors ${
                        formData.detail === opt.value
                          ? 'border-accent bg-accent/20 text-accent'
                          : 'border-[var(--ui-border-soft)] bg-[var(--ui-surface-field)] text-text-muted hover:border-[var(--ui-border-strong)]'
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="mb-1.5 block text-sm text-text-muted">
                  {t('template.customPrompt', '自定义提示词')}
                </label>
                <textarea
                  value={formData.customPrompt}
                  onChange={(e) => setFormData((f) => ({ ...f, customPrompt: e.target.value }))}
                  className="w-full rounded-lg border border-border-dark bg-bg-dark px-3 py-2 text-sm text-text-dark placeholder:text-text-muted/50 focus:border-accent/50 focus:outline-none"
                  placeholder={t('template.customPromptPlaceholder', '额外的提示词指令')}
                  rows={3}
                />
              </div>

              <div className="flex gap-2 pt-2">
                <UiButton variant="ghost" onClick={handleCancel} className="flex-1">
                  {t('common.cancel', '取消')}
                </UiButton>
                <UiButton variant="primary" onClick={handleSave} className="flex-1">
                  {t('common.save', '保存')}
                </UiButton>
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              {templates.map((template) => (
                <div
                  key={template.id}
                  className="flex items-center justify-between rounded-lg border border-[var(--ui-border-soft)] bg-[var(--ui-surface-field)] p-4 transition-colors hover:bg-[var(--ui-hover)]"
                >
                  <div className="flex-1">
                    <div className="font-medium text-text-dark">{template.name}</div>
                    {template.description && (
                      <div className="mt-0.5 text-xs text-text-muted">{template.description}</div>
                    )}
                    <div className="mt-1.5 flex gap-2">
                      {template.style && (
                        <span className="rounded bg-accent/20 px-2 py-0.5 text-xs text-accent">
                          {template.style}
                        </span>
                      )}
                      {template.color && (
                        <span className="rounded bg-accent/20 px-2 py-0.5 text-xs text-accent">
                          {template.color}
                        </span>
                      )}
                      {template.detail && (
                        <span className="rounded bg-accent/20 px-2 py-0.5 text-xs text-accent">
                          {template.detail}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="flex gap-1">
                    {onSelectTemplate && (
                      <UiIconButton
                        label={t('common.select', '选择')}
                        onClick={() => onSelectTemplate(template)}
                        className="h-8 w-8 border-transparent bg-transparent hover:text-accent"
                      >
                        <Plus className="h-4 w-4" />
                      </UiIconButton>
                    )}
                    <UiIconButton
                      label={t('common.edit', '编辑')}
                      onClick={() => handleEdit(template)}
                      className="h-8 w-8 border-transparent bg-transparent"
                    >
                      <Edit2 className="h-4 w-4" />
                    </UiIconButton>
                    <UiIconButton
                      label={t('common.delete', '删除')}
                      onClick={() => handleDelete(template.id)}
                      className="h-8 w-8 border-transparent bg-transparent hover:!bg-red-500/10 hover:!text-red-500"
                    >
                      <Trash2 className="h-4 w-4" />
                    </UiIconButton>
                  </div>
                </div>
              ))}

              {templates.length === 0 && (
                <div className="py-8 text-center text-text-muted">
                  {t('template.empty', '暂无模板')}
                </div>
              )}

              <button
                onClick={handleCreate}
                className="mt-4 flex w-full items-center justify-center gap-2 rounded-lg border border-dashed border-border-dark p-3 text-sm text-text-muted transition-colors hover:border-accent/50 hover:text-accent"
              >
                <Plus className="h-4 w-4" />
                {t('template.create', '新建模板')}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
