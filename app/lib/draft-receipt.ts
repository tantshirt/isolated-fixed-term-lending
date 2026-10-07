import type { useDraft } from "../components/create/useDraft";

export type DraftReceipt = Pick<ReturnType<typeof useDraft>, "draft" | "asset" | "owed" | "price">;

/** Keep the submitted terms and their asset together when the editable draft resets. */
export function draftReceipt(value: DraftReceipt): DraftReceipt {
  return structuredClone(value);
}
