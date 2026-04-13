import { Injectable } from '@nestjs/common';
import type { PipelineCaptureAttachmentDto } from '../orchestrator/orchestrator.dto.js';

export interface CaptureVisionInput {
  imageUrls: string[];
  summaryNote: string;
  attachmentIds: string[];
}

@Injectable()
export class CaptureVisionInputService {
  buildVisionInput(input: {
    attachments?: PipelineCaptureAttachmentDto[];
    maxImages?: number;
  }): CaptureVisionInput {
    const { attachments, maxImages = 3 } = input;
    const selected = (attachments ?? [])
      .filter((attachment) => attachment.asset?.publicUrl)
      .slice(0, maxImages);

    return {
      imageUrls: selected
        .map((attachment) => attachment.asset.publicUrl)
        .filter((value): value is string => Boolean(value)),
      summaryNote:
        selected.length > 0
          ? [
              'Capture image evidence:',
              ...selected.map(
                (attachment) => `- ${formatAttachmentSummary(attachment)}`,
              ),
            ].join('\n')
          : '',
      attachmentIds: selected.map((attachment) => attachment.id),
    };
  }
}

function formatAttachmentSummary(
  attachment: PipelineCaptureAttachmentDto,
): string {
  const parts = [`id=${attachment.id}`];
  if (attachment.note) parts.push(`note="${truncate(attachment.note, 120)}"`);
  if (attachment.captureContext?.page?.route) {
    parts.push(`route=${attachment.captureContext.page.route}`);
  }
  if (attachment.targetNode?.nearestHeading) {
    parts.push(
      `heading="${truncate(attachment.targetNode.nearestHeading, 80)}"`,
    );
  }
  if (attachment.geometry?.documentRect) {
    const rect = attachment.geometry.documentRect;
    parts.push(
      `documentRect=(${rect.x},${rect.y},${rect.width},${rect.height})`,
    );
  } else if (attachment.selection) {
    const rect = attachment.selection;
    parts.push(`selection=(${rect.x},${rect.y},${rect.width},${rect.height})`);
  }
  parts.push(`image=${attachment.asset.publicUrl}`);
  return parts.join(' | ');
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength
    ? value
    : `${value.slice(0, maxLength - 3)}...`;
}
