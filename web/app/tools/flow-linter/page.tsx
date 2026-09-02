import { Chrome } from "../../components/Chrome";

export default function FlowLinter() {
  return (
    <Chrome title="Flow Studio" path="/tools/flow-linter">
      <div className="bar">
        <div className="row" style={{ marginTop: 0 }}>
          <button type="button" className="pill">
            Drop
          </button>
          <button type="button" className="pill" disabled>
            Pull from org
          </button>
          <span className="mono" style={{ fontSize: 18, marginLeft: "auto" }}>
            —
          </span>
          <span className="muted" style={{ fontSize: 12 }}>
            Drop a .flow-meta.xml
          </span>
        </div>
        <p className="faint" style={{ margin: "8px 0 0" }}>
          Parse · Lint · Score · Layout — not in this version
        </p>
      </div>
      <div className="studio">
        <div className="pane">
          <div className="drop">
            <p>
              Drop a <span className="mono muted">.flow-meta.xml</span>
            </p>
            <p className="muted" style={{ fontSize: 13, maxWidth: 420 }}>
              Analysis will run in this browser. Org metadata is never sent to SFDT
              servers. The worker that scores against <span className="mono">@sfdt/flow-core</span>{" "}
              <span className="mono">runFlowQuality</span> is WEB-6.
            </p>
          </div>
        </div>
        <aside className="rules">
          <strong>Rules + Recent</strong>
          <p className="faint">Toggles land with WEB-7. Files stay in this tab.</p>
        </aside>
      </div>
    </Chrome>
  );
}
