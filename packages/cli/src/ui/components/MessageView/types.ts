import type { SessionMessage } from "@vegamo/deepcode-core";

export type MessageViewProps = {
  message: SessionMessage;
  collapsed?: boolean;
  width?: number;
  projectRoot?: string;
};
export type ToolSummary = {
  name: string;
  params: string;
  ok: boolean;
  metadata: Record<string, unknown> | null;
};

export type DiffPreviewLine = {
  marker: string;
  lineNumber: number | null;
  content: string;
  kind: "added" | "removed" | "context";
};
