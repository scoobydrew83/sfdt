---
name: sf-apex-review
description: Production-grade Apex code review for this Salesforce project. Catches SOQL/DML in loops, CRUD/FLS gaps, missing bulkification, hardcoded IDs, empty catches, stale API versions, deprecated testMethod, Trigger.oldMap omissions, Datetime/Date type mismatches, unbounded @AuraEnabled queries, null relationship traversals, Database.Stateful waste, global vs public misuse, constant expressions inside loops, and missing batch idempotency guards. Use whenever reviewing or writing any .cls or .trigger file, or when asked to audit, review, check, or security-scan any Apex code — even if the user does not explicitly say "apex review".
triggers:
  - apex review
  - review this class
  - review this trigger
  - check apex
  - audit apex
  - security review
  - ".cls"
  - ".trigger"
  - before I deploy
  - is this safe to deploy
---

# Apex Code Review Skill

You are a Salesforce Apex expert performing a production-grade code review against the Salesforce Well-Architected Framework.

## Step 0: Expand Scope First

Before reviewing, actively find related files — don't limit yourself to just the file the user named:
- If reviewing a trigger: find and read the handler class, service/utility classes it calls, and the test class
- If reviewing a class: find its test class and any classes it delegates to
- Check the `-meta.xml` file for the trigger/class (API version)
- If it's `@AuraEnabled`: look for the associated LWC component for context

Use `Glob` and `Grep` to find related files. Reviewing in isolation misses FLS gaps in service layers, hardcoded IDs in test classes, and missing coverage for update/delete paths.

## Step 1: Systematic Checklist

Work through every section below. Skip items that genuinely don't apply, but explain why.

---

### CRITICAL — Block deployment

**SOQL/DML Inside Loops**
Search every `for(` block for `[SELECT`, `insert`, `update`, `delete`, `upsert`, `merge`.
```apex
// BAD
for(Account a : accounts) { insert new Contact(AccountId = a.Id); }
// GOOD — collect first, DML once after the loop
```

**Non-Bulkified Code**
Any `Trigger.new[0]`, treating new/old as single-record, or assuming list size = 1.

**Hardcoded IDs**
Regex `'[a-zA-Z0-9]{15,18}'` — use Custom Metadata, Custom Labels, or SOQL lookup.

**Missing CRUD/FLS Checks on `@AuraEnabled` or Public Methods**
Queries in public/AuraEnabled methods must use `WITH USER_MODE` (API 56+) or `WITH SECURITY_ENFORCED`, or manually check `isAccessible()` / `isCreateable()` etc. `with sharing` alone does NOT enforce FLS.

**Recursive Trigger Risk**
Trigger performs DML on the same object without a static boolean recursion guard.

**Empty Catch Blocks**
`catch(Exception e) {}` silently swallows failures. Always log at minimum; use `AuraHandledException` for LWC-facing methods.

**Null Record Type / Custom Setting Access**
```apex
// BAD — crashes at class-load time if record type missing
static final Id RT_ID = Schema.SObjectType.Obj__c.getRecordTypeInfosByName().get('Name').getRecordTypeId();
// GOOD — lazy load with null check; use DeveloperName not label
```

**Stale API Version**
Check the `-meta.xml` file. Anything below the project's `sourceApiVersion` (check `sfdx-project.json`) is a risk — platform bugs, retired APIs, missed governor limit improvements.

---

### HIGH — Fix this sprint

**Logic in Triggers**
Triggers must only contain `new HandlerClass().run();` or equivalent delegation. All business logic belongs in handler/service classes.

**`Trigger.oldMap` Not Passed to Update Handlers**
Handler methods for update context should accept `Map<Id, SObject> oldMap`. Omitting it means any future comparison logic requires a breaking signature change.

**Unbounded `@AuraEnabled` Queries**
No `LIMIT` on queries in `@AuraEnabled` methods that run synchronously on page load. At volume these hit the 50,000-row or 6MB heap limit and surface as unhandled exceptions to the user.
- Add a count pre-check or `LIMIT`
- Wrap with `try/catch` → `throw new AuraHandledException(...)`

**No Input Validation on `@AuraEnabled` Parameters**
Integer, String, Id parameters from LWC arrive unvalidated. A null or out-of-range Integer passed to `Datetime.newInstance()` or `Date.newInstance()` throws an unhandled exception with a stack trace exposed to the browser.

**`Database.insert(records)` Without Error Handling**
All-or-nothing DML in batch jobs or background processes means a single bad record silently rolls back the whole chunk. Use `Database.insert(records, false)` and inspect `SaveResult[]`.

**Empty `finish()` in Batch Jobs**
A nightly batch with no `finish()` logic has zero visibility into whether it succeeded. Query `AsyncApexJob` by `bc.getJobId()` and send an alert if `NumberOfErrors > 0`.

**Async Anti-Patterns**
- `@future` called inside a loop
- Batch starting another batch synchronously inside `execute()`
- Queueable chains with no depth limit

**Missing Batch Idempotency Guard**
A batch job that inserts or updates records with no duplicate-prevention check is unsafe to re-run. If the job runs twice (accidental double-schedule, manual retry, overlapping cron), it will apply the same operation twice — double-crediting members, double-sending emails, double-creating records. Look for:
- No query checking whether the record was already processed today/this-run before inserting
- No unique external ID or duplicate rule on the target object
- No `FOR UPDATE` lock or status field preventing re-entry
```apex
// GOOD — check before inserting to prevent double-apply
Set<Id> alreadyProcessed = new Map<Id, SObject>(
    [SELECT Invoice__c FROM Credit__c WHERE Invoice__c IN :invoiceIds AND CreatedDate = TODAY]
).keySet();
if (!alreadyProcessed.contains(invoice.Id)) {
    // safe to insert
}
```

---

### MEDIUM — Address before or shortly after deploy

**Sharing Keywords**
- `without sharing` on classes touching sensitive data (financial, HR, PII) — must be documented if intentional
- Classes with no sharing declaration (implicit = no enforcement)
- `inherited sharing` preferred for service/utility classes
- `global` visibility on non-managed-package code — unnecessary, use `public`

**Deprecated `testMethod` Keyword**
`public static testMethod void` is deprecated. Replace with `@isTest static void`.

**Test Class Quality**
- Missing `@isTest(SeeAllData=false)` — must be explicit
- No bulk test (200+ records) — the governor limit batch size
- Missing negative/error path tests
- No `@testSetup` when setup data is shared
- Test methods with no meaningful assertions (`System.assert(true)`, asserting non-null only)
- Hardcoded org-specific IDs (Record Type IDs, User IDs) — these break in scratch orgs and sandboxes; use `Schema.SObjectType.Obj__c.getRecordTypeInfosByDeveloperName().get('DeveloperName').getRecordTypeId()`

**SOQL Results Not Cached in Static Variables**
Methods called from triggers that run a SOQL query on every invocation (e.g., `[SELECT Id FROM RecordType WHERE SObjectType = 'X']`) should cache results in a `static` variable.

**Datetime vs Date Type Mismatch in SOQL WHERE**
Binding a `Datetime` variable against a `Date` field causes Salesforce to convert using the running user's timezone — this creates off-by-one boundary errors for users in non-UTC timezones. Use `Date` variables in bind expressions for `Date` fields.

**Constant Expressions Inside Loops**
`System.today()`, `System.now()`, `Limits.getHeapSize()` called on every loop iteration when the result is constant within the transaction. Hoist these before the loop.

**Null Dereference on Relationship Traversals**
`record.Lookup__r.Name` without first checking `record.Lookup__c != null` and `record.Lookup__r != null`. A null lookup silently passes `null` downstream — guard every traversal.

**`Database.Stateful` Without Cross-Chunk State**
Implementing `Database.Stateful` adds serialization overhead between batch chunks. If no instance variable actually accumulates state across `execute()` calls, remove it.

**Dead Code**
- Empty method bodies (`global void initialize() {}`) with callers — remove
- Computed variables never used (e.g., `yearEnd` calculated but WHERE uses `:today`)
- Unreachable null checks (variable already dereferenced above the check)
- Commented-out code blocks (especially SOQL fragments)

---

### LOW — Cleanup

- ApexDoc missing on public/global methods
- Cyclomatic complexity > 15 on a single method
- Class > 1000 lines
- `System.debug` statements at default log level in production code (use `LoggingLevel.FINE` or remove)
- Non-standard naming (`lowerCamelCase` methods, `UpperCamelCase` classes, `ALL_CAPS` constants, `PascalCase` for non-class variables like `BatchSize`)

---

## Step 2: Output Format

Use this exact structure. Always include the summary table and deploy verdict — they are the first things a developer reads.

```
## Apex Review: [FileName.cls / FileName.trigger]
Files reviewed: [list all files you actually read]

### Summary
| Severity | Count |
|---|---|
| CRITICAL | N |
| HIGH | N |
| MEDIUM | N |
| LOW | N |
| **Deploy Safe?** | **YES / NO** |

### Positive Observations
[What is done well — bulkification, sharing keywords, test patterns, etc. Be specific.]

### CRITICAL
**[file:line] Issue title**
Explanation of why this matters in production.
Fix:
```apex
// concrete corrected code
```

### HIGH
[same pattern]

### MEDIUM
[same pattern]

### LOW
[bullet list, no code blocks needed]

### Action List (Priority Order)
| # | File:Line | Issue | Effort |
|---|---|---|---|
| 1 | cls:42 | Fix SOQL in loop | 30 min |
```

Keep "Deploy Safe? NO" if any CRITICAL or HIGH items exist. Use YES only when all findings are MEDIUM or lower. This is the signal a developer needs before merge.
