/**
 * Frame images are untrusted input: they come from a rendered file, but the bytes are still
 * parsed defensively. Only two container formats are supported, and every limit is checked
 * before anything is sent to a vision provider.
 */

export const SUPPORTED_IMAGE_MIME_TYPES = ["image/jpeg", "image/png"] as const;
export type SupportedImageMimeType = (typeof SUPPORTED_IMAGE_MIME_TYPES)[number];

export interface ImageLimits {
  maxBytes: number;
  maxWidth: number;
  maxHeight: number;
  minWidth: number;
  maxImages: number;
}

export const DEFAULT_IMAGE_LIMITS: ImageLimits = {
  maxBytes: 2 * 1024 * 1024,
  maxWidth: 1_280,
  maxHeight: 1_280,
  minWidth: 64,
  maxImages: 6,
};

export class ImageInspectionError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ImageInspectionError";
  }
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function detectImageMimeType(bytes: Buffer): SupportedImageMimeType | undefined {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  return undefined;
}

function readPngDimensions(bytes: Buffer): { width: number; height: number } | undefined {
  // IHDR must be the first chunk: 8-byte signature, 4-byte length, "IHDR", then width/height.
  if (bytes.length < 24) return undefined;
  if (bytes.subarray(12, 16).toString("ascii") !== "IHDR") return undefined;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

const JPEG_START_OF_FRAME_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

function readJpegDimensions(bytes: Buffer): { width: number; height: number } | undefined {
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1];
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9)) {
      offset += 2;
      continue;
    }
    const segmentLength = bytes.readUInt16BE(offset + 2);
    if (segmentLength < 2) return undefined;
    if (JPEG_START_OF_FRAME_MARKERS.has(marker)) {
      return {
        height: bytes.readUInt16BE(offset + 5),
        width: bytes.readUInt16BE(offset + 7),
      };
    }
    offset += 2 + segmentLength;
  }
  return undefined;
}

export interface InspectedImage {
  mimeType: SupportedImageMimeType;
  width: number;
  height: number;
  sizeBytes: number;
  bytes: Buffer;
}

export function inspectImage(bytes: Buffer, limits: ImageLimits = DEFAULT_IMAGE_LIMITS): InspectedImage {
  if (bytes.length === 0) {
    throw new ImageInspectionError("empty", "The extracted frame is empty.");
  }
  if (bytes.length > limits.maxBytes) {
    throw new ImageInspectionError(
      "too-large",
      `The extracted frame exceeds the ${limits.maxBytes}-byte limit.`,
    );
  }

  const mimeType = detectImageMimeType(bytes);
  if (!mimeType) {
    throw new ImageInspectionError(
      "unsupported-format",
      `Frames must be ${SUPPORTED_IMAGE_MIME_TYPES.join(" or ")}.`,
    );
  }

  const dimensions = mimeType === "image/png" ? readPngDimensions(bytes) : readJpegDimensions(bytes);
  if (!dimensions || dimensions.width <= 0 || dimensions.height <= 0) {
    throw new ImageInspectionError("unreadable-dimensions", "The frame header could not be decoded.");
  }
  if (dimensions.width < limits.minWidth) {
    throw new ImageInspectionError(
      "too-small",
      `Frames must be at least ${limits.minWidth}px wide.`,
    );
  }
  if (dimensions.width > limits.maxWidth || dimensions.height > limits.maxHeight) {
    throw new ImageInspectionError(
      "too-large",
      `Frames must not exceed ${limits.maxWidth}x${limits.maxHeight}.`,
    );
  }

  return { mimeType, ...dimensions, sizeBytes: bytes.length, bytes };
}
