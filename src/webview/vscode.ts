import type { FromWebview } from '../shared/protocol';

declare function acquireVsCodeApi(): { postMessage(msg: unknown): void };
const api = acquireVsCodeApi();

export const send = (msg: FromWebview): void => api.postMessage(msg);
