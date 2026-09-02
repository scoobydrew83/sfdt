import Link from "next/link";
import { Chrome } from "../../components/Chrome";
import { SAMPLE_TRAILBLAZERS } from "../../lib/sample";

export default async function Profile({ params }: { params: Promise<{ handle: string }> }) {
  const { handle } = await params;
  const row = SAMPLE_TRAILBLAZERS.find((t) => t.handle === handle);
  return (
    <Chrome title={row?.handle ?? "Unknown"} path="/trailblazers">
      <div className="hero">
        {row ? (
          <>
            <p className="kicker">Public profile</p>
            <h1>{row.name}</h1>
            <p className="lede">
              {row.points.toLocaleString()} points · {row.badges} badges · {row.certs} certs
            </p>
            <p className="faint">Banner and shield routes are WEB-4.</p>
          </>
        ) : (
          <p className="lede">No fixture for {handle}.</p>
        )}
        <p>
          <Link href="/trailblazers">← Leaderboard</Link>
        </p>
      </div>
    </Chrome>
  );
}
