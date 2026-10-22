import { useEffect, useRef, useState } from "react";
import { getDocxImageBytes, type DocxDocument, type DocxOperation } from "@/lib/office/docx";

type ImageOperation = Extract<DocxOperation, { type: "insert-image" }>;
export async function decodeWordImage(file: Pick<File, "name" | "size" | "arrayBuffer">): Promise<Omit<ImageOperation, "type" | "afterParagraphId">> {
  if (file.size > 8 * 1024 * 1024) throw new Error("Choose a PNG or JPEG smaller than 8 MB.");
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.length > 8 * 1024 * 1024) throw new Error("Choose a PNG or JPEG smaller than 8 MB.");
  const png = [137, 80, 78, 71, 13, 10, 26, 10].every((byte, i) => bytes[i] === byte);
  const contentType = png ? "image/png" : bytes[0] === 255 && bytes[1] === 216 ? "image/jpeg" : null;
  if (!contentType) throw new Error("Only local PNG and JPEG images are supported. SVG and remote images are not inserted.");
  const blob = new Blob([new Uint8Array(bytes)], { type: contentType });
  let width: number, height: number;
  if (typeof createImageBitmap === "function") {
    const bitmap = await createImageBitmap(blob);
    width = bitmap.width; height = bitmap.height; bitmap.close();
  } else {
    const url = URL.createObjectURL(blob);
    try {
      const image = new Image(); image.src = url;
      if (image.decode) await image.decode();
      else await new Promise<void>((resolve, reject) => { image.onload = () => resolve(); image.onerror = () => reject(new Error("The browser could not decode this image.")); });
      width = image.naturalWidth; height = image.naturalHeight;
    } finally { URL.revokeObjectURL(url); }
  }
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1 || width * height > 32 * 1024 * 1024) throw new Error("The image dimensions are unsupported or too large.");
  return { bytes, contentType, widthPoints: width * 72 / 96, heightPoints: height * 72 / 96, altText: file.name };
}

export function WordImagePicker({ disabled, afterParagraphId, maximumWidthPoints, maximumHeightPoints, onInsert, onError }: {
  disabled: boolean; afterParagraphId?: string; maximumWidthPoints: number; maximumHeightPoints: number;
  onInsert: (operation: ImageOperation) => void; onError: (message: string) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const mounted = useRef(true);
  const [decoding, setDecoding] = useState(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  return <><button type="button" disabled={disabled || decoding} onClick={() => input.current?.click()}>{decoding ? "Reading image…" : "Picture"}</button><input ref={input} type="file" accept="image/png,image/jpeg,.png,.jpg,.jpeg" hidden aria-label="Insert local picture" onChange={async (event) => {
    const file = event.target.files?.[0]; event.target.value = "";
    if (!file) return;
    setDecoding(true);
    try {
      const image = await decodeWordImage(file);
      const scale = Math.max(1 / image.widthPoints, 1 / image.heightPoints,
        Math.min(1, Math.max(1, maximumWidthPoints) / image.widthPoints, Math.max(1, maximumHeightPoints) / image.heightPoints));
      if (image.widthPoints * scale > maximumWidthPoints || image.heightPoints * scale > maximumHeightPoints) throw new Error("This image's aspect ratio cannot fit the current page margins.");
      if (mounted.current) onInsert({ type: "insert-image", afterParagraphId, ...image, widthPoints: image.widthPoints * scale, heightPoints: image.heightPoints * scale });
    } catch (failure) { if (mounted.current) onError(failure instanceof Error ? failure.message : "The image could not be decoded."); }
    finally { if (mounted.current) setDecoding(false); }
  }} /></>;
}

export function WordImage({ document, image, selected, onSelect }: {
  document: DocxDocument; image: DocxDocument["images"][number]; selected: boolean; onSelect: () => void;
}) {
  const [bytes] = useState(() => getDocxImageBytes(document, image.id));
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    const next = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: image.contentType }));
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [bytes, image.contentType]);
  return <button type="button" className="docs-word-image" aria-label={`Select picture: ${image.altText || "Picture"}`} aria-pressed={selected} onClick={onSelect}>{url ? <img src={url} alt={image.altText || "Document picture"} style={{ width: `${image.widthPoints * 96 / 72}px`, height: "auto", maxWidth: "100%" }} /> : <span>Loading picture…</span>}</button>;
}
