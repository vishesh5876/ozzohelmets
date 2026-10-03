import react from '@helmet/eslint-config/react';

export default [
  ...react,
  // A component library exports variants/helpers next to components; HMR boundaries live in apps.
  { rules: { 'react-refresh/only-export-components': 'off' } },
];
