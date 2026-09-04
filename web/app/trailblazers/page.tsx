import Link from "next/link";
import { Chrome } from "../components/Chrome";
import { SAMPLE_TRAILBLAZERS } from "../lib/sample";

export default function Trailblazers() {
  return (
    <Chrome title="Trailblazers" path="/trailblazers">
      <div style={{ padding: 24, maxWidth: 880 }}>
        <p className="faint">Public Trailhead cache · fixture until WEB-3</p>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>Handle</th>
                <th>Name</th>
                <th>Points</th>
              </tr>
            </thead>
            <tbody>
              {SAMPLE_TRAILBLAZERS.map((row) => (
                <tr key={row.handle}>
                  <td className="faint">{row.rank}</td>
                  <td className="mono">
                    <Link href={`/trailblazers/${row.handle}`}>{row.handle}</Link>
                  </td>
                  <td>{row.name}</td>
                  <td>{row.points.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </Chrome>
  );
}
