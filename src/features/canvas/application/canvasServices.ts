import { InMemoryCanvasEventBus } from './eventBus';
import { DefaultGraphImageResolver } from './graphImageResolver';
import { nodeCatalog } from './nodeCatalog';
import { CanvasNodeFactory } from './nodeFactory';
import { uuidGenerator } from '../infrastructure/idGenerator';
import { tauriAiGateway } from '../infrastructure/tauriAiGateway';
import { generateText } from '../infrastructure/textGenerationService';
import { createMediaProcessor } from '@/features/media/application/createMediaProcessor';
import type { TextGenerationGateway, ToolProcessor } from './ports';

export const canvasEventBus = new InMemoryCanvasEventBus();
export const canvasNodeFactory = new CanvasNodeFactory(uuidGenerator, nodeCatalog);
export const graphImageResolver = new DefaultGraphImageResolver();
export const canvasMediaProcessor = createMediaProcessor();
export const canvasToolProcessor: ToolProcessor = {
  process: (toolType, sourceImageUrl, options) => (
    canvasMediaProcessor.processImageTool(toolType, sourceImageUrl, options)
  ),
};
export const canvasAiGateway = tauriAiGateway;
export const textGenerationGateway: TextGenerationGateway = {
  generate: generateText,
};
