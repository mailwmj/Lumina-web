import { InMemoryCanvasEventBus } from './eventBus';
import { DefaultGraphImageResolver } from './graphImageResolver';
import { nodeCatalog } from './nodeCatalog';
import { CanvasNodeFactory } from './nodeFactory';
import { uuidGenerator } from '../infrastructure/idGenerator';
import { webGenerationGateway } from '../infrastructure/webGenerationGateway';
import { generateText } from '../infrastructure/textGenerationService';
import { getRuntimeAssetRepository, runtimeMediaProcessor } from '@/runtime/mediaRuntime';
import type { TextGenerationGateway, ToolProcessor } from './ports';

export const canvasEventBus = new InMemoryCanvasEventBus();
export const canvasNodeFactory = new CanvasNodeFactory(uuidGenerator, nodeCatalog);
export const graphImageResolver = new DefaultGraphImageResolver();
export const canvasMediaProcessor = runtimeMediaProcessor;
export const getCanvasAssetRepository = getRuntimeAssetRepository;
export const canvasToolProcessor: ToolProcessor = {
  process: (toolType, sourceImageUrl, options) => (
    canvasMediaProcessor.processImageTool(toolType, sourceImageUrl, options)
  ),
};
export const canvasAiGateway = webGenerationGateway;
export const textGenerationGateway: TextGenerationGateway = {
  generate: generateText,
};
