import EmptyState from '../components/EmptyState.jsx';

export default function PullPage() {
  return (
    <div>
      <div className="page-header">
        <div className="page-header-text">
          <h1>Pull</h1>
          <p className="page-subtitle">Pull latest metadata from your org to local source</p>
        </div>
      </div>

      <EmptyState
        title="Coming Soon"
        message="The Pull page will provide an interactive way to retrieve metadata from a connected org and merge it into your local source. For now, use the Compare page to preview changes, or run sfdt pull from the terminal."
      />
    </div>
  );
}
