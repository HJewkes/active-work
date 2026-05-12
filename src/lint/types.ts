export type LintLevel = 'warn' | 'error';

export interface LintFinding {
  level: LintLevel;
  slug: string;
  file: string;
  message: string;
}

export interface LintLimits {
  handoffMaxBodyLines: number;
  briefMaxBodyLines: number;
  taskNotesMaxLines: number;
}

export const DEFAULT_LIMITS: LintLimits = {
  handoffMaxBodyLines: 100,
  briefMaxBodyLines: 150,
  taskNotesMaxLines: 30,
};
