import { invoke, isTauri } from '@tauri-apps/api/core';

function ensureTauriRuntime() {
  if (!isTauri()) {
    throw new Error('当前不是 Tauri 环境，请使用 `npm run tauri dev` 启动');
  }
}

export async function convertVideoToMp4(sourcePath: string, projectId: string): Promise<string> {
  ensureTauriRuntime();
  return await invoke('convert_video_to_mp4', { sourcePath, projectId });
}

export async function convertAudioToMp3(sourcePath: string, projectId: string): Promise<string> {
  ensureTauriRuntime();
  return await invoke('convert_audio_to_mp3', { sourcePath, projectId });
}

export async function persistMediaBytesToProject(
  bytes: Uint8Array,
  fileName: string,
  projectId: string,
  kind: 'videos' | 'audios',
): Promise<string> {
  ensureTauriRuntime();
  return await invoke('persist_media_bytes_to_project', {
    bytes: Array.from(bytes),
    fileName,
    projectId,
    kind,
  });
}

export type TosUploadResult = {
  key: string;
  url: string;
  expiresAt: number;
  contentType: string;
  sizeBytes: number;
};

export async function uploadMediaToTos(
  source: string,
  projectId?: string,
): Promise<TosUploadResult> {
  ensureTauriRuntime();
  return await invoke('upload_media_to_tos', { source, projectId });
}

/** @deprecated Use uploadMediaToTos. Kept while old callers are migrated. */
export async function uploadMediaToPublicUrl(source: string): Promise<string> {
  const result = await uploadMediaToTos(source);
  return result.url;
}
