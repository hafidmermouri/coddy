import type { FromWebview, UsageFromWebview } from '../shared/protocol';

declare function acquireVsCodeApi(): { postMessage(msg: unknown): void };
const api = acquireVsCodeApi();

export const send = (msg: FromWebview | UsageFromWebview): void => api.postMessage(msg);
