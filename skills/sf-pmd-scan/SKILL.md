---
name: sf-pmd-scan
description: Run Salesforce Code Analyzer (PMD + ESLint + Graph Engine) against this project, parse results, prioritize findings, and generate fix recommendations. Activates when asked about static analysis, PMD, code scanner, or code quality audit.
triggers:
  - pmd
  - code analyzer
  - static analysis
  - code scan
  - linting
  - code quality audit
  - sf scanner
---

# Salesforce Code Analyzer / PMD Scan Skill

Run comprehensive static analysis against this project using Salesforce Code Analyzer v5.

## Setup (if not installed)

```bash
# Install Code Analyzer plugin
sf plugins install code-analyzer@latest

# Verify installation
sf code-analyzer --version

# View all available rules
sf code-analyzer rules list

# View rules by engine
sf code-analyzer rules list --engine pmd
sf code-analyzer rules list --engine eslint
```

## Running Scans

### Full project scan (recommended first run)
```bash
sf code-analyzer run \
  --workspace . \
  --output-file docs/scans/results.json \
  --output-file docs/scans/results.html
```

### Apex only (PMD)
```bash
sf code-analyzer run \
  --workspace force-app/main/default/classes \
  --rule-selector "engine=pmd" \
  --output-file docs/scans/apex-results.json
```

### Critical and high severity only
```bash
sf code-analyzer run \
  --workspace . \
  --rule-selector "severity=1,2" \
  --output-file docs/scans/critical-results.json
```

### LWC / JavaScript (ESLint)
```bash
sf code-analyzer run \
  --workspace force-app/main/default/lwc \
  --rule-selector "engine=eslint" \
  --output-file docs/scans/lwc-results.json
```

### Scan only changed files (for PR reviews)
```bash
# Get changed files from git
CHANGED=$(git diff --name-only HEAD~1 HEAD | grep -E '\.(cls|trigger|js)$' | tr '\n' ',')
sf code-analyzer run \
  --workspace . \
  --path-filter "$CHANGED" \
  --output-file docs/scans/changed-results.json
```

## Parsing Results

When scan results JSON is available, analyze like this:

1. **Group by severity**: Severity 1 (Critical) → Severity 2 (High) → Severity 3 (Medium) → Severity 4 (Low)
2. **Group by rule category**: Security > Performance > Best Practices > Code Style
3. **Sort by frequency**: Rules with 10+ violations across the codebase get a dedicated remediation task

### Key PMD Rule Categories for Apex

| Category | Critical Rules |
|----------|---------------|
| `apex/performance` | AvoidSoqlInLoops, AvoidDmlStatementsInLoops |
| `apex/security` | ApexCRUDViolation, ApexSharingViolations, ApexXSSFromURLParam |
| `apex/bestpractices` | ApexUnitTestClassShouldHaveAsserts, ApexUnitTestShouldNotUseSeeAllDataTrue |
| `apex/errorprone` | EmptyCatchBlock, NullAssignment, ApexBadCrypto |
| `apex/design` | ExcessiveClassLength, CyclomaticComplexity, TooManyFields |
| `apex/codestyle` | ClassNamingConventions, MethodNamingConventions |

## Custom PMD Ruleset

This project can use a custom ruleset at `config/pmd-ruleset.xml`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<ruleset xmlns="http://pmd.sourceforge.net/ruleset/2.0.0"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         name="SF-Rebuild-Ruleset"
         xsi:schemaLocation="http://pmd.sourceforge.net/ruleset/2.0.0
                             https://pmd.sourceforge.io/ruleset_2_0_0.xsd">

    <description>TWU-556 / SF-Rebuild Custom Salesforce Ruleset</description>

    <!-- Always enforce these -->
    <rule ref="category/apex/security.xml"/>
    <rule ref="category/apex/performance.xml"/>
    <rule ref="category/apex/errorprone.xml"/>
    <rule ref="category/apex/bestpractices.xml">
        <!-- Exclude if using custom test data patterns -->
        <!-- <exclude name="ApexUnitTestClassShouldHaveAsserts"/> -->
    </rule>

    <!-- Design thresholds tuned for this project -->
    <rule ref="category/apex/design.xml/ExcessiveClassLength">
        <properties><property name="minimum" value="1000"/></properties>
    </rule>
    <rule ref="category/apex/design.xml/CyclomaticComplexity">
        <properties>
            <property name="classReportLevel" value="50"/>
            <property name="methodReportLevel" value="15"/>
        </properties>
    </rule>

    <!-- Code style — enforce naming -->
    <rule ref="category/apex/codestyle.xml">
        <exclude name="FieldDeclarationsShouldBeAtStart"/> <!-- too strict -->
    </rule>

</ruleset>
```

Run with custom ruleset:
```bash
sf code-analyzer run \
  --workspace . \
  --rule-selector "engine=pmd" \
  --pmd-ruleset config/pmd-ruleset.xml \
  --output-file docs/scans/custom-results.json
```

## Output Format

After scanning, produce this summary:

```
## PMD Scan Results — [date]

### Summary
Total violations: X
- Severity 1 (Critical): X
- Severity 2 (High): X
- Severity 3 (Medium): X
- Severity 4 (Low): X

### Top Issues by Frequency
1. AvoidSoqlInLoops — 12 occurrences across 7 classes
2. ApexCRUDViolation — 8 occurrences across 5 classes
3. EmptyCatchBlock — 5 occurrences

### Files Needing Most Attention
1. SomeService.cls — 15 violations
2. AnotherHandler.cls — 9 violations

### Recommended Fix Order
1. [CRITICAL] Fix SOQL in loops — SomeService.cls lines 42, 67, 89
2. [CRITICAL] Add CRUD checks — ContactHandler.cls lines 23, 45
...
```

## CI/CD Integration

**ALWAYS use the official `forcedotcom/run-code-analyzer@v2` GitHub Action** — do NOT write a manual `run: sf code-analyzer run` shell step. The official action exposes `steps.scan.outputs.num-sev1-violations` and `num-sev2-violations` outputs that make gate checks trivial.

Add to `.github/workflows/code-quality.yml`:
```yaml
- name: Checkout
  uses: actions/checkout@v4

- name: Setup Node.js
  uses: actions/setup-node@v4
  with:
    node-version: ">=20.9.0"

- name: Setup Java (required by PMD)
  uses: actions/setup-java@v4
  with:
    java-version: "11"
    distribution: "zulu"

- name: Install Salesforce CLI
  run: npm install -g @salesforce/cli@latest

- name: Install Code Analyzer plugin
  run: sf plugins install code-analyzer@latest

- name: Run Code Analyzer
  id: scan
  uses: forcedotcom/run-code-analyzer@v2
  with:
    run-arguments: >
      --workspace .
      --output-file results.json
      --output-file results.html

- name: Enforce quality gates
  run: |
    SEV1=${{ steps.scan.outputs.num-sev1-violations }}
    SEV2=${{ steps.scan.outputs.num-sev2-violations }}
    if [ "$SEV1" -gt 0 ]; then echo "FAIL: $SEV1 critical violations"; exit 1; fi
    if [ "$SEV2" -gt 5 ]; then echo "FAIL: $SEV2 high violations (max 5)"; exit 1; fi
    echo "PASS: Quality gates met"

- name: Upload scan results
  uses: actions/upload-artifact@v4
  if: always()
  with:
    name: code-analysis-results
    path: |
      results.json
      results.html
```
