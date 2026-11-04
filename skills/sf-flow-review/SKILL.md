---
name: sf-flow-review
license: Apache-2.0
description: Reviews Salesforce Flow metadata for fault paths, bulk safety, hardcoded IDs, element naming, auto-layout, duplicate automation, and Flow-vs-Apex fit. Use when reviewing, writing, or debugging a .flow-meta.xml file, or when the user asks about flows, record-triggered automation, migrating Process Builder or Workflow Rules, or "why is my flow failing". Not for Apex code review (sf-apex-review) or a whole-project automation inventory (sf-org-audit).
triggers:
  - flow review
  - review flow
  - flow best practices
  - ".flow-meta.xml"
  - automation review
  - flow analysis
  - flow scanner
---

# Salesforce Flow Review Skill

You are an expert Flow architect reviewing the project's flows for production safety, maintainability, and performance.

## Flow Review Checklist

### CRITICAL Issues

#### Missing Fault Paths
Every DML element (Create Records, Update Records, Delete Records, Upsert Records) and every Apex Action must have a Fault connector. Without it, uncaught errors surface as ugly system errors to end users.

Check the XML:
```xml
<!-- BAD: no faultConnector on Create Records element -->
<recordCreates>
    <name>Create_Contact</name>
    <connector><targetReference>Next_Element</targetReference></connector>
    <!-- missing <faultConnector> -->
</recordCreates>

<!-- GOOD -->
<recordCreates>
    <name>Create_Contact</name>
    <connector><targetReference>Next_Element</targetReference></connector>
    <faultConnector><targetReference>Handle_Error</targetReference></faultConnector>
</recordCreates>
```

#### Bulk Safety (Record-Triggered Flows)
Record-Triggered flows fire on every record in a transaction. Avoid:
- Apex Actions whose `@InvocableMethod` isn't bulk-safe (it must accept and return a `List` and avoid per-record SOQL/DML)
- Get Records elements that run inside loops (nested queries)
- Multiple Get Records on the same object — consolidate with filters

#### Hardcoded IDs in Flows
Literal record ID values (`00Q...`, `005...`, or any 15/18-character ID) in decision criteria, assignments, or text templates break on sandbox refresh and between environments. Replace with Custom Metadata, Custom Labels (`{!$Label.x}`), or a Get Records lookup by DeveloperName.

### HIGH Priority

#### Flows Without Descriptions
Every flow should have a description explaining what it does, what objects it runs on, and when it was created.

#### Unconnected Elements
Dead elements waste CPU and confuse future developers. Check for elements with no incoming connector (other than the Start element).

#### Confusing/Non-Standard Naming
- Flow API name: `Object_Action_v2` (e.g., `Account_Update_Owner_v2`)
- Element names: `Get_Account_Records`, `Decision_Is_New_Record`, `Update_Contact_Status`
- Variables: `varAccountId`, `colAccounts` (col = collection)

#### Multiple Loops Without Subflows
Flows with 3+ loops are a complexity smell — consider breaking into subflows or moving to Apex.

### MEDIUM Priority

#### Auto-Layout vs Free-Form
Flows should use Auto Layout for maintainability. Check:
```xml
<processMetadataValues>
    <name>CanvasMode</name>
    <value><stringValue>AUTO_LAYOUT_CANVAS</stringValue></value>
</processMetadataValues>
```
If `FREE_FORM_CANVAS`, recommend converting to Auto Layout.

#### Flow vs Apex Decision Guide
Recommend moving to Apex when:
- Flow has > 30 elements
- Flow requires complex string manipulation
- Flow needs recursive logic
- Flow is performance-sensitive (runs on batch of 10,000+ records)
- Flow needs access to SOQL aggregate functions

Keep in Flow when:
- Simple field updates based on criteria
- Sending emails / creating tasks
- Admins need to maintain it without code releases

#### Missing Flow Versions / Active Version
Only one version of a flow can be active, but inactive versions accumulate and count toward the per-flow version limit. Flag flows with many obsolete versions and suggest deleting old ones. Process Builder and Workflow Rules are retired for new automation — recommend migrating them to flows (Setup → Migrate to Flow).

#### Schedule-Triggered Flows
Verify batch size is considered — schedule flows process records in batches of 200.

## Automated Scanners

If the project uses the sfdt CLI (`.sfdt/` directory present), it has native flow analysis built in — prefer it:
```bash
# Health analysis of every Flow with an active version (writes logs/flow-scan-latest.json)
sfdt flow scan --org <alias> --json

# Find record-triggered flows that collide on the same object + timing + event
sfdt flow conflicts --org <alias> --json
```

Alternatively, the Lightning Flow Scanner sf plugin:
```bash
# Install flow scanner plugin
sf plugins install lightning-flow-scanner

# Scan all flows in the default directory (JSON output for parsing)
sf flow scan --json

# Scan specific flows and fail CI on errors
sf flow scan \
  --files force-app/main/default/flows/MyFlow.flow-meta.xml \
  --failon error
```

## Flow Metadata Quick Reference

Key XML elements to inspect in `.flow-meta.xml`:
- `<processType>` — `AutoLaunchedFlow`, `Flow`, `RecordTriggeredFlow`, `ScheduledFlow`
- `<triggerType>` — `RecordAfterSave`, `RecordBeforeSave`, `Scheduled`
- `<recordCreates>`, `<recordUpdates>`, `<recordDeletes>` — check for `<faultConnector>`
- `<loops>` — look for nested Get Records inside
- `<actionCalls>` — Apex invocable actions; verify bulkification
- `<decisions>` — branching logic; verify all outcomes are connected

## Output Format

```
## Flow Review: [FlowName.flow-meta.xml]

### CRITICAL
- Missing fault path on Create_Contact element — users see system error on DML failure
  Fix: Add Fault connector to error-handling screen or custom notification

### HIGH
- Hardcoded ID '005ABC...' in Assignment element — breaks in sandbox refresh
  Fix: Use Custom Label or Custom Metadata record

### MEDIUM
- Free-form canvas — convert to Auto Layout for team maintainability

### Summary
Flows reviewed: 1
Critical issues: 1 | High: 1 | Medium: 1
```

**Next steps:** When a flow should move to Apex (complex logic, heavy volume), hand the design to `sf-apex-review`. When the flow is ready to ship, use `sf-deploy`. Skip if the user only wanted the review.
