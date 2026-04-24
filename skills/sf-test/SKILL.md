---
name: sf-test
description: Run Apex tests, analyze code coverage, find untested paths, and generate test classes for this Salesforce project. Activates when discussing tests, coverage, test classes, or @isTest.
triggers:
  - run tests
  - apex test
  - code coverage
  - test class
  - "@isTest"
  - coverage gap
  - write a test
---

# Apex Testing Skill

You are an expert in Salesforce Apex testing strategy and test class authorship.

## Running Tests

### Run all tests in org
```bash
sf apex test run \
  --target-org <alias> \
  --code-coverage \
  --result-format human \
  --wait 20
```

### Run specific test classes
```bash
sf apex test run \
  --class-names "AccountTriggerHandlerTest,ContactServiceTest" \
  --target-org <alias> \
  --code-coverage \
  --result-format human \
  --wait 20
```

### Run specific test methods
```bash
sf apex test run \
  --tests "AccountTriggerHandlerTest.testBulkInsert,AccountTriggerHandlerTest.testNegativeCase" \
  --target-org <alias> \
  --result-format human \
  --wait 20
```

### Get results with JSON (for parsing)
```bash
sf apex test run \
  --target-org <alias> \
  --code-coverage \
  --result-format json \
  --output-dir test-results \
  --wait 20
```

### Get test coverage report
```bash
sf apex get test \
  --target-org <alias> \
  --test-run-id <runId> \
  --code-coverage \
  --result-format human
```

## Test Class Standards for This Project

### Required Structure
```apex
@isTest(SeeAllData=false)
private class MyClassTest {

    @testSetup
    static void setupTestData() {
        // Create ALL shared test data here once
        // Use TestDataFactory if available
        List<Account> accounts = new List<Account>();
        for(Integer i = 0; i < 200; i++) {
            accounts.add(new Account(Name = 'Test Account ' + i));
        }
        insert accounts;
    }

    @isTest
    static void testHappyPath() {
        // Arrange
        List<Account> accounts = [SELECT Id FROM Account LIMIT 200];

        // Act
        Test.startTest();
        MyClass.processAccounts(accounts);
        Test.stopTest();

        // Assert — meaningful, not System.assert(true)
        List<Account> updated = [SELECT Id, Description FROM Account WHERE Id IN :accounts];
        System.assertEquals('Processed', updated[0].Description,
            'Account description should be set to Processed');
    }

    @isTest
    static void testBulkScenario() {
        // Must test 200 records — the governor limit batch size
        List<Account> accounts = [SELECT Id FROM Account]; // 200 from @testSetup
        System.assertEquals(200, accounts.size(), 'Should have 200 test accounts');

        Test.startTest();
        MyClass.processAccounts(accounts);
        Test.stopTest();

        // Assert bulk results
    }

    @isTest
    static void testNegativeCase() {
        // Test null input, empty list, bad data
        Test.startTest();
        MyClass.processAccounts(null);
        MyClass.processAccounts(new List<Account>());
        Test.stopTest();
        // No exception thrown = pass, or assert specific exception:
        // try { ... } catch(MyException e) { System.assert(true); }
    }

    @isTest
    static void testExceptionHandling() {
        // Force an error scenario and verify graceful handling
    }
}
```

## Coverage Analysis Workflow

When asked to analyze coverage:

1. Run tests with `--code-coverage` flag
2. Identify classes below 90% threshold
3. For each low-coverage class, read the class and identify uncovered branches:
   - Null checks
   - Empty collection guards
   - Exception catch blocks
   - Conditional branches (if/else)
   - Negative number handling
4. Generate targeted test methods for each gap

## Common Coverage Gaps to Check

- `if(Trigger.isInsert)` — test insert AND update separately
- `catch(Exception e)` blocks — force the exception condition
- `if(records.isEmpty()) return;` — test with empty list
- Helper/utility methods called only from one path
- `@future` methods (need `Test.startTest()/stopTest()` to execute)
- Batch execute/finish methods

## Anti-Patterns to Reject

```apex
// NEVER do these:
System.assert(true);                     // Meaningless assertion
System.assert(result != null);           // Too weak — verify actual value
insert [SELECT Id FROM Account];         // Don't reinsert queried records
Test.startTest(); /* nothing */ Test.stopTest(); // Empty async block
```

## Test Data Factory Pattern

If no TestDataFactory exists, recommend creating one:
```apex
@isTest
public class TestDataFactory {
    public static List<Account> createAccounts(Integer count) {
        List<Account> accts = new List<Account>();
        for(Integer i = 0; i < count; i++) {
            accts.add(new Account(
                Name = 'Test Account ' + i,
                Phone = '555-000-' + String.valueOf(i).leftPad(4, '0')
            ));
        }
        return accts; // caller does the insert
    }

    public static List<Contact> createContacts(Integer count, Id accountId) {
        List<Contact> contacts = new List<Contact>();
        for(Integer i = 0; i < count; i++) {
            contacts.add(new Contact(
                FirstName = 'Test',
                LastName = 'Contact ' + i,
                AccountId = accountId,
                Email = 'test' + i + '@example.com'
            ));
        }
        return contacts;
    }
}
```

## Coverage Target

This project targets **90%** org-wide code coverage. Flag any class below 75% as CRITICAL.
