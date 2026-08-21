import { open } from '@tauri-apps/plugin-dialog';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { runtime } from '@/runtime/runtime';

export interface BatchImageCropPlatform {
  readonly isBrowser: boolean;
  chooseImagePaths(label: string): Promise<string[] | null>;
  chooseExportDirectory(): Promise<string | null>;
  onCloseRequested(listener: () => void): Promise<() => void>;
  closeWindow(): Promise<void>;
}

export function createBatchImageCropPlatform(): BatchImageCropPlatform {
  const isBrowser = !runtime.isDesktop();
  return {
    isBrowser,
    async chooseImagePaths(label) {
      if (isBrowser) return null;
      const selected = await open({
        multiple: true,
        directory: false,
        filters: [{ name: label, extensions: ['jpg', 'jpeg', 'png'] }],
      });
      if (!selected) return null;
      return Array.isArray(selected) ? selected : [selected];
    },
    async chooseExportDirectory() {
      if (isBrowser) return null;
      const selected = await open({ directory: true, multiple: false });
      return typeof selected === 'string' ? selected : null;
    },
    async onCloseRequested(listener) {
      if (isBrowser) return () => undefined;
      return await getCurrentWindow().onCloseRequested((event) => {
        event.preventDefault();
        listener();
      });
    },
    async closeWindow() {
      if (!isBrowser) await getCurrentWindow().close();
    },
  };
}
