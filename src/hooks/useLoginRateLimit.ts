import { useState, useCallback, useEffect } from 'react';

interface RateLimitState {
  attempts: number;
  lockoutUntil: number | null;
  lastAttempt: number | null;
}

const STORAGE_KEY = 'login_rate_limit';
const MAX_ATTEMPTS = 5;
const LOCKOUT_DURATIONS = [30, 60, 120, 300, 600]; // seconds: 30s, 1m, 2m, 5m, 10m
const ATTEMPT_RESET_TIME = 15 * 60 * 1000; // 15 minutes

function getStoredState(): RateLimitState {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      return JSON.parse(stored);
    }
  } catch {
    // Ignore storage errors
  }
  return { attempts: 0, lockoutUntil: null, lastAttempt: null };
}

function saveState(state: RateLimitState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Ignore storage errors
  }
}

export function useLoginRateLimit() {
  const [state, setState] = useState<RateLimitState>(getStoredState);
  const [remainingTime, setRemainingTime] = useState<number>(0);

  // Check and update lockout status
  useEffect(() => {
    const checkLockout = () => {
      const now = Date.now();
      const storedState = getStoredState();
      
      // Reset attempts if enough time has passed since last attempt
      if (storedState.lastAttempt && now - storedState.lastAttempt > ATTEMPT_RESET_TIME) {
        const resetState = { attempts: 0, lockoutUntil: null, lastAttempt: null };
        saveState(resetState);
        setState(resetState);
        setRemainingTime(0);
        return;
      }

      // Check if lockout has expired
      if (storedState.lockoutUntil) {
        const remaining = Math.ceil((storedState.lockoutUntil - now) / 1000);
        if (remaining <= 0) {
          const newState = { ...storedState, lockoutUntil: null };
          saveState(newState);
          setState(newState);
          setRemainingTime(0);
        } else {
          setRemainingTime(remaining);
          setState(storedState);
        }
      }
    };

    checkLockout();
    const interval = setInterval(checkLockout, 1000);
    return () => clearInterval(interval);
  }, []);

  const isLocked = useCallback((): boolean => {
    const now = Date.now();
    return state.lockoutUntil !== null && state.lockoutUntil > now;
  }, [state.lockoutUntil]);

  const getRemainingAttempts = useCallback((): number => {
    return Math.max(0, MAX_ATTEMPTS - state.attempts);
  }, [state.attempts]);

  const recordFailedAttempt = useCallback((): { locked: boolean; lockoutSeconds: number } => {
    const now = Date.now();
    const newAttempts = state.attempts + 1;
    
    let lockoutUntil: number | null = null;
    let lockoutSeconds = 0;

    if (newAttempts >= MAX_ATTEMPTS) {
      // Calculate lockout duration based on how many times they've been locked out
      const lockoutIndex = Math.min(
        Math.floor((newAttempts - MAX_ATTEMPTS) / MAX_ATTEMPTS),
        LOCKOUT_DURATIONS.length - 1
      );
      lockoutSeconds = LOCKOUT_DURATIONS[lockoutIndex];
      lockoutUntil = now + lockoutSeconds * 1000;
    }

    const newState = {
      attempts: newAttempts,
      lockoutUntil,
      lastAttempt: now,
    };

    saveState(newState);
    setState(newState);
    setRemainingTime(lockoutSeconds);

    return { locked: lockoutUntil !== null, lockoutSeconds };
  }, [state.attempts]);

  const recordSuccessfulLogin = useCallback((): void => {
    const resetState = { attempts: 0, lockoutUntil: null, lastAttempt: null };
    saveState(resetState);
    setState(resetState);
    setRemainingTime(0);
  }, []);

  const formatRemainingTime = useCallback((): string => {
    if (remainingTime <= 0) return '';
    const minutes = Math.floor(remainingTime / 60);
    const seconds = remainingTime % 60;
    if (minutes > 0) {
      return `${minutes}m ${seconds}s`;
    }
    return `${seconds}s`;
  }, [remainingTime]);

  return {
    isLocked,
    getRemainingAttempts,
    recordFailedAttempt,
    recordSuccessfulLogin,
    remainingTime,
    formatRemainingTime,
    attempts: state.attempts,
  };
}
