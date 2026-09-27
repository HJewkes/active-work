/**
 * The keyword class pass, ported from the human-blocking investigation's
 * `hb-scripts/tax.py`. First match wins, so the order is part of the rule.
 * The decider corrects a row's class when it cites one; this is only the seed.
 */

const RULES: [string, RegExp][] = [
  [
    'external_action',
    /security key|\btap\b|taps|device code|oauth|\blog ?in\b|login|sign[- ]?in|2fa|\botp\b|apple (id|account)|botfather|token|paste|iterm pane|did it (reply|transcribe)|dialog|in the (chrome )?tab|in your browser|click |press |plug|cable|power|plate is|app now|on your phone|install .* on your|trust (the|this) folder/,
  ],
  [
    'merge_gate',
    /\bmerge|\bpr ?#?\d|#\d{2,}|gate ?[12]|approve (the )?pr|review(er)? (verdict|round)|squash/,
  ],
  [
    'release_publish',
    /publish|release|\bnpm\b|\btag\b|deploy|version bump|cut 0\.|changeset|first publish/,
  ],
  [
    'agent_ops',
    /broker|restart|respawn|spawn|dispatch|implementer|worktree|agent slots?|\bagents?\b|teleport|kill it|headless|profile|budget|parallel/,
  ],
  [
    'session_control',
    /^(next|next step|next steps|wrap|wrap up|close|close out|done\??|end|stop|continue\??|session|meanwhile|while waiting|before you go|now|tonight|proceed|hold|wait|ready|focus)$|what next|anything else|stop here|wrap (it|now|the|up)|end here|done for|keep going|what should (this session|i) (do|work)|while (the|that|you)/,
  ],
  [
    'visual_taste',
    /variant|\bpx\b|colou?r|font|weight|legend|label|spacing|reads?\b|look(s)? right|too loud|wall|card|chart|swatch|pill|tile|layout|specimen|design round|round \d|typography|icon|palette|hue|margin|padding/,
  ],
  [
    'scope_priority',
    /scope|which (task|backlog|items|units)|order|priority|prioriti|sequence|backlog|what should .* work on|first\?|which .* first|task for this session|file (tasks|tickets)|close [a-z]{1,4}-\d+|mark (done|it done)|defer/,
  ],
  [
    'tech_design',
    /approach|decision|\bd\d\b|schema|format|architecture|api|should .* (use|be)|option|keep .* or|how should|which (path|set|model|host)|contract|design|fallback|retry|threshold|default/,
  ],
  [
    'info_request',
    /which account|what did|do you (have|know|want)|how (many|much)|which (device|phone|plan|channel)|does .* have|is there|when do we|availability|your (weight|user id)/,
  ],
];

export interface ClassifyInput {
  header: string;
  question: string;
  options: string[];
}

export function classifyQuestion({ header, question, options }: ClassifyInput): string {
  const hay = `${header} || ${question} || ${options.join(' / ')}`.toLowerCase();
  const head = header.toLowerCase().trim();
  for (const [name, rx] of RULES) {
    // Session control reads only the header and question: option labels like "wrap up" are everywhere.
    const matched =
      name === 'session_control' ? rx.test(head) || rx.test(question.toLowerCase()) : rx.test(hay);
    if (matched) return name;
  }
  return 'other';
}
