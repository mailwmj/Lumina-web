import { forwardRef, type SVGProps } from 'react';
import { HugeiconsIcon, type IconSvgElement } from '@hugeicons/react';

export interface UiIconProps extends Omit<SVGProps<SVGSVGElement>, 'ref'> {
  icon: IconSvgElement;
  size?: number | string;
  strokeWidth?: number;
}

export const UiIcon = forwardRef<SVGSVGElement, UiIconProps>(function UiIcon(
  { icon, size = 16, strokeWidth = 1.8, 'aria-hidden': ariaHidden = true, ...props },
  ref
) {
  return (
    <HugeiconsIcon
      ref={ref}
      icon={icon}
      size={size}
      strokeWidth={strokeWidth}
      color="currentColor"
      aria-hidden={ariaHidden}
      {...props}
    />
  );
});
