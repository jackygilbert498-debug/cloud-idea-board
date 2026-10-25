/** Shared v1 wire contract. Device credentials and local paths never appear here. */
export type CodexTaskStatus =
  | 'queued' | 'dispatching' | 'submitted' | 'acknowledged' | 'running'
  | 'succeeded' | 'failed' | 'cancel_requested' | 'cancelled' | 'needs_attention'
  | 'result_ready' | 'closed' | 'merged';

export interface CodexProject {
  id: string;
  label: string;
  repository?: string;
  isPublic?: boolean;
}

export interface CodexDevice {
  id: string;
  name: string;
  platform: 'windows' | 'macos';
  projects: CodexProject[];
  lastSeenAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export interface CodexTask {
  id: string;
  requestId: string;
  title: string;
  prompt: string;
  acceptance: string;
  targetKind: 'cloud' | 'device';
  deviceId: string | null;
  projectId: string;
  status: CodexTaskStatus;
  actualDeviceId: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  summary: string;
  result: string;
  error: string;
  sessionId: string | null;
  cloudUrl: string | null;
}

export interface CodexTaskOverview {
  tasks: CodexTask[];
  devices: CodexDevice[];
  cloudProjects: CodexProject[];
  cloudEnabled: boolean;
}

export interface CreateCodexTaskInput {
  requestId: string;
  title: string;
  prompt: string;
  acceptance: string;
  targetKind: 'cloud' | 'device';
  deviceId: string | null;
  projectId: string;
}
