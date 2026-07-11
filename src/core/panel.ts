// Parallel multi-agent verification (the "panel"). The same question is given
// to N independent read-only agents, each with a different investigative lens,
// run concurrently. A final synthesis pass cross-checks their reports for
// agreement, disagreement, and unverified claims. This trades tokens for
// confidence — diverse lenses catch failure modes a single pass misses.
//
// Pure orchestration: the caller injects the agent runner and the synthesizer,
// so this stays testable without a live model.

/** Distinct framings so the agents don't all make the same mistake. */
export const PANEL_LENSES: readonly string[] = [
  "Focus on what is actually true — verify every claim against the real files; cite exact paths and lines.",
  "Focus on edge cases, failure modes, and anything that could break or be wrong.",
  "Focus on hidden assumptions and alternative interpretations the obvious reading might miss.",
  "Focus on completeness — what related code, config, or cases might be relevant but overlooked.",
];

export interface PanelReport {
  lens: string;
  text: string;
  toolCalls: number;
}

export interface PanelResult {
  reports: PanelReport[];
  synthesis: string;
}

export type PanelAgent = (lens: string, question: string, index: number) => Promise<{ text: string; toolCalls: number }>;
export type PanelSynthesizer = (question: string, reports: PanelReport[]) => Promise<string>;

/** Run `count` agents (clamped 2..6) in parallel, then synthesize. */
export async function runPanel(
  question: string,
  count: number,
  runAgent: PanelAgent,
  synthesize: PanelSynthesizer,
): Promise<PanelResult> {
  const n = Math.max(2, Math.min(Math.floor(count) || 3, 6));
  const lenses = Array.from({ length: n }, (_, i) => PANEL_LENSES[i % PANEL_LENSES.length]!);
  const reports = await Promise.all(
    lenses.map(async (lens, i): Promise<PanelReport> => {
      const r = await runAgent(lens, question, i);
      return { lens, text: r.text, toolCalls: r.toolCalls };
    }),
  );
  const synthesis = await synthesize(question, reports);
  return { reports, synthesis };
}

/** Prompt for the synthesis / cross-check pass. */
export function synthesizePrompt(question: string, reports: PanelReport[]): string {
  const bodies = reports
    .map((r, i) => `--- Agent ${i + 1} ---\nLens: ${r.lens}\n${r.text || "(no findings)"}`)
    .join("\n\n");
  return (
    `${reports.length} independent agents investigated the same question with read-only tools. ` +
    `You are the lead reviewer. Cross-check their reports and produce:\n` +
    `1. Consensus answer (what they agree on, stated plainly).\n` +
    `2. Disagreements or unverified claims (call out anything only one agent said, or that conflicts).\n` +
    `3. Confidence: high / medium / low, with a one-line reason.\n` +
    `Prefer claims backed by exact file paths. Do not invent agreement that isn't there.\n\n` +
    `Question: ${question}\n\n${bodies}`
  );
}
