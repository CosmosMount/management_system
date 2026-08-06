export type AsyncOperationGeneration = {
  begin: () => number;
  cancel: () => void;
  isCurrent: (generation: number) => boolean;
};

/** Prevent an obsolete async operation from writing state after cancellation. */
export function createAsyncOperationGeneration(): AsyncOperationGeneration {
  let currentGeneration = 0;
  return {
    begin() {
      currentGeneration += 1;
      return currentGeneration;
    },
    cancel() {
      currentGeneration += 1;
    },
    isCurrent(generation) {
      return generation === currentGeneration;
    },
  };
}
