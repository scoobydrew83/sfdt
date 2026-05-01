#!/usr/bin/env bash
# Usage: ./scripts/integration/run-integration-tests.sh [path-to-synthetic-spark]
# Requires: sf CLI, sfdt (npm link from this repo or installed globally)
# DevHub must be authenticated: sf org login jwt ...
set -euo pipefail

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
SYNTHETIC_SPARK_DIR="${1:-./synthetic-spark}"

# Resolve to absolute path so cd doesn't confuse it
SYNTHETIC_SPARK_DIR="$(cd "$SYNTHETIC_SPARK_DIR" && pwd)"

# Unique alias per run so parallel CI jobs don't collide
SCRATCH_ORG_ALIAS="sfdt-integration-$(date +%s)"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
step() {
  echo ""
  echo "=== $1 ==="
  echo ""
}

# ---------------------------------------------------------------------------
# Cleanup — runs on any exit (success or failure)
# ---------------------------------------------------------------------------
cleanup() {
  echo ""
  echo "Cleaning up scratch org: $SCRATCH_ORG_ALIAS"
  sf org delete scratch --target-org "$SCRATCH_ORG_ALIAS" --no-prompt 2>/dev/null || true
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
# 1. Create scratch org
# ---------------------------------------------------------------------------
step "Creating scratch org: $SCRATCH_ORG_ALIAS"

sf org create scratch \
  --definition-file "$SYNTHETIC_SPARK_DIR/config/project-scratch-def.json" \
  --alias "$SCRATCH_ORG_ALIAS" \
  --set-default \
  --duration-days 1 \
  --wait 15

# ---------------------------------------------------------------------------
# 2. Write alias into .sfdt config files (CRITICAL — must happen before any
#    sfdt command runs, otherwise config.js throws ConfigError and exits 2)
# ---------------------------------------------------------------------------
step "Patching .sfdt config with scratch org alias: $SCRATCH_ORG_ALIAS"

node -e "
  const fs = require('fs');
  const cfg = JSON.parse(fs.readFileSync('$SYNTHETIC_SPARK_DIR/.sfdt/config.json', 'utf8'));
  cfg.defaultOrg = '$SCRATCH_ORG_ALIAS';
  fs.writeFileSync('$SYNTHETIC_SPARK_DIR/.sfdt/config.json', JSON.stringify(cfg, null, 2));
  console.log('Wrote defaultOrg to .sfdt/config.json');
"

node -e "
  const fs = require('fs');
  const env = JSON.parse(fs.readFileSync('$SYNTHETIC_SPARK_DIR/.sfdt/environments.json', 'utf8'));
  env.orgs[0].alias = '$SCRATCH_ORG_ALIAS';
  fs.writeFileSync('$SYNTHETIC_SPARK_DIR/.sfdt/environments.json', JSON.stringify(env, null, 2));
  console.log('Wrote orgs[0].alias to .sfdt/environments.json');
"

# ---------------------------------------------------------------------------
# 3. Run sfdt commands from within the fixture project directory
# ---------------------------------------------------------------------------
export SFDT_NON_INTERACTIVE=true
cd "$SYNTHETIC_SPARK_DIR"

# -- sfdt pull ---------------------------------------------------------------
step "sfdt pull"
sfdt pull

# -- sfdt test ---------------------------------------------------------------
step "sfdt test"
sfdt test

# -- sfdt preflight ----------------------------------------------------------
step "sfdt preflight"
sfdt preflight

# -- sfdt deploy -------------------------------------------------------------
step "sfdt deploy"
sfdt deploy

# -- sfdt smoke --------------------------------------------------------------
step "sfdt smoke"
sfdt smoke

# -- sfdt drift --------------------------------------------------------------
step "sfdt drift"
sfdt drift

# -- sfdt compare ------------------------------------------------------------
step "sfdt compare"
sfdt compare

# ---------------------------------------------------------------------------
# 4. Rollback sequence
#    v1 state  → deploy (creates backup)
#    patch XML → deploy (creates backup of v1, now at v2)
#    rollback  → should revert to v1
# ---------------------------------------------------------------------------
step "Rollback sequence — deploy v1 baseline"
sfdt deploy

step "Rollback sequence — add RollbackTest__c field (v2 change)"
mkdir -p force-app/main/default/objects/Synthetic_Widget__c/fields
cat > force-app/main/default/objects/Synthetic_Widget__c/fields/RollbackTest__c.field-meta.xml << 'EOF'
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
sfdt deploy

step "Rollback sequence — rollback to v1"
sfdt rollback

step "Rollback sequence — cleaning up temp field file"
rm force-app/main/default/objects/Synthetic_Widget__c/fields/RollbackTest__c.field-meta.xml

# ---------------------------------------------------------------------------
# Done
# ---------------------------------------------------------------------------
step "All integration tests passed"
