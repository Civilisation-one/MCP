import type { TransportActor } from "./audit.js";

export interface DraftPrRequest {
  repository: "Civilisation-one/MCP";
  title: string;
  body: string;
  head: string;
  base: "main";
}
export interface DraftPrReceipt {
  number: number;
  url: string;
  state: "open";
  draft: true;
  merged: false;
}
export type DraftPrExecutor = (request: DraftPrRequest, actor: TransportActor) => Promise<DraftPrReceipt>;
export type DraftPrAuthorizer = (actor: TransportActor, request: DraftPrRequest) => Promise<boolean>;
