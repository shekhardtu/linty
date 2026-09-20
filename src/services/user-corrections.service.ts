import { initializeHistory, mutateHistory } from "@/services/history.service";
import type { CorrectionRecord } from "@/types/correction.types";

export const initializeCorrections = initializeHistory;
export const recordCorrection = (record: CorrectionRecord) =>
  mutateHistory<void>("history_add_correction", { record });
