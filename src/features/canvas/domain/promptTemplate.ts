export interface PromptTemplate {
  id: string;
  name: string;
  description?: string;
  style?: string;
  color?: string;
  detail?: 'low' | 'medium' | 'high';
  customPrompt?: string;
  createdAt: number;
  updatedAt: number;
}

export function createPromptTemplate(
  data: Omit<PromptTemplate, 'id' | 'createdAt' | 'updatedAt'>
): PromptTemplate {
  const now = Date.now();
  return {
    ...data,
    id: `template-${now}-${Math.random().toString(36).slice(2, 9)}`,
    createdAt: now,
    updatedAt: now,
  };
}

export function updatePromptTemplate(
  template: PromptTemplate,
  updates: Partial<Omit<PromptTemplate, 'id' | 'createdAt'>>
): PromptTemplate {
  return {
    ...template,
    ...updates,
    updatedAt: Date.now(),
  };
}

export const DEFAULT_TEMPLATES: PromptTemplate[] = [
  {
    id: 'template-default-cinematic',
    name: '电影感',
    description: '适合电影分镜的高对比度、低饱和度风格',
    style: 'cinematic',
    color: 'muted',
    detail: 'high',
    createdAt: 0,
    updatedAt: 0,
  },
  {
    id: 'template-default-anime',
    name: '动漫风格',
    description: '日式动漫风格，色彩鲜艳',
    style: 'anime',
    color: 'vibrant',
    detail: 'medium',
    createdAt: 0,
    updatedAt: 0,
  },
  {
    id: 'template-default-photorealistic',
    name: '写实摄影',
    description: '接近真实摄影的画面质感',
    style: 'photorealistic',
    color: 'natural',
    detail: 'high',
    createdAt: 0,
    updatedAt: 0,
  },
];
