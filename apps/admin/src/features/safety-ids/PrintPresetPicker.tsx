import {
  CUTTER_PRINT_PRESET,
  DEFAULT_PRINT_PRESET,
  PRINT_PRESETS,
  presetOf,
  type PrintSheetLayout,
} from '@helmet/types';
import { cn } from '@helmet/ui';

const HELP: Record<string, string> = {
  [DEFAULT_PRINT_PRESET]:
    'Edge to edge with shared cut lines. Only for a print shop or press that prints to the paper edge.',
  [CUTTER_PRINT_PRESET]:
    'Margins your printer can print, gaps with 1.2 mm bleed (no white slivers), registration marks and a 100 mm scale check.',
};
const TITLE: Record<string, string> = {
  [DEFAULT_PRINT_PRESET]: 'Print shop · 48-up',
  [CUTTER_PRINT_PRESET]: 'Own printer + cutter · 30-up',
};

/** Choose the sheet layout by how the stickers are produced. */
export function PrintPresetPicker({
  layout,
  onChange,
}: {
  layout: PrintSheetLayout;
  onChange: (l: PrintSheetLayout) => void;
}) {
  const current = presetOf(layout);
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-2 font-medium">How are these printed?</legend>
      <div className="grid gap-2 sm:grid-cols-2">
        {[CUTTER_PRINT_PRESET, DEFAULT_PRINT_PRESET].map((name) => (
          <label
            key={name}
            className={cn(
              'flex cursor-pointer items-start gap-3 rounded-md border p-3',
              current === name ? 'border-ink bg-canvas-soft' : 'border-hairline',
            )}
          >
            <input
              type="radio"
              name="print-preset"
              className="mt-1 accent-primary"
              checked={current === name}
              onChange={() => onChange({ ...PRINT_PRESETS[name]! })}
              data-testid={`preset-${name}`}
            />
            <span>
              <span className="block font-medium">{TITLE[name]}</span>
              <span className="block text-body">{HELP[name]}</span>
            </span>
          </label>
        ))}
      </div>
      {!current && <p className="text-body">Custom layout (edited below).</p>}
    </fieldset>
  );
}
