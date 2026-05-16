set -euo pipefail
SYNTHETIC_SPARK_DIR="${1:-./synthetic-spark}"
SYNTHETIC_SPARK_DIR="$(cd "$SYNTHETIC_SPARK_DIR" && pwd)"
if [[ ! -f "$SYNTHETIC_SPARK_DIR/config/project-scratch-def.json" ]]; then
  echo "ERROR: project-scratch-def.json not found in $SYNTHETIC_SPARK_DIR/config/" >&2
  echo "Pass the path to the synthetic-spark fixture as the first argument." >&2
  exit 1
fi
for cmd in sf sfdt node; do
  if ! command -v "$cmd" &>/dev/null; then
    echo "ERROR: '$cmd' not found on PATH. See usage comment." >&2
    exit 1
  fi
done
SCRATCH_ORG_ALIAS="sfdt-integration-$(date +%s)"
step() {
  echo ""
  echo "=== $1 ==="
  echo ""
}
TEMP_FIELD_FILE=""
cleanup() {
  echo ""
  echo "Cleaning up scratch org: $SCRATCH_ORG_ALIAS"
  sf org delete scratch --target-org "$SCRATCH_ORG_ALIAS" --no-prompt 2>/dev/null || true
  if [[ -n "$TEMP_FIELD_FILE" && -f "$TEMP_FIELD_FILE" ]]; then
    rm -f "$TEMP_FIELD_FILE"
    echo "Removed temp field file: $TEMP_FIELD_FILE"
  fi
}
trap cleanup EXIT
step "Creating scratch org: $SCRATCH_ORG_ALIAS"
cd "$SYNTHETIC_SPARK_DIR"
sf org create scratch \
  --definition-file config/project-scratch-def.json \
  --alias "$SCRATCH_ORG_ALIAS" \
  --target-dev-hub "$SF_USERNAME" \
  --set-default \
  --duration-days 1 \
  --wait 15
if [[ ! -f "$SYNTHETIC_SPARK_DIR/.sfdt/config.json" ]]; then
  step "Bootstrapping .sfdt config (fixture has no committed config)"
  mkdir -p "$SYNTHETIC_SPARK_DIR/.sfdt"
  SFDT_DIR="$SYNTHETIC_SPARK_DIR" node -e "
    const fs = require('fs');
    const dir = process.env.SFDT_DIR;
    const config = {
      projectName: 'synthetic-spark',
      defaultOrg: '',
      releaseNotesDir: 'release-notes',
      manifestDir: 'manifest/release',
      deployment: {
        coverageThreshold: 75,
        preflight: {
          enforceTests: false,
          enforceBranchNaming: false,
          enforceChangelog: false,
          enforceGitClean: true,
          enforceSfdxProject: true,
          enforceUntrackedFiles: false,
          strict: false
        }
      },
      features: { ai: false, notifications: false, releaseManagement: true },
      ai: { provider: 'claude', model: '' },
      plugins: [],
      pluginOptions: { autoDiscover: false },
      mcp: { enabled: false },
      pullCache: { enabled: true, parallelism: 5, batchSize: 100, retrieveTimeoutSeconds: 360 },
      manifestLayout: 'flat',
      logRetention: 50
    };
    const environments = {
      default: '',
      orgs: [{ alias: '', type: 'development', description: 'Integration test org' }]
    };
    const pullConfig = {
      metadataTypes: ['ApexClass','ApexTrigger','LightningComponentBundle','CustomObject','CustomField','Layout','FlexiPage','PermissionSet','Flow'],
      targetDir: 'force-app/main/default'
    };
    const testConfig = {
      coverageThreshold: 75,
      testLevel: 'RunLocalTests',
      suites: [],
      testClasses: [],
      apexClasses: []
    };
    fs.writeFileSync(dir + '/.sfdt/config.json', JSON.stringify(config, null, 2));
    fs.writeFileSync(dir + '/.sfdt/environments.json', JSON.stringify(environments, null, 2));
    fs.writeFileSync(dir + '/.sfdt/pull-config.json', JSON.stringify(pullConfig, null, 2));
    fs.writeFileSync(dir + '/.sfdt/test-config.json', JSON.stringify(testConfig, null, 2));
    console.log('Bootstrapped .sfdt/ config files');
  "
fi
step "Patching .sfdt config with scratch org alias: $SCRATCH_ORG_ALIAS"
SFDT_DIR="$SYNTHETIC_SPARK_DIR" SFDT_ALIAS="$SCRATCH_ORG_ALIAS" node -e "
  const fs = require('fs');
  const dir = process.env.SFDT_DIR;
  const alias = process.env.SFDT_ALIAS;
  const cfg = JSON.parse(fs.readFileSync(dir + '/.sfdt/config.json', 'utf8'));
  cfg.defaultOrg = alias;
  // sfdt pull always leaves uncommitted files; disable the git-clean preflight gate
  if (!cfg.deployment) cfg.deployment = {};
  if (!cfg.deployment.preflight) cfg.deployment.preflight = {};
  cfg.deployment.preflight.enforceGitClean = false;
  fs.writeFileSync(dir + '/.sfdt/config.json', JSON.stringify(cfg, null, 2));
  console.log('Wrote defaultOrg and disabled enforceGitClean in .sfdt/config.json');
"
SFDT_DIR="$SYNTHETIC_SPARK_DIR" SFDT_ALIAS="$SCRATCH_ORG_ALIAS" node -e "
  const fs = require('fs');
  const dir = process.env.SFDT_DIR;
  const alias = process.env.SFDT_ALIAS;
  const env = JSON.parse(fs.readFileSync(dir + '/.sfdt/environments.json', 'utf8'));
  if (!env.orgs || !env.orgs[0]) { console.error('environments.json has no orgs[0]'); process.exit(1); }
  env.orgs[0].alias = alias;
  fs.writeFileSync(dir + '/.sfdt/environments.json', JSON.stringify(env, null, 2));
  console.log('Wrote orgs[0].alias to .sfdt/environments.json');
"
export SFDT_NON_INTERACTIVE=true
step "sfdt pull"
sfdt pull
step "sfdt preflight"
sfdt preflight
step "sfdt deploy"
sfdt deploy --source-dir force-app/main/default
step "sfdt test"
sfdt test
step "sfdt smoke"
sfdt smoke
step "sfdt drift"
sfdt drift
step "sfdt compare"
sfdt compare
step "Rollback sequence — deploy v1 baseline"
sfdt deploy --source-dir force-app/main/default
step "Rollback sequence — add RollbackTest__c field (v2 change)"
TEMP_FIELD_FILE="$SYNTHETIC_SPARK_DIR/force-app/main/default/objects/Synthetic_Widget__c/fields/RollbackTest__c.field-meta.xml"
mkdir -p "$SYNTHETIC_SPARK_DIR/force-app/main/default/objects/Synthetic_Widget__c/fields"
cat > "$TEMP_FIELD_FILE" << 'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>RollbackTest__c</fullName>
    <label>Rollback Test</label>
    <required>false</required>
    <type>Checkbox</type>
    <defaultValue>false</defaultValue>
</CustomField>
EOF
step "Rollback sequence — deploy v2"
sfdt deploy --source-dir force-app/main/default
step "Rollback sequence — rollback to v1"
sfdt rollback
step "Rollback sequence — cleaning up temp field file"
rm -f "$TEMP_FIELD_FILE"
TEMP_FIELD_FILE=""
step "All integration tests passed"
