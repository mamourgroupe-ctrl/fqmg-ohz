import { fileToBase64 } from "@/helpers/capture-frame";
import {
  useCallback,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type DragEvent,
} from "react";

const MAX_ATTACHED_IMAGES = 4;
// Must match the server-side limit (GENERATE_IMAGE_LIMITS.maxBytes in
// src/lib/generate-request-schema.ts). The client check is UX only; the
// server enforces the real boundary.
const MAX_FILE_SIZE_BYTES = 2 * 1024 * 1024; // 2MB per image
const MAX_FILE_SIZE_MB = MAX_FILE_SIZE_BYTES / (1024 * 1024);
// Only container formats the server inspects (magic bytes + dimensions).
const SUPPORTED_IMAGE_TYPES = new Set(["image/png", "image/jpeg"]);

interface UseImageAttachmentsReturn {
  attachedImages: string[];
  isDragging: boolean;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  addImages: (newImages: string[]) => void;
  removeImage: (index: number) => void;
  clearImages: () => void;
  handleFileSelect: (e: ChangeEvent<HTMLInputElement>) => Promise<void>;
  handlePaste: (e: ClipboardEvent) => Promise<void>;
  handleDragOver: (e: DragEvent) => void;
  handleDragLeave: (e: DragEvent) => void;
  handleDrop: (e: DragEvent) => Promise<void>;
  canAddMore: boolean;
  error: string | null;
  clearError: () => void;
}

export function useImageAttachments(): UseImageAttachmentsReturn {
  const [attachedImages, setAttachedImages] = useState<string[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const clearError = useCallback(() => {
    setError(null);
  }, []);

  const filterValidFiles = useCallback((files: File[]): File[] => {
    const validFiles: File[] = [];
    const oversizedFiles: File[] = [];
    const unsupportedFiles: File[] = [];

    for (const file of files) {
      if (file.type && !SUPPORTED_IMAGE_TYPES.has(file.type)) {
        unsupportedFiles.push(file);
      } else if (file.size > MAX_FILE_SIZE_BYTES) {
        oversizedFiles.push(file);
      } else {
        validFiles.push(file);
      }
    }

    if (oversizedFiles.length > 0) {
      const fileNames = oversizedFiles.map((f) => f.name).join(", ");
      setError(
        `${oversizedFiles.length === 1 ? "File" : "Files"} too large (max ${MAX_FILE_SIZE_MB}MB): ${fileNames}`,
      );
    }
    if (unsupportedFiles.length > 0) {
      const fileNames = unsupportedFiles.map((f) => f.name).join(", ");
      setError(
        `${unsupportedFiles.length === 1 ? "File is" : "Files are"} not supported - use PNG or JPEG: ${fileNames}`,
      );
    }

    return validFiles;
  }, []);

  const addImages = useCallback((newImages: string[]) => {
    setAttachedImages((prev) => {
      const combined = [...prev, ...newImages];
      return combined.slice(0, MAX_ATTACHED_IMAGES);
    });
  }, []);

  const removeImage = useCallback((index: number) => {
    setAttachedImages((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const clearImages = useCallback(() => {
    setAttachedImages([]);
  }, []);

  const handleFileSelect = useCallback(
    async (e: ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files || []);
      const imageFiles = files.filter((f) => f.type.startsWith("image/"));
      const validFiles = filterValidFiles(imageFiles);
      if (validFiles.length > 0) {
        const base64Images = await Promise.all(validFiles.map(fileToBase64));
        addImages(base64Images);
      }
      // Reset input so same file can be selected again
      e.target.value = "";
    },
    [addImages, filterValidFiles],
  );

  const handlePaste = useCallback(
    async (e: ClipboardEvent) => {
      const items = Array.from(e.clipboardData.items);
      const imageItems = items.filter((item) => item.type.startsWith("image/"));
      if (imageItems.length > 0) {
        e.preventDefault();
        const files = imageItems
          .map((item) => item.getAsFile())
          .filter((f): f is File => f !== null);
        const validFiles = filterValidFiles(files);
        if (validFiles.length > 0) {
          const base64Images = await Promise.all(validFiles.map(fileToBase64));
          addImages(base64Images);
        }
      }
    },
    [addImages, filterValidFiles],
  );

  const handleDragOver = useCallback((e: DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback(
    async (e: DragEvent) => {
      e.preventDefault();
      setIsDragging(false);

      const files = Array.from(e.dataTransfer.files);
      const imageFiles = files.filter((f) => f.type.startsWith("image/"));
      const validFiles = filterValidFiles(imageFiles);
      if (validFiles.length > 0) {
        const base64Images = await Promise.all(validFiles.map(fileToBase64));
        addImages(base64Images);
      }
    },
    [addImages, filterValidFiles],
  );

  return {
    attachedImages,
    isDragging,
    fileInputRef,
    addImages,
    removeImage,
    clearImages,
    handleFileSelect,
    handlePaste,
    handleDragOver,
    handleDragLeave,
    handleDrop,
    canAddMore: attachedImages.length < MAX_ATTACHED_IMAGES,
    error,
    clearError,
  };
}
