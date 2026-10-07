/** Invalidates asynchronous sign-in work when its wallet or session changes. */
export class SessionScope {
  private wallet: string | null = null;
  private generation = 0;

  setWallet(wallet: string | null) {
    if (wallet !== this.wallet) {
      this.wallet = wallet;
      this.invalidate();
    }
  }

  invalidate() { this.generation++; }
  begin() { this.invalidate(); return this.generation; }
  isCurrent(generation: number) { return this.wallet !== null && generation === this.generation; }
}
