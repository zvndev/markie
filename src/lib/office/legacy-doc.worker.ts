import { extractLegacyDocText } from "./legacy-doc";

const worker = globalThis as unknown as { onmessage: ((event: MessageEvent<Uint8Array>) => void) | null; postMessage(value: unknown): void };
worker.onmessage = (event) => {
  worker.postMessage(extractLegacyDocText(event.data, { maxInputBytes: 32 * 1024 * 1024 }));
};
