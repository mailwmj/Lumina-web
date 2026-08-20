import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, FolderOpen, Pencil, Trash2, AlertTriangle, Crop } from '@/components/ui/icons';
import { useProjectStore } from '@/stores/projectStore';
import { recordProjectOpenClick } from '@/features/app/projectOpenPaneClickGuard';
import { UI_CONTENT_OVERLAY_INSET_CLASS } from '@/components/ui/motion';
import { UiButton, UiModal, UiSelect, UiTooltip } from '@/components/ui';
import { RenameDialog } from './RenameDialog';

type ProjectSortField = 'name' | 'createdAt' | 'updatedAt';
type SortDirection = 'asc' | 'desc';

interface DeleteConfirmDialogProps {
  isOpen: boolean;
  projectName: string;
  onClose: () => void;
  onConfirm: () => void;
}

function DeleteConfirmDialog({
  isOpen,
  projectName,
  onClose,
  onConfirm,
}: DeleteConfirmDialogProps) {
  const { t } = useTranslation();

  return (
    <UiModal
      isOpen={isOpen}
      title={t('project.deleteConfirmTitle')}
      closeLabel={t('common.close')}
      onClose={onClose}
      widthClassName="w-[420px] max-w-[calc(100vw-24px)]"
      footer={(
        <>
          <UiButton onClick={onClose}>{t('common.cancel')}</UiButton>
          <UiButton
            variant="danger"
            onClick={() => {
              onConfirm();
              onClose();
            }}
          >
            {t('project.deleteConfirmButton')}
          </UiButton>
        </>
      )}
    >
      <div className="flex items-start gap-3">
        <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-red-500" />
        <p className="text-sm leading-6 text-text-muted">
          {t('project.deleteConfirmMessage', { name: projectName })}
        </p>
      </div>
    </UiModal>
  );
}

interface ProjectManagerProps {
  onOpenBatchCrop: () => void;
}

export function ProjectManager({ onOpenBatchCrop }: ProjectManagerProps) {
  const { t } = useTranslation();
  const [showRenameDialog, setShowRenameDialog] = useState(false);
  const [editingProjectId, setEditingProjectId] = useState<string | null>(null);
  const [editingProjectName, setEditingProjectName] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null);
  const [sortField, setSortField] = useState<ProjectSortField>('createdAt');
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc');

  const { projects, isOpeningProject, createProject, deleteProject, renameProject, openProject } =
    useProjectStore();

  const handleCreateProject = () => {
    setEditingProjectId(null);
    setEditingProjectName('');
    setShowRenameDialog(true);
  };

  const handleRenameClick = (id: string, name: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingProjectId(id);
    setEditingProjectName(name);
    setShowRenameDialog(true);
  };

  const handleDeleteClick = (id: string, name: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setDeleteTarget({ id, name });
  };

  const handleConfirmDelete = () => {
    if (deleteTarget) {
      deleteProject(deleteTarget.id);
      setDeleteTarget(null);
    }
  };

  const handleConfirm = (name: string) => {
    if (editingProjectId) {
      renameProject(editingProjectId, name);
    } else {
      createProject(name);
    }
  };

  const formatDate = (timestamp: number) => {
    return new Date(timestamp).toLocaleDateString();
  };

  const sortedProjects = useMemo(() => {
    const list = [...projects];
    const direction = sortDirection === 'asc' ? 1 : -1;

    list.sort((a, b) => {
      if (sortField === 'name') {
        return a.name.localeCompare(b.name, 'zh-Hans-CN', { sensitivity: 'base' }) * direction;
      }

      const left = sortField === 'createdAt' ? a.createdAt : a.updatedAt;
      const right = sortField === 'createdAt' ? b.createdAt : b.updatedAt;
      return (left - right) * direction;
    });

    return list;
  }, [projects, sortDirection, sortField]);

  return (
    <div className="ui-scrollbar h-full w-full overflow-auto bg-bg-dark px-6 py-5">
      <div className="mx-auto max-w-5xl">
        <div className="mb-5 flex items-center justify-between gap-4 border-b border-[var(--ui-border-soft)] pb-4">
          <div className="flex items-center gap-3">
            <h1 className="text-lg font-semibold text-text-dark">{t('project.title')}</h1>
            <div className="flex items-center gap-2">
              <UiSelect
                aria-label={t('project.sortBy')}
                value={sortField}
                onChange={(event) => setSortField(event.target.value as ProjectSortField)}
                className="h-8 w-[112px] text-xs"
              >
                <option value="name">{t('project.sortByName')}</option>
                <option value="createdAt">{t('project.sortByCreatedAt')}</option>
                <option value="updatedAt">{t('project.sortByUpdatedAt')}</option>
              </UiSelect>
              <UiSelect
                aria-label={t('project.sortDirection')}
                value={sortDirection}
                onChange={(event) => setSortDirection(event.target.value as SortDirection)}
                className="h-8 w-[72px] text-xs"
              >
                <option value="asc">{t('project.sortAsc')}</option>
                <option value="desc">{t('project.sortDesc')}</option>
              </UiSelect>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <UiButton type="button" onClick={onOpenBatchCrop} className="gap-2">
              <Crop className="h-4 w-4" />
              {t('batchCrop.entry')}
            </UiButton>
            <UiButton type="button" variant="primary" onClick={handleCreateProject} className="gap-2">
              <Plus className="h-4 w-4" />
              {t('project.newProject')}
            </UiButton>
          </div>
        </div>

        {projects.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-24 text-text-muted">
            <FolderOpen className="mb-4 h-10 w-10 opacity-45" />
            <p className="text-sm font-medium text-text-dark">{t('project.empty')}</p>
            <p className="mt-1 text-xs">{t('project.emptyHint')}</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {sortedProjects.map((project) => (
              <div
                key={project.id}
                onClick={(event) => {
                  recordProjectOpenClick(event);
                  openProject(project.id);
                }}
                className="group cursor-pointer rounded-lg border border-[var(--ui-border-soft)] bg-surface-dark p-4 transition-[border-color,background-color,box-shadow] hover:border-accent/35 hover:bg-[var(--ui-surface-elevated)] hover:shadow-[var(--ui-shadow-panel)]"
              >
                <div className="flex items-start justify-between mb-2">
                  <h3 className="flex-1 truncate text-sm font-medium text-text-dark">
                    {project.name}
                  </h3>
                  <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    <UiTooltip content={t('project.rename')}>
                      <button
                        type="button"
                        aria-label={t('project.rename')}
                        onClick={(e) => handleRenameClick(project.id, project.name, e)}
                        className="flex h-7 w-7 items-center justify-center rounded-md text-text-muted hover:bg-[var(--ui-hover)] hover:text-text-dark"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                    </UiTooltip>
                    <UiTooltip content={t('project.delete')}>
                      <button
                        type="button"
                        aria-label={t('project.delete')}
                        onClick={(e) => handleDeleteClick(project.id, project.name, e)}
                        className="flex h-7 w-7 items-center justify-center rounded-md text-text-muted hover:bg-red-500/10 hover:text-red-500"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </UiTooltip>
                  </div>
                </div>
                <div className="font-mono text-[11px] leading-5 text-text-muted">
                  <p>
                    {t('project.modified')}: {formatDate(project.updatedAt)}
                  </p>
                  <p>
                    {t('project.created')}: {formatDate(project.createdAt)}
                  </p>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {isOpeningProject && (
        <div className={`pointer-events-none fixed ${UI_CONTENT_OVERLAY_INSET_CLASS} bg-black/10`} />
      )}

      <RenameDialog
        isOpen={showRenameDialog}
        title={editingProjectId ? t('project.renameTitle') : t('project.newProjectTitle')}
        defaultValue={editingProjectName}
        onClose={() => setShowRenameDialog(false)}
        onConfirm={handleConfirm}
      />

      <DeleteConfirmDialog
        isOpen={deleteTarget !== null}
        projectName={deleteTarget?.name ?? ''}
        onClose={() => setDeleteTarget(null)}
        onConfirm={handleConfirmDelete}
      />
    </div>
  );
}
