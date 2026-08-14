import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';

export const THEME_STORAGE_KEY = 'mcp-riksa-theme';
export const themePreferences = ['system', 'light', 'dark'] as const;
export type ThemePreference = typeof themePreferences[number];
export type ResolvedTheme = Exclude<ThemePreference, 'system'>;

type ThemeStorage = Pick<Storage, 'getItem' | 'setItem'>;

function browserStorage(): ThemeStorage | undefined {
  try { return window.localStorage; } catch { return undefined; }
}

export function isThemePreference(value: unknown): value is ThemePreference {
  return typeof value === 'string' && themePreferences.includes(value as ThemePreference);
}

export function readThemePreference(storage: ThemeStorage | undefined): ThemePreference {
  if (!storage) return 'system';
  try {
    const stored = storage.getItem(THEME_STORAGE_KEY);
    return isThemePreference(stored) ? stored : 'system';
  } catch {
    return 'system';
  }
}

export function persistThemePreference(preference: ThemePreference, storage: ThemeStorage | undefined): void {
  if (!storage) return;
  try { storage.setItem(THEME_STORAGE_KEY, preference); } catch { /* Appearance still works for this session. */ }
}

export function resolveTheme(preference: ThemePreference, systemPrefersDark: boolean): ResolvedTheme {
  return preference === 'system' ? (systemPrefersDark ? 'dark' : 'light') : preference;
}

export function applyTheme(theme: ResolvedTheme, root: HTMLElement, themeColor?: HTMLMetaElement | null): void {
  root.dataset.theme = theme;
  root.style.colorScheme = theme;
  themeColor?.setAttribute('content', theme === 'dark' ? '#11110f' : '#f3ede0');
}

export function useThemePreference() {
  const [media] = useState(() => window.matchMedia('(prefers-color-scheme: dark)'));
  const [preference, setPreferenceState] = useState<ThemePreference>(() => readThemePreference(browserStorage()));
  const subscribeToSystemTheme = useCallback((onStoreChange: () => void) => {
    media.addEventListener('change', onStoreChange);
    return () => media.removeEventListener('change', onStoreChange);
  }, [media]);
  const readSystemTheme = useCallback(() => media.matches, [media]);
  const systemPrefersDark = useSyncExternalStore(subscribeToSystemTheme, readSystemTheme, () => false);
  const resolvedTheme = resolveTheme(preference, systemPrefersDark);

  useEffect(() => {
    applyTheme(resolvedTheme, document.documentElement, document.querySelector<HTMLMetaElement>('meta[name="theme-color"]'));
  }, [resolvedTheme]);

  const setPreference = useCallback((next: ThemePreference) => {
    persistThemePreference(next, browserStorage());
    setPreferenceState(next);
  }, []);

  return { preference, resolvedTheme, setPreference };
}
