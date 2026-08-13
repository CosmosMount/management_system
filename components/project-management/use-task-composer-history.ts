"use client";

import { useCallback, useRef, useState } from "react";
import type { TaskComposerSeed } from "@/lib/project-management/composer-contract";

const MAX_HISTORY = 80;

type ComposerHistory = {
  past: TaskComposerSeed[];
  present: TaskComposerSeed;
  future: TaskComposerSeed[];
};

export function useTaskComposerHistory(initialState: TaskComposerSeed) {
  const [history, setHistory] = useState<ComposerHistory>({
    past: [],
    present: initialState,
    future: [],
  });
  const liveEditEntityRef = useRef<string | null>(null);

  const commit = useCallback(
    (mutator: (current: TaskComposerSeed) => TaskComposerSeed) => {
      setHistory((current) => ({
        past: [...current.past.slice(-(MAX_HISTORY - 1)), current.present],
        present: mutator(current.present),
        future: [],
      }));
    },
    [],
  );

  const replacePresent = useCallback(
    (mutator: (current: TaskComposerSeed) => TaskComposerSeed) => {
      setHistory((current) => ({
        ...current,
        present: mutator(current.present),
      }));
    },
    [],
  );

  const reset = useCallback((state: TaskComposerSeed) => {
    liveEditEntityRef.current = null;
    setHistory({ past: [], present: state, future: [] });
  }, []);

  const endLiveEdit = useCallback(() => {
    liveEditEntityRef.current = null;
  }, []);

  const commitLiveEdit = useCallback(
    (
      entityId: string,
      mutator: (current: TaskComposerSeed) => TaskComposerSeed,
    ) => {
      if (liveEditEntityRef.current === entityId) {
        replacePresent(mutator);
        return;
      }
      liveEditEntityRef.current = entityId;
      commit(mutator);
    },
    [commit, replacePresent],
  );

  const undo = useCallback(() => {
    liveEditEntityRef.current = null;
    setHistory((current) => {
      const previous = current.past.at(-1);
      if (!previous) return current;
      return {
        past: current.past.slice(0, -1),
        present: previous,
        future: [current.present, ...current.future].slice(0, MAX_HISTORY),
      };
    });
  }, []);

  const redo = useCallback(() => {
    liveEditEntityRef.current = null;
    setHistory((current) => {
      const next = current.future[0];
      if (!next) return current;
      return {
        past: [...current.past, current.present].slice(-MAX_HISTORY),
        present: next,
        future: current.future.slice(1),
      };
    });
  }, []);

  return {
    history,
    state: history.present,
    commit,
    commitLiveEdit,
    endLiveEdit,
    redo,
    replacePresent,
    reset,
    undo,
  };
}
