import type { XYPosition } from '@xyflow/react';

import type { SeedanceVideoContent } from './seedanceVideoRequestPlan';

import type {
  CanvasEdge,
  CanvasNode,
  CanvasNodeData,
  CanvasNodeType,
  CanvasWorkflowNode,
  NodeToolType,
  StoryboardFrameItem,
} from '../domain/canvasNodes';
import type { CanvasNodeDefinition } from '../domain/nodeRegistry';
import type { TextReasoningEffort } from '../models/types';

export interface IdGenerator {
  next: () => string;
}

export interface NodeCatalog {
  getDefinition: (type: CanvasNodeType) => CanvasNodeDefinition;
  getMenuDefinitions: () => CanvasNodeDefinition[];
}

export interface NodeFactory {
  createNode: (
    type: CanvasNodeType,
    position: XYPosition,
    data?: Partial<CanvasNodeData>
  ) => CanvasNode;
}

export interface GraphImageResolver {
  collectInputImages: (
    nodeId: string,
    nodes: readonly CanvasWorkflowNode[],
    edges: readonly CanvasEdge[]
  ) => string[];
}

export interface GenerateImagePayload {
  prompt: string;
  model: string;
  providerId?: string;
  size: string;
  aspectRatio: string;
  referenceImages?: string[];
  /** Ordered Seedance content for the video provider. */
  videoContent?: SeedanceVideoContent[];
  extraParams?: Record<string, unknown>;
  /** Provider-specific runtime settings that must not be stored on the canvas node. */
  providerConfig?: Record<string, string>;
  /** Draft task ID - when set, generates final video from this draft */
  draftTaskId?: string;
  /** Project ID - when set, images/videos are saved under project-specific subdirectory */
  projectId?: string;
}

export type GenerationJobSubmissionResult =
  | { status: 'fulfilled'; jobId: string }
  | { status: 'rejected'; error: unknown };

export type GenerationJobSubmissionListener = (
  result: GenerationJobSubmissionResult,
  outputIndex: number
) => void;

export interface AiGateway {
  setApiKey: (provider: string, apiKey: string) => Promise<void>;
  generateImage: (payload: GenerateImagePayload) => Promise<string>;
  submitGenerateImageJob: (payload: GenerateImagePayload) => Promise<string>;
  submitGenerateImageJobs: (
    payload: GenerateImagePayload,
    outputCount: number,
    onSettled: GenerationJobSubmissionListener,
    beforeSubmit: () => void
  ) => Promise<GenerationJobSubmissionResult[]>;
  getGenerateImageJob: (jobId: string, providerConfig?: Record<string, string>) => Promise<{
    job_id: string;
    status: 'queued' | 'running' | 'succeeded' | 'failed' | 'not_found' | 'cancelled';
    result?: string | null;
    error?: string | null;
    seed?: number | null;
    external_task_id?: string | null;
    recovery?: {
      retry_count: number;
      next_retry_at?: number | null;
      requires_manual_requery: boolean;
      last_error?: string | null;
    } | null;
  }>;
  retryGenerateImageJob: (jobId: string, providerConfig?: Record<string, string>) => Promise<{
    job_id: string;
    status: 'queued' | 'running' | 'succeeded' | 'failed' | 'not_found' | 'cancelled';
    result?: string | null;
    error?: string | null;
    seed?: number | null;
    external_task_id?: string | null;
    recovery?: {
      retry_count: number;
      next_retry_at?: number | null;
      requires_manual_requery: boolean;
      last_error?: string | null;
    } | null;
  }>;
}

export interface GenerateTextPayload {
  text: string;
  referenceImages?: string[];
  reasoningEffort?: TextReasoningEffort;
}

export interface TextProviderRuntimeConfig {
  apiKey: string;
  baseUrl: string;
  modelId: string;
}

export interface TextGenerationGateway {
  generate: (
    payload: GenerateTextPayload,
    provider: TextProviderRuntimeConfig
  ) => Promise<string>;
}

export interface ImageSplitGateway {
  split: (
    imageSource: string,
    rows: number,
    cols: number,
    lineThickness: number,
    projectId?: string
  ) => Promise<string[]>;
}

export interface ToolProcessorResult {
  outputImageUrl?: string;
  storyboardFrames?: StoryboardFrameItem[];
  rows?: number;
  cols?: number;
  frameAspectRatio?: string;
}

export interface ToolProcessor {
  process: (
    toolType: NodeToolType,
    sourceImageUrl: string,
    options: Record<string, unknown>
  ) => Promise<ToolProcessorResult>;
}

export interface CanvasEventMap {
  'tool-dialog/open': {
    nodeId: string;
    toolType: NodeToolType;
  };
  'tool-dialog/close': undefined;
  'upload-node/reupload': {
    nodeId: string;
  };
  'upload-node/paste-image': {
    nodeId: string;
    file: File;
  };
}

export interface CanvasEventBus {
  publish: <TType extends keyof CanvasEventMap>(
    type: TType,
    payload: CanvasEventMap[TType]
  ) => void;
  subscribe: <TType extends keyof CanvasEventMap>(
    type: TType,
    handler: (payload: CanvasEventMap[TType]) => void
  ) => () => void;
}
