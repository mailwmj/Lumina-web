import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { logger } from '@/lib/logger';
import {
  type PromptTemplate,
  createPromptTemplate,
  updatePromptTemplate,
  DEFAULT_TEMPLATES,
} from '@/features/canvas/domain/promptTemplate';

interface PromptTemplateState {
  templates: PromptTemplate[];
  isHydrated: boolean;
  addTemplate: (template: Omit<PromptTemplate, 'id' | 'createdAt' | 'updatedAt'>) => string;
  updateTemplate: (id: string, updates: Partial<Omit<PromptTemplate, 'id' | 'createdAt'>>) => void;
  deleteTemplate: (id: string) => void;
  getTemplate: (id: string) => PromptTemplate | null;
  resetToDefaults: () => void;
}

export const usePromptTemplateStore = create<PromptTemplateState>()(
  persist(
    (set, get) => ({
      templates: DEFAULT_TEMPLATES,
      isHydrated: false,

      addTemplate: (templateData) => {
        const template = createPromptTemplate(templateData);
        set((state) => ({
          templates: [...state.templates, template],
        }));
        return template.id;
      },

      updateTemplate: (id, updates) => {
        set((state) => ({
          templates: state.templates.map((t) =>
            t.id === id ? updatePromptTemplate(t, updates) : t
          ),
        }));
      },

      deleteTemplate: (id) => {
        set((state) => ({
          templates: state.templates.filter((t) => t.id !== id),
        }));
      },

      getTemplate: (id) => {
        return get().templates.find((t) => t.id === id) ?? null;
      },

      resetToDefaults: () => {
        set({ templates: DEFAULT_TEMPLATES });
      },
    }),
    {
      name: 'prompt-template-storage',
      version: 1,
      onRehydrateStorage: () => {
        return (_state, error) => {
          if (error) {
            logger.error('failed to hydrate prompt template storage', error);
          }
          usePromptTemplateStore.setState({ isHydrated: true });
        };
      },
    }
  )
);
