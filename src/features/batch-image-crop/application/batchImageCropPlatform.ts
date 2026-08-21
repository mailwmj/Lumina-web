export interface BatchImageCropPlatform {
  readonly isBrowser: true;
  chooseImagePaths(label: string): Promise<string[] | null>;
  chooseExportDirectory(): Promise<string | null>;
  onCloseRequested(listener: () => void): Promise<() => void>;
  closeWindow(): Promise<void>;
}

export function createBatchImageCropPlatform(): BatchImageCropPlatform {
  return {
    isBrowser: true,
    async chooseImagePaths(_label) {
      return null;
    },
    async chooseExportDirectory() {
      return null;
    },
    async onCloseRequested(_listener) {
      return () => undefined;
    },
    async closeWindow() {},
  };
}
