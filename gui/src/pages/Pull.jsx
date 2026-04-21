import CommandRunner from '../components/CommandRunner.jsx';

export default function PullPage() {
  return (
    <div>
      <div className="page-header">
        <div className="page-header-text">
          <h1>Pull</h1>
          <p className="page-subtitle">Pull latest metadata from your org to local source</p>
        </div>
      </div>

      <CommandRunner command="pull" label="Pull Org Updates" />
    </div>
  );
}
