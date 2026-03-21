import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export interface ScrapeCheckpointState {
  judiciaryStart: number;
  openCongressOffset: number;
  congressCursor: Record<string, { nextNumber: number; consecutiveMisses: number }>;
  updatedAt: string;
}

const DEFAULT_CHECKPOINT: ScrapeCheckpointState = {
  judiciaryStart: 0,
  openCongressOffset: 0,
  congressCursor: {},
  updatedAt: new Date(0).toISOString(),
};

function sanitizeCongressCursor(
  input: unknown,
): Record<string, { nextNumber: number; consecutiveMisses: number }> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return {};
  }

  const parsed = input as Record<string, unknown>;
  const cursor: Record<string, { nextNumber: number; consecutiveMisses: number }> = {};

  for (const [key, value] of Object.entries(parsed)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      continue;
    }

    const state = value as { nextNumber?: unknown; consecutiveMisses?: unknown };
    const nextNumber =
      typeof state.nextNumber === "number" && Number.isFinite(state.nextNumber)
        ? Math.max(1, Math.floor(state.nextNumber))
        : undefined;
    const consecutiveMisses =
      typeof state.consecutiveMisses === "number" && Number.isFinite(state.consecutiveMisses)
        ? Math.max(0, Math.floor(state.consecutiveMisses))
        : 0;

    if (nextNumber === undefined) {
      continue;
    }

    cursor[key] = { nextNumber, consecutiveMisses };
  }

  return cursor;
}

const CHECKPOINT_PATH = path.resolve(process.cwd(), "data", "scrape-checkpoint.json");

export async function loadScrapeCheckpoint(): Promise<ScrapeCheckpointState> {
  try {
    const raw = await readFile(CHECKPOINT_PATH, "utf8");
    const parsed = JSON.parse(raw) as Partial<ScrapeCheckpointState>;

    return {
      judiciaryStart:
        typeof parsed.judiciaryStart === "number" && Number.isFinite(parsed.judiciaryStart)
          ? Math.max(0, Math.floor(parsed.judiciaryStart))
          : DEFAULT_CHECKPOINT.judiciaryStart,
      openCongressOffset:
        typeof parsed.openCongressOffset === "number" && Number.isFinite(parsed.openCongressOffset)
          ? Math.max(0, Math.floor(parsed.openCongressOffset))
          : DEFAULT_CHECKPOINT.openCongressOffset,
      congressCursor: sanitizeCongressCursor(parsed.congressCursor),
      updatedAt:
        typeof parsed.updatedAt === "string" && parsed.updatedAt.length > 0
          ? parsed.updatedAt
          : DEFAULT_CHECKPOINT.updatedAt,
    };
  } catch {
    return { ...DEFAULT_CHECKPOINT };
  }
}

export async function patchScrapeCheckpoint(
  patch: Partial<Omit<ScrapeCheckpointState, "updatedAt">>,
): Promise<ScrapeCheckpointState> {
  const current = await loadScrapeCheckpoint();
  const nextCongressCursor =
    patch.congressCursor === undefined ? current.congressCursor : sanitizeCongressCursor(patch.congressCursor);

  const next: ScrapeCheckpointState = {
    ...current,
    ...patch,
    judiciaryStart:
      typeof patch.judiciaryStart === "number" && Number.isFinite(patch.judiciaryStart)
        ? Math.max(0, Math.floor(patch.judiciaryStart))
        : current.judiciaryStart,
    openCongressOffset:
      typeof patch.openCongressOffset === "number" && Number.isFinite(patch.openCongressOffset)
        ? Math.max(0, Math.floor(patch.openCongressOffset))
        : current.openCongressOffset,
    congressCursor: nextCongressCursor,
    updatedAt: new Date().toISOString(),
  };

  await mkdir(path.dirname(CHECKPOINT_PATH), { recursive: true });
  await writeFile(CHECKPOINT_PATH, JSON.stringify(next, null, 2), "utf8");

  return next;
}
