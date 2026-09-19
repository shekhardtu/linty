import type { TranscriptRecord } from "../types/transcript.types.ts";
export function deliveryLabel(status: TranscriptRecord["deliveryStatus"]): string {
  switch (status) {
    case "verified": return "Insertion confirmed";
    case "unverified": return "Paste sent — insertion unconfirmed";
    case "pasted": return "Paste sent — legacy record";
    case "failed": return "Paste failed — copy text to retry";
    case "pending": return "Delivery not completed";
    case "skipped": return "Nothing to paste";
    default: return "Not recorded";
  }
}
