import { IconPackage } from '../Icons.jsx';

export default function EmptyState({ title, message, action }) {
  return (
    <div className="empty-state">
      <div className="empty-icon">
        <IconPackage size={18} />
      </div>
      <p className="empty-title">{title ?? 'Nothing here yet'}</p>
      <p className="empty-desc">{message ?? 'Run a command to see results.'}</p>
      {action}
    </div>
  );
}
