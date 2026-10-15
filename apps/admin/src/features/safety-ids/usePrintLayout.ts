import { useMemo, useState } from 'react';
import {
  DEFAULT_PRINT_LAYOUT,
  layoutToQuery,
  type PrintSheetLayout,
  validatePrintLayout,
} from '@helmet/types';

export interface PrintLayoutState {
  layout: PrintSheetLayout;
  query: Record<string, string>;
  valid: boolean;
}

/** Layout editor state shared by the panel and the batch page's download buttons. */
export function usePrintLayout(): [PrintLayoutState, (l: PrintSheetLayout) => void] {
  const [layout, setLayout] = useState<PrintSheetLayout>({ ...DEFAULT_PRINT_LAYOUT });
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
