---
name: sf-org-audit
description: Full health audit of this Salesforce project — summarizes Apex class count, test coverage gaps, trigger patterns, flow inventory, LWC count, CI/CD status, and generates a prioritized remediation report. Run this for a top-level health check.
triggers:
  - org audit
  - project audit
  - health check
  - code audit
  - full review
  - analyze project
  - project analysis
---

# Salesforce Project Health Audit Skill

Perform a comprehensive health audit of this Salesforce DX project. Work through each phase systematically.

## Phase 1: Project Structure Discovery

```bash
# Count metadata by type
echo "=== Apex Classes ===" && find force-app -name "*.cls" | wc -l
echo "=== Test Classes ===" && grep -rl "@isTest" force-app --include="*.cls" | wc -l
echo "=== Triggers ===" && find force-app -name "*.trigger" | wc -l
echo "=== Flows ===" && find force-app -name "*.flow-meta.xml" | wc -l
echo "=== LWC Components ===" && find force-app -name "*.js-meta.xml" | wc -l
echo "=== Custom Objects ===" && find force-app -name "*.object-meta.xml" | wc -l
echo "=== Permission Sets ===" && find force-app -name "*.permissionset-meta.xml" | wc -l

# Check for trigger framework
find force-app -name "TriggerHandler.cls" -o -name "*TriggerHandler*" | head -5

# Check for test data factory
find force-app -name "*TestData*" -o -name "*TestFactory*" | head -5

# Check CI/CD
ls .github/workflows/ 2>/dev/null || echo "No GitHub Actions workflows"

# Check for PMD config
find . -name "pmd-ruleset.xml" -o -name ".pmdruleset.xml" | head -3
```

## Phase 2: Anti-Pattern Detection

```bash
# SOQL in loops (critical)
grep -rn "for(" force-app --include="*.cls" --include="*.trigger" -A 5 | grep -B 3 "SELECT"

# DML in loops (critical)
grep -rn "for(" force-app --include="*.cls" --include="*.trigger" -A 5 | grep -B 3 -E "(insert|update|delete|upsert) "

# Hardcoded IDs (critical)
grep -rn "'[a-zA-Z0-9]\{15,18\}'" force-app --include="*.cls" --include="*.trigger"

# Empty catch blocks (high)
grep -rn "catch.*{" force-app --include="*.cls" -A 1 | grep -B 1 "^--$\|^}"

# Logic in triggers (high — triggers should be 1-3 lines)
wc -l force-app/main/default/triggers/*.trigger 2>/dev/null | sort -rn | head -10

# Test classes without assertions (medium)
grep -rL "System.assert\|System.assertEquals\|System.assertNotEquals" \
  $(grep -rl "@isTest" force-app --include="*.cls") 2>/dev/null

# Missing @testSetup (medium)
echo "Test classes:" && grep -rl "@isTest" force-app --include="*.cls" | wc -l
echo "With @testSetup:" && grep -rl "@testSetup" force-app --include="*.cls" | wc -l

# without sharing (review for security)
grep -rn "without sharing" force-app --include="*.cls" | grep -v "//"
```

## Phase 3: Flow Analysis

```bash
# List all active flows by type
grep -rh "<processType>" force-app --include="*.flow-meta.xml" | sort | uniq -c | sort -rn

# Check for missing fault paths on DML elements
grep -rL "<faultConnector>" \
  $(grep -rl "<recordCreates>\|<recordUpdates>\|<recordDeletes>" \
    force-app --include="*.flow-meta.xml") 2>/dev/null | head -20

# Check for free-form canvas (vs auto-layout)
grep -rl "FREE_FORM_CANVAS" force-app --include="*.flow-meta.xml" | wc -l

# Largest flows by element count
grep -c "<name>" force-app/main/default/flows/*.flow-meta.xml 2>/dev/null | sort -t: -k2 -rn | head -10
```

## Phase 4: CI/CD Assessment

Check `.github/workflows/` for:
- Automated test execution on PRs
- Code Analyzer / PMD static analysis gates
- Scratch org deployment validation
- Code coverage threshold enforcement

## Phase 5: Security Review

```bash
# Classes without sharing declaration (implicit = no sharing)
grep -rL "with sharing\|without sharing\|inherited sharing" \
  force-app/main/default/classes/*.cls 2>/dev/null | grep -v Test

# Apex without CRUD/FLS / USER_MODE / SECURITY_ENFORCED
grep -rL "WITH USER_MODE\|WITH SECURITY_ENFORCED\|isAccessible\|isCreateable\|isUpdateable" \
  force-app/main/default/classes/*.cls 2>/dev/null | grep -v Test | head -20
```

## Audit Report Format

Produce this structured report after completing all phases:

```json
{
  "audit_date": "YYYY-MM-DD",
  "summary": {
    "overall_health": "GOOD | FAIR | POOR",
    "apex_classes": 0,
    "test_classes": 0,
    "test_ratio": "0%",
    "triggers": 0,
    "flows": 0,
    "lwc_components": 0,
    "has_trigger_framework": false,
    "has_test_data_factory": false,
    "has_cicd": false
  },
  "critical_findings": [],
  "high_findings": [],
  "medium_findings": [],
  "architecture_assessment": {
    "trigger_framework": "MISSING | PARTIAL | IMPLEMENTED",
    "separation_of_concerns": "POOR | FAIR | GOOD",
    "bulkification": "NEEDS_WORK | FAIR | GOOD",
    "security_checks": "MISSING | PARTIAL | GOOD",
    "test_strategy": "POOR | FAIR | GOOD",
    "cicd_maturity": "NONE | BASIC | ADVANCED"
  },
  "immediate_actions": [],
  "short_term_actions": [],
  "long_term_actions": []
}
```
