// Local runtime safety checks.  A wrong num_ctx silently spills an otherwise
// usable open model to CPU; warn before that happens, but never override an
// explicit user setting with an uncertain hardware heuristic.

import { execFile } from "node:child_process";

const CONTEXT_STEPS = [2_048, 4_096, 8_192, 16_384, 32_768, 65_536, 131_072];

function parameterBillions(model: string): number | undefined {
  const match = model.match(/(?:^|[:\-])([0-9]+(?:\.[0-9]+)?)b(?:\b|[-_:])/i);
  return match ? Number(match[1]) : undefined;
}

/** Conservative q4-style estimate; undefined when a model name has no size. */
export function recommendedNumCtx(model: string, vramMiB: number): number | undefined {
  const billions = parameterBillions(model);
  if (!billions || !Number.isFinite(vramMiB) || vramMiB < 2_000) return undefined;
  // Quantized weights (~0.7 GiB / parameter billion) + a 1 GiB runtime
  // reserve. KV-cache cost rises with model width; round down to an accepted
  // power-of-two context length rather than pretending this is exact VRAM math.
  const kvBudget = vramMiB - billions * 700 - 1_024;
  const tokens = kvBudget / Math.max(0.08, billions * 0.012);
  return [...CONTEXT_STEPS].reverse().find((step) => step <= tokens);
}

export function contextWindowWarning(model: string, requested: number, vramMiB: number): string | undefined {
  const recommended = recommendedNumCtx(model, vramMiB);
  if (!recommended || requested <= recommended) return undefined;
  return (
    `local GPU has ${Math.round(vramMiB / 1024)} GiB VRAM; ${model} with num_ctx=${requested} may spill to CPU. ` +
    `Conservative local recommendation: OMCODE_NUM_CTX=${recommended}. Your explicit setting was not changed.`
  );
}

/** Best-effort NVIDIA probe. Unsupported systems and missing drivers are silent. */
export function detectNvidiaVramMiB(): Promise<number | undefined> {
  return new Promise((resolve) => {
    execFile(
      "nvidia-smi",
      ["--query-gpu=memory.total", "--format=csv,noheader,nounits"],
      { timeout: 1_500, windowsHide: true },
      (error, stdout) => {
        if (error) return resolve(undefined);
        const values = stdout
          .split(/\r?\n/)
          .map((line) => Number(line.trim()))
          .filter((value) => Number.isFinite(value) && value > 0);
        resolve(values.length ? Math.max(...values) : undefined);
      },
    );
  });
}
