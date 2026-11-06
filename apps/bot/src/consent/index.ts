export { Admission, admit, type Decision, Gated, gatekeepingOf, type Visit } from "./Admission.ts";

export { ConsentBook, LOOKUP_WAIT, recordAfter } from "./ConsentBook.ts";

export {
  type Choice,
  type ConsentAnswer,
  ConsentGate,
  type ConsentLine,
  type Gate,
  type PromptDelivery,
} from "./ConsentGate.ts";

export { type ConsentEvent, ConsentLog, type ConsentRecord, NEVER_ASKED } from "./ConsentLog.ts";

export * as Notice from "./Notice.ts";
