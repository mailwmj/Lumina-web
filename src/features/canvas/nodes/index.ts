import type { NodeTypes } from '@xyflow/react';

import { GroupNode } from './GroupNode';
import { ImageEditNode } from './ImageEditNode';
import { ImageNode } from './ImageNode';
import { AudioUploadNode } from './SD2AudioUploadNode';
import { SD2VideoGenNode } from './SD2VideoGenNode';
import { VideoUploadNode } from './SD2VideoUploadNode';
import { StoryboardGenNode } from './StoryboardGenNode';
import { StoryboardNode } from './StoryboardNode';
import { TextAnnotationNode } from './TextAnnotationNode';
import { TextGenerationNode } from './TextGenerationNode';
import { UploadNode } from './UploadNode';
import { VideoGenNode } from './VideoGenNode';
import { VideoResultNode } from './VideoResultNode';

export const nodeTypes: NodeTypes = {
  exportImageNode: ImageNode,
  exportVideoNode: VideoResultNode,
  groupNode: GroupNode,
  imageNode: ImageEditNode,
  audioUploadNode: AudioUploadNode,
  videoUploadNode: VideoUploadNode,
  audioUploadRefNode: AudioUploadNode,
  videoUploadRefNode: VideoUploadNode,
  sd2VideoGenNode: SD2VideoGenNode,
  storyboardGenNode: StoryboardGenNode,
  storyboardNode: StoryboardNode,
  textAnnotationNode: TextAnnotationNode,
  textGenerationNode: TextGenerationNode,
  uploadNode: UploadNode,
  videoFrameNode: VideoGenNode,
  videoSingleNode: VideoGenNode,
  seedanceAutoVideoNode: VideoGenNode,
};

export { AudioUploadNode, GroupNode, ImageEditNode, ImageNode, SD2VideoGenNode, StoryboardGenNode, StoryboardNode, TextAnnotationNode, TextGenerationNode, UploadNode, VideoGenNode, VideoResultNode, VideoUploadNode };
