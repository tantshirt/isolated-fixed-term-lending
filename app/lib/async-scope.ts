/** Invalidates unfinished work when its owner unmounts or changes. */
export class AsyncScope {
  private generation = 0;

  invalidate() {
    this.generation++;
  }

  capture() {
    const generation = this.generation;
    const active = () => generation === this.generation;
    return {
      active,
      assertActive() {
        if (!active()) throw new Error("The wallet session changed. Try again.");
      },
    };
  }
}
