import type { AnnotateRequest, AnnotateResponse, ErrorResponse, Reading } from '../core/types';

export interface LookupRequest {
  type: 'lookup';
  word: string;
}

export type BackgroundRequest = AnnotateRequest | LookupRequest;

export interface LookupResponse {
  ok: true;
  readings: Reading[];
}

export function sendToBackground(request: AnnotateRequest): Promise<AnnotateResponse | ErrorResponse>;
export function sendToBackground(request: LookupRequest): Promise<LookupResponse | ErrorResponse>;
export function sendToBackground(request: BackgroundRequest): Promise<unknown> {
  return chrome.runtime.sendMessage(request);
}
