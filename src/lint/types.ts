export type LintLevel = 'warn' | 'error';

export interface LintFinding {
  level: LintLevel;
  slug: string;
  file: string;
  message: string;
}

export interface LintLimits {
  briefMaxBodyLines: number;
  taskNotesMaxLines: number;
  openLoopMaxAgeDays: number;
}

export const DEFAULT_LIMITS: LintLimits = {
  briefMaxBodyLines: 150,
  taskNotesMaxLines: 30,
  openLoopMaxAgeDays: 30,
};
