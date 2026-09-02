import { VERSION } from "@sfdt/flow-core";

export const runtime = "edge";

export function GET() {
  return Response.json({
    engine: "@sfdt/flow-core",
    version: VERSION,
    orgData: "never",
  });
}
