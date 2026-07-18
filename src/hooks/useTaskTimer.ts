import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { userStorageKey } from "../lib/storage";

type TimerState = "idle" | "running" | "paused" | "done";

type Persisted = {
  state: TimerState;
  /** 当前会话开始时间戳；paused/idle/done 时为 null */
  startedAt: number | null;
  /** 已暂停固化的累计秒数（不含当前运行会话） */
  accumulatedSeconds: number;
  /** 倒计时目标总秒数；null 表示正计时 */
  targetSeconds: number | null;
};

function loadAll(): Record<string, Persisted> {
  try {
    return JSON.parse(localStorage.getItem(userStorageKey("stepup.timer")) || "{}");
  } catch {
    return {};
  }
}

function saveOne(taskId: string, p: Persisted) {
  const all = loadAll();
  all[taskId] = p;
  localStorage.setItem(userStorageKey("stepup.timer"), JSON.stringify(all));
}

function removeOne(taskId: string) {
  const all = loadAll();
  delete all[taskId];
  localStorage.setItem(userStorageKey("stepup.timer"), JSON.stringify(all));
}

/** 导出供单测：真实墙钟累计，禁止二次叠加 localStorage */
export function computeElapsed(
  baseAccumulated: number,
  startedAt: number | null,
  state: TimerState,
  now = Date.now(),
): number {
  if (state === "running" && startedAt !== null) {
    return baseAccumulated + Math.max(0, Math.floor((now - startedAt) / 1000));
  }
  return Math.max(0, baseAccumulated);
}

/**
 * 真实时间计时：
 * - 正计时：elapsed = base + (now - startedAt)
 * - 倒计时：display = max(0, target - elapsed)，到 0 自动 done
 * - 持久化时 running 状态只存 base（不含当前会话），避免二次累加
 */
export function useTaskTimer(taskId: string, _initialSeconds: number = 0) {
  const [state, setState] = useState<TimerState>("idle");
  const [baseAccumulated, setBaseAccumulated] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [target, setTarget] = useState<number | null>(null);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const tickRef = useRef<number | null>(null);
  const baseRef = useRef(0);
  const startedAtRef = useRef<number | null>(null);
  const stateRef = useRef<TimerState>("idle");
  const targetRef = useRef<number | null>(null);
  const hydratedRef = useRef(false);

  useEffect(() => {
    baseRef.current = baseAccumulated;
  }, [baseAccumulated]);
  useEffect(() => {
    startedAtRef.current = startedAt;
  }, [startedAt]);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);
  useEffect(() => {
    targetRef.current = target;
  }, [target]);

  // 初始化：从 localStorage 恢复，running 时立刻补上墙钟时间
  useEffect(() => {
    hydratedRef.current = false;
    const p = loadAll()[taskId];
    if (!p) {
      setState("idle");
      setBaseAccumulated(0);
      setElapsed(0);
      setTarget(null);
      setStartedAt(null);
      hydratedRef.current = true;
      return;
    }

    let nextState = p.state;
    let nextBase = Math.max(0, Number(p.accumulatedSeconds) || 0);
    let nextStartedAt = p.startedAt ?? null;
    const nextTarget =
      p.targetSeconds === null || p.targetSeconds === undefined
        ? null
        : Number(p.targetSeconds);

    if (nextState === "running" && nextStartedAt !== null) {
      const live = computeElapsed(nextBase, nextStartedAt, "running");
      if (nextTarget !== null && live >= nextTarget) {
        nextState = "done";
        nextBase = nextTarget;
        nextStartedAt = null;
        setElapsed(nextTarget);
      } else {
        setElapsed(live);
      }
    } else {
      setElapsed(nextBase);
    }

    setState(nextState);
    setBaseAccumulated(nextBase);
    setTarget(Number.isFinite(nextTarget as number) ? nextTarget : null);
    setStartedAt(nextStartedAt);
    hydratedRef.current = true;
  }, [taskId]);

  // tick：只用 ref 中的 base + startedAt，不读已被污染的 localStorage
  useEffect(() => {
    if (state !== "running" || startedAt === null) return;

    const tick = () => {
      const total = computeElapsed(
        baseRef.current,
        startedAtRef.current,
        "running",
      );
      const tgt = targetRef.current;
      if (tgt !== null && total >= tgt) {
        setElapsed(tgt);
        setBaseAccumulated(tgt);
        setStartedAt(null);
        setState("done");
        saveOne(taskId, {
          state: "done",
          startedAt: null,
          accumulatedSeconds: tgt,
          targetSeconds: tgt,
        });
        return;
      }
      setElapsed(total);
    };

    tick();
    tickRef.current = window.setInterval(tick, 250);
    return () => {
      if (tickRef.current) window.clearInterval(tickRef.current);
    };
  }, [state, startedAt, taskId]);

  // 持久化：running 时只存 base，避免二次累加
  useEffect(() => {
    if (!hydratedRef.current) return;
    if (state === "idle" && baseAccumulated === 0 && startedAt === null) {
      removeOne(taskId);
      return;
    }
    saveOne(taskId, {
      state,
      startedAt,
      accumulatedSeconds: baseAccumulated,
      targetSeconds: target,
    });
  }, [state, startedAt, baseAccumulated, target, taskId]);

  const start = useCallback((targetSeconds: number | null = null) => {
    const now = Date.now();
    setBaseAccumulated(0);
    setElapsed(0);
    setTarget(targetSeconds);
    setStartedAt(now);
    setState("running");
    saveOne(taskId, {
      state: "running",
      startedAt: now,
      accumulatedSeconds: 0,
      targetSeconds: targetSeconds,
    });
  }, [taskId]);

  const pause = useCallback(() => {
    if (stateRef.current !== "running") return;
    const total = computeElapsed(
      baseRef.current,
      startedAtRef.current,
      "running",
    );
    const capped =
      targetRef.current !== null ? Math.min(total, targetRef.current) : total;
    setBaseAccumulated(capped);
    setElapsed(capped);
    setStartedAt(null);
    setState("paused");
    saveOne(taskId, {
      state: "paused",
      startedAt: null,
      accumulatedSeconds: capped,
      targetSeconds: targetRef.current,
    });
  }, [taskId]);

  const resume = useCallback(() => {
    if (stateRef.current !== "paused") return;
    const now = Date.now();
    setStartedAt(now);
    setState("running");
    saveOne(taskId, {
      state: "running",
      startedAt: now,
      accumulatedSeconds: baseRef.current,
      targetSeconds: targetRef.current,
    });
  }, [taskId]);

  const stop = useCallback(() => {
    setState("idle");
    setStartedAt(null);
    setBaseAccumulated(0);
    setElapsed(0);
    setTarget(null);
    removeOne(taskId);
  }, [taskId]);

  const remainingSeconds = useMemo(() => {
    if (target === null) return null;
    return Math.max(0, target - elapsed);
  }, [target, elapsed]);

  /** 倒计时显示剩余；正计时显示已用 */
  const displaySeconds = target !== null ? (remainingSeconds ?? 0) : elapsed;

  return {
    state,
    elapsed,
    target,
    remainingSeconds,
    displaySeconds,
    start,
    pause,
    resume,
    stop,
  };
}

export function formatTime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
}
