export interface ProcessedImageAttachment {
  dataUrl: string;
  fileName: string;
  sizeLabel: string;
  dimensions: string;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export async function processImageFile(
  file: File,
  maxDimension = 1440
): Promise<ProcessedImageAttachment> {
  const rawDataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') resolve(reader.result);
      else reject(new Error('Could not read image file.'));
    };
    reader.onerror = () => reject(new Error('Failed to read image file.'));
    reader.readAsDataURL(file);
  });

  return new Promise<ProcessedImageAttachment>((resolve) => {
    const img = new Image();
    img.onload = () => {
      const origW = img.naturalWidth || 1280;
      const origH = img.naturalHeight || 720;
      const scale = Math.min(1, maxDimension / Math.max(origW, origH));
      const targetW = Math.max(1, Math.round(origW * scale));
      const targetH = Math.max(1, Math.round(origH * scale));

      const canvas = document.createElement('canvas');
      canvas.width = targetW;
      canvas.height = targetH;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        resolve({
          dataUrl: rawDataUrl,
          fileName: file.name || 'chart_capture.png',
          sizeLabel: formatBytes(file.size),
          dimensions: `${origW}x${origH}`,
        });
        return;
      }

      ctx.drawImage(img, 0, 0, targetW, targetH);
      const outputMime = file.type === 'image/png' ? 'image/webp' : 'image/jpeg';
      const compressed = canvas.toDataURL(outputMime, 0.86);
      const approxBytes = Math.round((compressed.length * 3) / 4);

      resolve({
        dataUrl: compressed,
        fileName: file.name || `chart_${Date.now()}.webp`,
        sizeLabel: formatBytes(approxBytes),
        dimensions: `${targetW}x${targetH}`,
      });
    };
    img.onerror = () => {
      resolve({
        dataUrl: rawDataUrl,
        fileName: file.name || 'chart_capture.png',
        sizeLabel: formatBytes(file.size),
        dimensions: 'Unknown',
      });
    };
    img.src = rawDataUrl;
  });
}
