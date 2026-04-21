import CommandRunner from '../components/CommandRunner.jsx';

export default function QualityPage() {
  return (
    <div>
      <div className="page-header">
        <div className="page-header-text">
          <h1>Quality</h1>
          <p className="page-subtitle">Run code quality analysis on your Salesforce metadata</p>
        </div>
      </div>

      <CommandRunner command="quality" label="Code Quality Analysis" />
    </div>
  );
}
