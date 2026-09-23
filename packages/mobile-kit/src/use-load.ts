import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Loads data for a screen, keeping the last good value while reloading. `every` polls
 * (e.g. a booking's live status) until `stop` says the value is final.
 */
export function useLoad<T>(
  load: () => Promise<T>,
  deps: readonly unknown[],
  options: { every?: number; stop?: (value: T) => boolean } = {},
) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const loadRef = useRef(load);
  loadRef.current = load;

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const value = await loadRef.current();
      setData(value);
      setError(null);
      return value;
    } catch (e) {
      setError(e);
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let active = true;
    const tick = async () => {
      const value = await reload();
      if (!active) return;
      if (options.every && !(value !== null && options.stop?.(value)))
        timer = setTimeout(() => void tick(), options.every);
    };
    void tick();
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reload when the inputs change
  }, deps);

  return { data, error, loading, reload, setData };
}
