import Link from "next/link";
import { Chrome } from "./components/Chrome";
import { SAMPLE_TRAILBLAZERS } from "./lib/sample";

export default function Home() {
  return (
    <Chrome title="Hub" path="/">
      <div className="hero">
        <p className="kicker">Edge · public data only</p>
        <h1>Salesforce tools that stay on your machine.</h1>
        <p className="lede">
          Drop a Flow and lint it in a Web Worker. Audit granted permissions in the browser.
          The public Trailblazer hub is the only thing that hits Cloudflare — and it only
          caches what Trailhead already publishes.
        </p>
        <div className="row">
          <Link className="btn btn-primary" href="/tools/flow-linter">
            Open Flow Studio
          </Link>
          <Link className="btn btn-ghost" href="/trailblazers">
            Leaderboard
          </Link>
        </div>
      </div>
      <div style={{ padding: "0 16px 32px", maxWidth: 880 }}>
        <p className="faint">Fixture · live ingest is WEB-3</p>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>Handle</th>
                <th>Points</th>
                <th>Badges</th>
              </tr>
            </thead>
            <tbody>
              {SAMPLE_TRAILBLAZERS.map((row) => (
                <tr key={row.handle}>
                  <td className="faint">{row.rank}</td>
                  <td className="mono">{row.handle}</td>
                  <td>{row.points.toLocaleString()}</td>
                  <td>{row.badges}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </Chrome>
  );
}
