import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { UiButton, UiInput, UiModal } from '@/components/ui';

interface RenameDialogProps {
  isOpen: boolean;
  title: string;
  defaultValue?: string;
  onClose: () => void;
  onConfirm: (name: string) => void;
}

export function RenameDialog({
  isOpen,
  title,
  defaultValue = '',
  onClose,
  onConfirm,
}: RenameDialogProps) {
  const { t } = useTranslation();
  const [name, setName] = useState(defaultValue);

  useEffect(() => {
    if (isOpen) {
      setName(defaultValue);
    }
  }, [isOpen, defaultValue]);

  const handleConfirm = () => {
    if (name.trim()) {
      onConfirm(name.trim());
      onClose();
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleConfirm();
    } else if (e.key === 'Escape') {
      onClose();
    }
  };

  const canConfirm = Boolean(name.trim());

  return (
    <UiModal
      isOpen={isOpen}
      title={title}
      closeLabel={t('common.close')}
      onClose={onClose}
      widthClassName="w-[360px] max-w-[calc(100vw-24px)]"
      footer={(
        <>
          <UiButton onClick={onClose}>{t('common.cancel')}</UiButton>
          <UiButton variant="primary" onClick={handleConfirm} disabled={!canConfirm}>
            {t('common.confirm')}
          </UiButton>
        </>
      )}
    >
      <UiInput
        type="text"
        value={name}
        onChange={(event) => setName(event.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={t('project.namePlaceholder')}
        autoFocus
      />
    </UiModal>
  );
}
