export const STAGES = ["idea", "todo", "doing", "done"] as const;

export type Stage = (typeof STAGES)[number];
export type ActiveStage = Exclude<Stage, "done">;
export type SyncState = "synced" | "syncing" | "offline" | "error" | "draft";

export type IdeaCertainty = "explicit" | "inferred" | "uncertain";

export type IdeaAnalysisItem = {
  text: string;
  certainty: IdeaCertainty;
};

export type IdeaAnalysis = {
  actions: IdeaAnalysisItem[];
  times: IdeaAnalysisItem[];
  people: IdeaAnalysisItem[];
  blockers: IdeaAnalysisItem[];
  uncertainties: string[];
  priority: {
    value: "high" | "medium" | "low" | null;
    certainty: IdeaCertainty;
    reason: string;
  };
};

export type IdeaOrganizationResult = {
  suggestedTitle: string;
  organizedText: string;
  analysis: IdeaAnalysis;
  meta: {
    model: string;
    promptVersion: string;
  };
};

export type AttachmentRecord = {
  id: string;
  cardId: number;
  objectKey?: string;
  filename: string;
  contentType: string;
  size: number;
  sortOrder: number;
  createdAt: string;
  url?: string;
};

export type CardRecord = {
  id: number;
  title: string;
  stage: Stage;
  criteria: string;
  result: string;
  originalText: string;
  organizedText: string;
  aiAnalysis: IdeaAnalysis | null;
  aiModel: string | null;
  aiPromptVersion: string | null;
  aiOrganizedAt: string | null;
  originalTextUpdatedAt: string | null;
  focus: boolean;
  archived: boolean;
  reference: boolean;
  sortOrder: number;
  completedAt: string | null;
  previousStage: ActiveStage | null;
  createdAt: string;
  updatedAt: string;
  attachments: AttachmentRecord[];
};

export type CardDraft = {
  title: string;
  criteria: string;
  result: string;
  originalText: string;
  organizedText: string;
  aiAnalysis: IdeaAnalysis | null;
  aiModel: string | null;
  aiPromptVersion: string | null;
  aiOrganizedAt: string | null;
  stage: Stage;
  savedAt: string;
};

export type CardCreateDetails = Partial<
  Pick<
    CardRecord,
    | "criteria"
    | "result"
    | "originalText"
    | "organizedText"
    | "aiAnalysis"
    | "aiModel"
    | "aiPromptVersion"
    | "aiOrganizedAt"
  >
>;

export type CardPatch = Partial<
  Pick<
    CardRecord,
    | "title"
    | "stage"
    | "criteria"
    | "result"
    | "originalText"
    | "organizedText"
    | "aiAnalysis"
    | "aiModel"
    | "aiPromptVersion"
    | "aiOrganizedAt"
    | "focus"
    | "archived"
    | "reference"
    | "sortOrder"
  >
>;

export function isStage(value: unknown): value is Stage {
  return typeof value === "string" && STAGES.includes(value as Stage);
}
