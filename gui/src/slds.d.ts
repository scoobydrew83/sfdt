// Type declarations for @salesforce/design-system-react components.
// The library ships JSX files without bundled .d.ts files, so we declare
// all sub-paths as returning a React component of any props.
declare module '@salesforce/design-system-react/components/*' {
  import type { ComponentType } from 'react';
  const Component: ComponentType<Record<string, unknown>>;
  export default Component;
}
