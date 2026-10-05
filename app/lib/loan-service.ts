import type { OfferDraft } from "./offer-validation";
/** Both adapters implement the same seven protocol actions. Simulation never imports a wallet or connection. */
export type LoanAction =
  | "create"
  | "accept"
  | "repay"
  | "cancel"
  | "claim"
  | "liquidate"
  | "close";
export type LoanCommand = { action: LoanAction; draft?: OfferDraft };
export type LoanReceipt = {
  action: LoanAction;
  message: string;
  signature?: string;
  offerId?: string;
};
export interface LoanService {
  execute(command: LoanCommand): Promise<LoanReceipt>;
}
