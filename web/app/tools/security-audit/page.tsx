import { Chrome } from "../../components/Chrome";

export default function Security() {
  return (
    <Chrome title="Security" path="/tools/security-audit">
      <div className="hero">
        <h1>Granted access matrix</h1>
        <p className="lede">
          This view will report what profiles and permission sets grant — never “effective”
          access. WEB-8 (PKCE) then WEB-9. Tokens in sessionStorage. Disconnect wipes them.
        </p>
      </div>
    </Chrome>
  );
}
