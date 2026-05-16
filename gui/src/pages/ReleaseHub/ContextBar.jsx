import { IconPackage } from '../../Icons.jsx';
export default function ContextBar({ manifest }) {
  if (!manifest) return null;
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8,
      padding: '7px 16px',
      background: 'var(--bg-subtle)',
      borderBottom: '1px solid var(--border-subtle)',
      fontSize: 12,
      color: 'var(--fg-muted)',
    }}>
      <IconPackage size={12} style={{ color: 'var(--brand-500)' }} />
      <span style={{ color: 'var(--fg-default)', fontWeight: 500 }}>{manifest.name}</span>
      <span style={{ color: 'var(--fg-subtle)' }}>·</span>
      <span style={{ color: 'var(--fg-subtle)', fontSize: 11 }}>{manifest.source}</span>
    </div>
  );
}
