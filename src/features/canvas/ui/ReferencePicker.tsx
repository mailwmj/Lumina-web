import { Music } from '@/components/ui/icons';
import type { ReferenceItem, PickerAnchor } from '@/features/canvas/hooks/useReferencePicker';

interface ReferencePickerProps {
  items: ReferenceItem[];
  pickerAnchor: PickerAnchor;
  pickerActiveIndex: number;
  onItemClick: (type: 'image' | 'video' | 'audio', index: number) => void;
  onItemHover: (index: number) => void;
}

export function ReferencePicker({
  items,
  pickerAnchor,
  pickerActiveIndex,
  onItemClick,
  onItemHover,
}: ReferencePickerProps) {
  if (items.length === 0) return null;

  return (
    <div
      className="nowheel absolute z-30 w-[120px] overflow-hidden rounded-[10px] border border-[var(--ui-border-soft)] bg-[var(--ui-surface-elevated)] shadow-[var(--ui-shadow-panel)]"
      style={{ left: pickerAnchor.left, top: pickerAnchor.top }}
      onMouseDown={(e) => e.stopPropagation()}
      onMouseDownCapture={(e) => e.stopPropagation()}
      onWheelCapture={(e) => e.stopPropagation()}
    >
      <div
        className="ui-scrollbar nowheel max-h-[180px] overflow-y-auto"
        onWheelCapture={(e) => e.stopPropagation()}
      >
        {items.map((item, index) => (
          <button
            key={`${item.type}-${item.index}`}
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onItemClick(item.type, item.index);
            }}
            onMouseEnter={() => onItemHover(index)}
            className={`flex w-full items-center gap-2 border border-transparent bg-transparent px-2 py-2 text-left text-sm text-text-dark transition-colors hover:bg-[var(--ui-hover)] ${
              pickerActiveIndex === index
                ? 'border-accent/45 bg-accent/10'
                : ''
            }`}
          >
            {item.type === 'image' && (
              <img
                src={item.previewUrl}
                alt={item.label}
                className="h-8 w-8 rounded object-cover"
                draggable={false}
              />
            )}
            {item.type === 'video' && (
              <video
                src={item.previewUrl}
                className="h-8 w-8 rounded object-cover"
                draggable={false}
              />
            )}
            {item.type === 'audio' && (
              <div className="flex h-8 w-8 items-center justify-center rounded bg-purple-500/20">
                <Music className="h-4 w-4 text-purple-400" />
              </div>
            )}
            <span>{item.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
