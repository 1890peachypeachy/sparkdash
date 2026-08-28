export const TEXT_PROMPTS: string[];
export const STRUCTURAL_PROMPTS: string[];
export const FILL_TO_MAX_SUFFIX: string;
export const DECODE_STRUCTURED_PROMPT: string;

export function withFillToMaxInstruction(prompt: string): string;

export function pickShowcasePrompts(
  type: "structural" | "text" | "mixed",
  count: number
): string[];

export function pickDecodeBenchPrompts(count: number): string[];
