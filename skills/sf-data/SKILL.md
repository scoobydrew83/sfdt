---
name: sf-data
description: SOQL query writing, data export/import, upsert operations, and data management for this Salesforce project. Activates when writing SOQL, managing data, or running data operations with SF CLI.
triggers:
  - soql
  - SELECT
  - data import
  - data export
  - upsert
  - data load
  - query
---

# Salesforce Data Operations Skill

You are a Salesforce SOQL expert and data operations specialist.

## SOQL Best Practices

### Always bulkify — query outside loops
```apex
// BAD
for(Account a : accounts) {
    Contact c = [SELECT Id FROM Contact WHERE AccountId = :a.Id LIMIT 1];
}

// GOOD
Set<Id> accountIds = new Map<Id, Account>(accounts).keySet();
Map<Id, Contact> contactByAccount = new Map<Id, Contact>();
for(Contact c : [SELECT Id, AccountId FROM Contact WHERE AccountId IN :accountIds]) {
    contactByAccount.put(c.AccountId, c);
}
```

### Security enforcement
```apex
// Preferred — user mode enforces CRUD + FLS automatically
List<Account> accts = [SELECT Id, Name FROM Account WITH USER_MODE];

// Alternative — explicit FLS check
if(Schema.sObjectType.Account.isAccessible() &&
   Schema.sObjectType.Account.fields.Name.isAccessible()) {
    List<Account> accts = [SELECT Id, Name FROM Account];
}
```

### Efficient query patterns
```apex
// Use specific field lists — avoid SELECT *
[SELECT Id, Name, Phone, OwnerId FROM Account WHERE IsActive__c = true]

// Indexed fields for performance (Id, Name, ExternalId, CreatedDate, Owner)
[SELECT Id FROM Account WHERE CreatedDate = LAST_N_DAYS:30]

// Use LIMIT when you only need existence check
Boolean exists = ![SELECT Id FROM Account WHERE Name = :name LIMIT 1].isEmpty();

// Aggregate queries
AggregateResult[] grouped = [SELECT OwnerId, COUNT(Id) total FROM Account GROUP BY OwnerId];

// Parent-child subquery
[SELECT Id, Name, (SELECT Id, Name FROM Contacts LIMIT 200) FROM Account WHERE Id IN :ids]
```

### SOQL Date Literals
```
TODAY, YESTERDAY, THIS_WEEK, LAST_WEEK, THIS_MONTH, LAST_MONTH, THIS_QUARTER
LAST_N_DAYS:n, NEXT_N_DAYS:n, LAST_N_WEEKS:n, NEXT_N_WEEKS:n
LAST_N_MONTHS:n, NEXT_N_MONTHS:n, FISCAL_QUARTER, FISCAL_YEAR
```

## CLI Data Operations

### Query from CLI
```bash
# Simple query
sf data query \
  --query "SELECT Id, Name FROM Account LIMIT 10" \
  --target-org <alias>

# Query to CSV
sf data query \
  --query "SELECT Id, Name, CreatedDate FROM Account" \
  --result-format csv \
  --target-org <alias> \
  --output-file data/accounts.csv

# Query with WHERE clause (quote carefully)
sf data query \
  --query "SELECT Id, Name FROM Account WHERE CreatedDate = LAST_N_DAYS:30" \
  --target-org <alias>

# Tooling API query (for metadata)
sf data query \
  --query "SELECT Id, Name, Body FROM ApexClass WHERE Name = 'MyClass'" \
  --use-tooling-api \
  --target-org <alias>
```

### Insert / Update / Upsert records
```bash
# Insert from CSV
sf data import legacy \
  --sobject-type Account \
  --file data/accounts.csv \
  --target-org <alias>

# Upsert using external ID
sf data upsert bulk \
  --sobject-type Account \
  --file data/accounts.csv \
  --external-id External_Id__c \
  --target-org <alias> \
  --wait 10

# Delete records
sf data delete bulk \
  --sobject-type Account \
  --file data/accounts-to-delete.csv \
  --target-org <alias>
```

### Export / Import with relationships (tree format)
```bash
# Export with related records
sf data export tree \
  --query "SELECT Id, Name, (SELECT Id, FirstName, LastName FROM Contacts) FROM Account LIMIT 50" \
  --output-dir data/sample \
  --target-org <alias>

# Import preserving relationships
sf data import tree \
  --plan data/sample/Account-Contacts-plan.json \
  --target-org <alias>
```

### Run anonymous Apex
```bash
# From file
sf apex run \
  --file scripts/apex/fixData.apex \
  --target-org <alias>

# One-liner
echo "update [SELECT Id FROM Account WHERE Name = 'Old' LIMIT 200];" | \
  sf apex run --target-org <alias>
```

## SOQL Optimization Tips

| Scenario | Optimization |
|----------|-------------|
| Large dataset | Use `LIMIT` and pagination with `OFFSET` or cursor |
| Filtering on custom field | Check if field has External ID or Unique flag (auto-indexed) |
| Parent lookup | Use relationship query instead of 2 queries |
| COUNT only | Use `SELECT COUNT() FROM Object` (faster than COUNT(Id)) |
| Avoid % prefix wildcards | `LIKE 'Smith%'` is indexed; `LIKE '%Smith'` is not |

## Governor Limits Reference

| Limit | Per-Transaction Value |
|-------|----------------------|
| SOQL queries | 100 (200 in async) |
| SOQL rows returned | 50,000 |
| DML statements | 150 |
| DML rows | 10,000 |
| Heap size | 6 MB (12 MB async) |
| CPU time | 10,000 ms (60,000 ms async) |
