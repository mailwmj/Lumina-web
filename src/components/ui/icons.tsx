import { forwardRef } from 'react';
import type { IconSvgElement } from '@hugeicons/react';
import {
  Alert02Icon,
  AtSignIcon,
  ArrowLeft01Icon,
  ArrowRight01Icon,
  BrushIcon,
  Cancel01Icon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ChevronUpIcon,
  CircleIcon,
  Copy01Icon,
  CropIcon,
  CursorPointer02Icon,
  Delete02Icon,
  Download01Icon,
  Edit02Icon,
  EyeIcon,
  EyeOffIcon,
  File02Icon,
  FolderOpenIcon,
  Grid3X3Icon,
  HandIcon,
  Image01Icon,
  ImageAdd01Icon,
  LanguageSquareIcon,
  LayoutGridIcon,
  Loading03Icon,
  MagicWand02Icon,
  MapsLocation01Icon,
  Maximize02Icon,
  MinusSignIcon,
  Moon02Icon,
  MusicNote01Icon,
  PauseIcon,
  PencilIcon,
  PenTool01Icon,
  PlayIcon,
  PlusSignIcon,
  Redo02Icon,
  Refresh01Icon,
  RotateLeft02Icon,
  Scissor01Icon,
  Settings02Icon,
  SlidersHorizontalIcon,
  SparklesIcon,
  SquareArrowUpRightIcon,
  SquareIcon,
  Sun03Icon,
  TextIcon,
  Tick02Icon,
  Undo02Icon,
  Unlink02Icon,
  Upload04Icon,
  Video02Icon,
  VolumeHighIcon,
  ZapIcon,
  ZoomInAreaIcon,
  ZoomOutAreaIcon,
} from '@hugeicons/core-free-icons';

import { UiIcon, type UiIconProps } from './Icon';

type NamedUiIconProps = Omit<UiIconProps, 'icon'>;

function createNamedIcon(icon: IconSvgElement, displayName: string) {
  const NamedIcon = forwardRef<SVGSVGElement, NamedUiIconProps>((props, ref) => (
    <UiIcon ref={ref} icon={icon} {...props} />
  ));
  NamedIcon.displayName = displayName;
  return NamedIcon;
}

export const AlertTriangle = createNamedIcon(Alert02Icon, 'AlertTriangle');
export const AtSign = createNamedIcon(AtSignIcon, 'AtSign');
export const ArrowLeft = createNamedIcon(ArrowLeft01Icon, 'ArrowLeft');
export const ArrowRight = createNamedIcon(ArrowRight01Icon, 'ArrowRight');
export const Brush = createNamedIcon(BrushIcon, 'Brush');
export const Check = createNamedIcon(Tick02Icon, 'Check');
export const ChevronDown = createNamedIcon(ChevronDownIcon, 'ChevronDown');
export const ChevronLeft = createNamedIcon(ChevronLeftIcon, 'ChevronLeft');
export const ChevronRight = createNamedIcon(ChevronRightIcon, 'ChevronRight');
export const ChevronUp = createNamedIcon(ChevronUpIcon, 'ChevronUp');
export const Circle = createNamedIcon(CircleIcon, 'Circle');
export const Copy = createNamedIcon(Copy01Icon, 'Copy');
export const Crop = createNamedIcon(CropIcon, 'Crop');
export const Download = createNamedIcon(Download01Icon, 'Download');
export const Edit2 = createNamedIcon(Edit02Icon, 'Edit2');
export const Eye = createNamedIcon(EyeIcon, 'Eye');
export const EyeOff = createNamedIcon(EyeOffIcon, 'EyeOff');
export const FileText = createNamedIcon(File02Icon, 'FileText');
export const FolderOpen = createNamedIcon(FolderOpenIcon, 'FolderOpen');
export const Grid3X3 = createNamedIcon(Grid3X3Icon, 'Grid3X3');
export const Hand = createNamedIcon(HandIcon, 'Hand');
export const Image = createNamedIcon(Image01Icon, 'Image');
export const ImagePlus = createNamedIcon(ImageAdd01Icon, 'ImagePlus');
export const Languages = createNamedIcon(LanguageSquareIcon, 'Languages');
export const LayoutGrid = createNamedIcon(LayoutGridIcon, 'LayoutGrid');
export const Loader2 = createNamedIcon(Loading03Icon, 'Loader2');
export const Map = createNamedIcon(MapsLocation01Icon, 'Map');
export const Maximize2 = createNamedIcon(Maximize02Icon, 'Maximize2');
export const Minus = createNamedIcon(MinusSignIcon, 'Minus');
export const Moon = createNamedIcon(Moon02Icon, 'Moon');
export const MousePointer2 = createNamedIcon(CursorPointer02Icon, 'MousePointer2');
export const Music = createNamedIcon(MusicNote01Icon, 'Music');
export const Pause = createNamedIcon(PauseIcon, 'Pause');
export const PenLine = createNamedIcon(PenTool01Icon, 'PenLine');
export const Pencil = createNamedIcon(PencilIcon, 'Pencil');
export const Play = createNamedIcon(PlayIcon, 'Play');
export const Plus = createNamedIcon(PlusSignIcon, 'Plus');
export const Redo2 = createNamedIcon(Redo02Icon, 'Redo2');
export const RefreshCw = createNamedIcon(Refresh01Icon, 'RefreshCw');
export const RotateCcw = createNamedIcon(RotateLeft02Icon, 'RotateCcw');
export const Scissors = createNamedIcon(Scissor01Icon, 'Scissors');
export const Settings = createNamedIcon(Settings02Icon, 'Settings');
export const SlidersHorizontal = createNamedIcon(SlidersHorizontalIcon, 'SlidersHorizontal');
export const Sparkles = createNamedIcon(SparklesIcon, 'Sparkles');
export const Square = createNamedIcon(SquareIcon, 'Square');
export const SquareArrowOutUpRight = createNamedIcon(SquareArrowUpRightIcon, 'SquareArrowOutUpRight');
export const Sun = createNamedIcon(Sun03Icon, 'Sun');
export const Trash2 = createNamedIcon(Delete02Icon, 'Trash2');
export const Type = createNamedIcon(TextIcon, 'Type');
export const Undo2 = createNamedIcon(Undo02Icon, 'Undo2');
export const Unlink2 = createNamedIcon(Unlink02Icon, 'Unlink2');
export const Upload = createNamedIcon(Upload04Icon, 'Upload');
export const Video = createNamedIcon(Video02Icon, 'Video');
export const Volume2 = createNamedIcon(VolumeHighIcon, 'Volume2');
export const Wand2 = createNamedIcon(MagicWand02Icon, 'Wand2');
export const X = createNamedIcon(Cancel01Icon, 'X');
export const Zap = createNamedIcon(ZapIcon, 'Zap');
export const ZoomIn = createNamedIcon(ZoomInAreaIcon, 'ZoomIn');
export const ZoomOut = createNamedIcon(ZoomOutAreaIcon, 'ZoomOut');
