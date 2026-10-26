import { useCallback, useMemo, useState } from 'react';
import {
  DEFAULT_PRINT_LAYOUT,
  layoutToQuery,
  presetOf,
  PRINT_PRESETS,
  type PrintSheetLayout,
  validatePrintLayout,
} from '@helmet/types';

export interface PrintLayoutState {
  layout: PrintSheetLayout;
  query: Record<string, string>;
  valid: boolean;
}

const KEY = 'helmet.print-preset';

/** The preset this browser used last (a per-admin convenience; storage may be unavailable). */
export function rememberedLayout(): PrintSheetLayout {
  try {
    const p = PRINT_PRESETS[localStorage.getItem(KEY) ?? ''];
    if (p) return { ...p };
  } catch {
    // Private mode / blocked storage: fall back to the default.
  }
  return { ...DEFAULT_PRINT_LAYOUT };
}

export function rememberPreset(l: PrintSheetLayout): void {
  const name = presetOf(l);
  if (!name) return;
  try {
    localStorage.setItem(KEY, name);
  } catch {
    // Not remembered; nothing else depends on it.
  }
}

/** Layout editor state shared by the panel and the batch page's download buttons. */
export function usePrintLayout(): [PrintLayoutState, (l: PrintSheetLayout) => void] {
  const [layout, setLayoutState] = useState<PrintSheetLayout>(rememberedLayout);
  const setLayout = useCallback((l: PrintSheetLayout) => {
    rememberPreset(l);
    setLayoutState(l);
  }, []);
  const state = useMemo(
    () => ({
      layout,
      query: layoutToQuery(layout),
      valid: validatePrintLayout(layout).length === 0,
    }),
    [layout],
  );
  return [state, setLayout];
}
