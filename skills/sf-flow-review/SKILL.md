---
name: sf-flow-review
description: Review Salesforce Flow metadata for best practices — fault paths, bulk safety, element naming, auto-layout, duplicate automation, and Flow vs Apex decision guidance. Activates when discussing flows, flow-meta.xml files, or automation.
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
- Apex Actions that are not `@InvocableMethod(label='...' callout=false)` with proper bulkification
- Get Records elements that run inside loops (nested queries)
- Multiple Get Records on the same object — consolidate with filters

#### Hardcoded IDs in Flows
Any `{!$Label.*}` or literal ID values (`00Q...`, `005...`) in text templates or assignments — use Custom Metadata or Custom Labels instead.

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
Check that flows have exactly ONE active version. Multiple versions waste org limits.

#### Schedule-Triggered Flows
Verify batch size is considered — schedule flows process records in batches of 200.

## Running Lightning Flow Scanner

If the sf CLI plugin is installed:
```bash
# Install flow scanner plugin
sf plugins install lightning-flow-scanner

# Scan all flows
sf flow scan \
  --directory force-app/main/default/flows \
  --format json \
  --output flow-scan-results.json

# Scan specific flow
sf flow scan \
  --directory force-app/main/default/flows/MyFlow.flow-meta.xml
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
