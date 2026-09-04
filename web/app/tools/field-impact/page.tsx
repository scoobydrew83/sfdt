import { Chrome } from "../../components/Chrome";

export default function FieldImpact() {
  return (
    <Chrome title="Field Impact" path="/tools/field-impact">
      <div className="hero">
        <h1>What writes this field</h1>
        <p className="lede">
          Confirmed writes from Flow metadata. Inferred Apex text hits stay inferred. WEB-8
          then WEB-10, using @sfdt/flow-core.
        </p>
      </div>
    </Chrome>
  );
}
