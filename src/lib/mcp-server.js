import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { loadConfig } from './config.js';
import { parkIfNeeded, getParkedResult } from './mcp-parking.js';
import { CHECK_IDS as AUDIT_CHECK_IDS } from './audit-runner.js';
import { CHECK_IDS as MONITOR_CHECK_IDS } from './monitor-runner.js';
import { execa } from 'execa';
import os from 'os';
import path from 'path';
import fs from 'fs-extra';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ENTRYPOINT = path.resolve(__dirname, '..', '..', 'bin', 'sfdt.js');

// Tool Use Examples (Anthropic advanced tool use): each in-scope tool — one with
// 2+ inputSchema properties or any enum/array property — carries realistic example
// invocations so agents get the parameter conventions the JSON schema alone can't
// express. Single simple-parameter tools (preflight, drift, rollback, docs,
// coverage, scan, flow_scan, get_parked_result) are intentionally left without
// examples: the schema is self-evident and examples would add tokens for no gain.
export const TOOLS = [
  {
    name: 'sfdt_preflight',
    description: 'Run sfdt pre-deployment validation checks (git clean state, branch naming rules, Apex test runs, coverage threshold checks, etc.). Useful before validation or deployment.',
    inputSchema: {
      type: 'object',
      properties: {
        strict: { type: 'boolean', description: 'Promote warnings to errors and fail the validation run.' }
      }
    }
  },
  {
    name: 'sfdt_drift',
    description: 'Run metadata drift detection between a target Salesforce org and local source directories.',
    inputSchema: {
      type: 'object',
      properties: {
        org: { type: 'string', description: 'Salesforce org alias. Defaults to config defaultOrg.' }
      }
    }
  },
  {
    name: 'sfdt_compare',
    description: 'Compare metadata between two orgs, or between local source and an org. Returns compare results.',
    inputSchema: {
      type: 'object',
      properties: {
        source: { type: 'string', description: 'Source org alias or "local".' },
        target: { type: 'string', description: 'Target org alias.' }
      },
      required: ['source', 'target']
    },
    examples: [
      { description: 'Diff local source against the dev sandbox', input: { source: 'local', target: 'dev' } },
      { description: 'Compare two orgs directly (staging vs production)', input: { source: 'staging', target: 'prod' } }
    ]
  },
  {
    name: 'sfdt_quality',
    description: 'Analyze Apex test quality, generate IsTest boilerplate stubs, or generate a fix-plan for coverage gaps.',
    inputSchema: {
      type: 'object',
      properties: {
        generateStubs: { type: 'boolean', description: 'Generate mock Apex test class boilerplate stubs.' },
        fixPlan: { type: 'boolean', description: 'Create an AI-powered plan to resolve code coverage gaps.' },
        apexGuru: { type: 'boolean', description: 'Run only the ApexGuru org-side analysis check (license/edition-gated; degrades to skipped, never an error).' },
        org: { type: 'string', description: 'Target org alias for the ApexGuru check (defaults to the configured defaultOrg).' }
      }
    },
    examples: [
      { description: 'Generate an AI fix-plan for coverage gaps', input: { fixPlan: true } },
      { description: 'Scaffold missing Apex test-class boilerplate stubs', input: { generateStubs: true } },
      { description: 'Run the ApexGuru org-side analysis against the dev sandbox', input: { apexGuru: true, org: 'dev' } }
    ]
  },
  {
    name: 'sfdt_logs',
    description: 'Retrieve the latest structured or raw execution logs for DevOps actions.',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['preflight', 'drift', 'deploy', 'rollback', 'quality'], description: 'Type of log to retrieve.' }
      },
      required: ['type']
    },
    examples: [
      { description: 'Fetch the latest preflight log', input: { type: 'preflight' } },
      { description: 'Fetch the most recent deploy result', input: { type: 'deploy' } }
    ]
  },
  {
    name: 'sfdt_manifest_from_git',
    description: 'Generate package.xml and destructiveChanges.xml manifests using Git diff analysis.',
    inputSchema: {
      type: 'object',
      properties: {
        base: { type: 'string', description: 'Base git reference (default: main).' },
        head: { type: 'string', description: 'Head git reference (default: HEAD).' },
        package: { type: 'string', description: 'Target subdirectory/package name or "all".' },
        name: { type: 'string', description: 'Semantic release version/label.' }
      }
    },
    examples: [
      { description: 'Manifest for everything changed between main and the working tree', input: { base: 'main', head: 'HEAD', package: 'all' } },
      { description: 'Manifest for one package between two tags, labelled for release', input: { base: 'v0.15.1', head: 'v0.15.2', package: 'core', name: '0.15.2' } }
    ]
  },
  {
    name: 'sfdt_validate',
    description: 'Perform a deployment validation dry-run on Salesforce without committing changes.',
    inputSchema: {
      type: 'object',
      properties: {
        manifest: { type: 'string', description: 'Path to package.xml manifest.' },
        targetOrg: { type: 'string', description: 'Org alias.' },
        testLevel: { type: 'string', enum: ['NoTestRun', 'RunSpecifiedTests', 'RunLocalTests', 'RunAllTestsInOrg', 'RunRelevantTests'] },
        testClasses: { type: 'array', items: { type: 'string' }, description: 'Specific test classes to run.' }
      },
      required: ['targetOrg']
    },
    examples: [
      { description: 'Validate the default manifest against staging with local tests', input: { targetOrg: 'staging', manifest: 'manifest/package.xml', testLevel: 'RunLocalTests' } },
      { description: 'Validate running only two named test classes', input: { targetOrg: 'staging', testLevel: 'RunSpecifiedTests', testClasses: ['AccountServiceTest', 'ContactTriggerTest'] } }
    ]
  },
  {
    name: 'sfdt_deploy',
    description: 'Perform a metadata deployment to a target Salesforce org. Supports a smart delta mode (only git-changed metadata with smart test selection). Potentially destructive.',
    inputSchema: {
      type: 'object',
      properties: {
        manifest: { type: 'string', description: 'Path to package.xml manifest (ignored when smart=true).' },
        targetOrg: { type: 'string', description: 'Org alias.' },
        testLevel: { type: 'string', enum: ['NoTestRun', 'RunSpecifiedTests', 'RunLocalTests', 'RunAllTestsInOrg', 'RunRelevantTests'] },
        testClasses: { type: 'array', items: { type: 'string' }, description: 'Specific test classes to run.' },
        destructiveTiming: { type: 'string', enum: ['pre', 'post', 'none', 'only'] },
        smart: { type: 'boolean', description: 'Smart delta deploy: only metadata changed between deltaBase and deltaHead, with smart test selection.' },
        deltaBase: { type: 'string', description: 'Base git ref for smart delta (default: config or "main").' },
        deltaHead: { type: 'string', description: 'Head git ref for smart delta (default: HEAD).' },
        dryRun: { type: 'boolean', description: 'Validate only (no changes applied). Recommended for smart mode in CI.' },
        confirmExecution: { type: 'boolean', description: 'Must be set to true to acknowledge safety and execute (not required when dryRun=true).' }
      },
      required: ['targetOrg']
    },
    examples: [
      { description: 'Smart delta dry-run of git-changed metadata to staging (safe, no confirm needed)', input: { targetOrg: 'staging', smart: true, dryRun: true, deltaBase: 'main', deltaHead: 'HEAD' } },
      { description: 'Confirmed manifest deploy to production running local tests', input: { targetOrg: 'prod', manifest: 'manifest/package.xml', testLevel: 'RunLocalTests', confirmExecution: true } }
    ]
  },
  {
    name: 'sfdt_quick_deploy',
    description: 'Quick deploy a previously validated metadata validation job using validation job ID.',
    inputSchema: {
      type: 'object',
      properties: {
        validationJobId: { type: 'string', description: 'Salesforce validation job ID (0Af...).' },
        targetOrg: { type: 'string', description: 'Org alias.' },
        confirmExecution: { type: 'boolean', description: 'Must be set to true to acknowledge safety and execute.' }
      },
      required: ['validationJobId', 'targetOrg', 'confirmExecution']
    },
    examples: [
      { description: 'Promote a previously validated job to production', input: { validationJobId: '0Af5g00000AbCdEEAV', targetOrg: 'prod', confirmExecution: true } }
    ]
  },
  {
    name: 'sfdt_rollback',
    description: 'Roll back the last successful deployment using org backup snapshots.',
    inputSchema: {
      type: 'object',
      properties: {
        confirmExecution: { type: 'boolean', description: 'Must be set to true to acknowledge safety and execute.' }
      },
      required: ['confirmExecution']
    }
  },
  {
    name: 'sfdt_audit',
    description: 'Run read-only org health diagnostics (suspicious setup audit trail, license usage, MFA coverage, unused Apex classes, inactive users, deprecated API versions, inactive flows, unused permission sets, connected apps, missing field descriptions, unreferenced Apex, object access lint). Returns a normalised snapshot of check results.',
    inputSchema: {
      type: 'object',
      properties: {
        org: { type: 'string', description: 'Salesforce org alias. Defaults to config defaultOrg.' },
        check: {
          type: 'string',
          // Derived from the audit runner's CHECKS map — a new check is
          // exposed here automatically (drift guarded by command-policy.test.js).
          enum: ['all', ...AUDIT_CHECK_IDS],
          description: 'Run a single named check, or "all" (default).'
        }
      }
    },
    examples: [
      { description: 'Run all read-only org-health checks on production', input: { org: 'prod', check: 'all' } },
      { description: 'Check only MFA coverage', input: { org: 'prod', check: 'mfa' } }
    ]
  },
  {
    name: 'sfdt_monitor',
    description: 'Run org monitoring checks (org limit consumption, recent Apex job failures, security health-check score, org info, recent deployment health, legacy API usage, paused flow interviews) and optionally a full metadata backup. Returns a normalised snapshot of check results.',
    inputSchema: {
      type: 'object',
      properties: {
        org: { type: 'string', description: 'Salesforce org alias. Defaults to config defaultOrg.' },
        check: {
          type: 'string',
          // Derived from the monitor runner's CHECKS map; 'backup' is the
          // separate full-metadata-backup path, not a CHECKS entry.
          enum: ['all', ...MONITOR_CHECK_IDS, 'backup'],
          description: 'Run a single named check, "backup" for a metadata backup, or "all" (default).'
        },
        backup: { type: 'boolean', description: 'When running "all", also perform a metadata backup.' }
      }
    },
    examples: [
      { description: 'Run all monitoring checks plus a metadata backup', input: { org: 'prod', check: 'all', backup: true } },
      { description: 'Check org limit consumption only', input: { check: 'limits' } }
    ]
  },
  {
    name: 'sfdt_retrofit',
    description: 'Retrofit metadata from a source org to a target org: retrieve specified metadata types, commit, then smart-deploy. Validate-only unless execute=true.',
    inputSchema: {
      type: 'object',
      properties: {
        source: { type: 'string', description: 'Org alias to retrieve changes FROM.' },
        target: { type: 'string', description: 'Org alias to deploy changes TO.' },
        metadata: { type: 'string', description: 'Comma-separated metadata types (defaults to a common admin-changed set).' },
        execute: { type: 'boolean', description: 'Perform a real deploy to the target (default: validate-only).' },
        confirmExecution: { type: 'boolean', description: 'Required when execute=true to acknowledge a real deployment.' }
      },
      required: ['source', 'target']
    },
    examples: [
      { description: 'Validate-only retrofit of admin changes from prod into a sandbox', input: { source: 'prod', target: 'dev', metadata: 'Profile,CustomField,ValidationRule' } },
      { description: 'Execute a real retrofit deploy from prod to staging', input: { source: 'prod', target: 'staging', execute: true, confirmExecution: true } }
    ]
  },
  {
    name: 'sfdt_pr_comment',
    description: 'Post the latest audit or monitor snapshot to the current pull request as a markdown comment (via the gh CLI).',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['audit', 'monitor'], description: 'Which snapshot to post (default: monitor).' },
        pr: { type: 'string', description: 'PR number or URL (defaults to the current branch PR).' }
      }
    },
    examples: [
      { description: 'Post the latest monitor snapshot to the current PR', input: { type: 'monitor' } },
      { description: 'Post the audit snapshot to a specific PR number', input: { type: 'audit', pr: '142' } }
    ]
  },
  {
    name: 'sfdt_notify',
    description: 'Send the latest audit or monitor snapshot to configured notification channels (Slack/Teams/Google Chat/email/webhook), applying each channel\'s event filter and severity threshold. Run an audit/monitor first so a snapshot exists.',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['audit', 'monitor'], description: 'Which snapshot to send (default: monitor).' }
      }
    },
    examples: [
      { description: 'Send the latest monitor snapshot to configured channels', input: { type: 'monitor' } },
      { description: 'Send the audit snapshot instead', input: { type: 'audit' } }
    ]
  },
  {
    name: 'sfdt_docs',
    description: 'Generate MkDocs-compatible project documentation (custom objects + fields, Apex classes, Flows) with an optional AI overview and a Mermaid ER diagram of the data model.',
    inputSchema: {
      type: 'object',
      properties: {
        ai: { type: 'boolean', description: 'Enrich the index with an AI-written project overview.' }
      }
    }
  },
  {
    name: 'sfdt_coverage',
    description: 'Report Apex code coverage for a Salesforce org — org-wide percentage plus per-class coverage. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        org: { type: 'string', description: 'Salesforce org alias. Defaults to config defaultOrg.' }
      }
    }
  },
  {
    name: 'sfdt_scan',
    description: 'Fetch the complete metadata inventory of a Salesforce org (all component types and members). Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        org: { type: 'string', description: 'Salesforce org alias. Defaults to config defaultOrg.' }
      }
    }
  },
  {
    name: 'sfdt_dependencies',
    description: 'Show the metadata dependencies of a component — what it references and what references it. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Metadata component name (e.g. an Apex class or field API name).' },
        org: { type: 'string', description: 'Salesforce org alias. Defaults to config defaultOrg.' }
      },
      required: ['name']
    },
    examples: [
      { description: 'Show what references the AccountService Apex class in dev', input: { name: 'AccountService', org: 'dev' } },
      { description: 'Dependencies of a custom field (defaults to config org)', input: { name: 'Account.Region__c' } }
    ]
  },
  {
    name: 'sfdt_field_impact',
    description: 'Show what WRITES a Salesforce field — flows, workflow field updates and Apex — with each finding marked confirmed (the metadata states the write) or inferred (a lead only). The result carries scope notes saying what was NOT scanned; an empty row list means no writer was found by the bounded sources scanned, never that none exists. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        field: { type: 'string', description: 'Qualified field, e.g. "Account.Region__c".' },
        org: { type: 'string', description: 'Salesforce org alias. Defaults to config defaultOrg.' },
        links: { type: 'boolean', description: 'Resolve the org instance URL so rows carry Setup deep links (one extra call).' }
      },
      required: ['field']
    },
    examples: [
      { description: 'What writes Account.Region__c in dev', input: { field: 'Account.Region__c', org: 'dev' } },
      { description: 'Check a standard field before changing an integration', input: { field: 'Opportunity.StageName' } }
    ]
  },
  {
    name: 'sfdt_flow_scan',
    description: 'Analyze a Salesforce org\'s Flows for quality issues and anti-patterns (via @sfdt/flow-core) — lists FlowDefinitions and fetches each active version from the org, then runs the health checks. Returns the flow-scan report. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        org: { type: 'string', description: 'Salesforce org alias. Defaults to config defaultOrg.' }
      }
    }
  },
  {
    name: 'sfdt_release',
    description: 'Build a release: generate the release manifest (package.xml) and release notes for a package. Writes release artifacts to the repo. Mutating — requires confirmExecution.',
    inputSchema: {
      type: 'object',
      properties: {
        version: { type: 'string', description: 'Release version/label (semver, free-form, or "today").' },
        package: { type: 'string', description: 'Package directory: a short name or "all" (default).' },
        name: { type: 'string', description: 'Release label override.' },
        confirmExecution: { type: 'boolean', description: 'Must be true to acknowledge writing release artifacts.' }
      },
      required: ['confirmExecution']
    },
    examples: [
      { description: 'Build a release for all packages with a semver label', input: { version: '0.15.2', package: 'all', confirmExecution: true } },
      { description: "Build today's release for a single package", input: { version: 'today', package: 'core', confirmExecution: true } }
    ]
  },
  {
    name: 'sfdt_scratch_create',
    description: 'Create a Salesforce scratch org. Mutating (consumes a DevHub scratch-org allocation) — requires confirmExecution.',
    inputSchema: {
      type: 'object',
      properties: {
        alias: { type: 'string', description: 'Alias for the new scratch org.' },
        days: { type: 'number', description: 'Duration in days (1-30).' },
        confirmExecution: { type: 'boolean', description: 'Must be true to create the scratch org.' }
      },
      required: ['confirmExecution']
    },
    examples: [
      { description: 'Create a 7-day scratch org aliased dev1', input: { alias: 'dev1', days: 7, confirmExecution: true } }
    ]
  },
  {
    name: 'sfdt_scratch_delete',
    description: 'Delete a scratch org by alias or username. Destructive — requires confirmExecution.',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Scratch org alias or username to delete.' },
        confirmExecution: { type: 'boolean', description: 'Must be true to delete the scratch org.' }
      },
      required: ['target', 'confirmExecution']
    },
    examples: [
      { description: 'Delete the dev1 scratch org', input: { target: 'dev1', confirmExecution: true } }
    ]
  },
  {
    name: 'sfdt_scratch_pool',
    description: 'Inspect or top up the scratch-org pool. action="status" is read-only; action="fill" creates orgs to reach the target size and requires confirmExecution.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['status', 'fill'], description: 'status (read-only) or fill (mutating).' },
        size: { type: 'number', description: 'Desired pool size for fill (overrides config).' },
        confirmExecution: { type: 'boolean', description: 'Required when action="fill".' }
      },
      required: ['action']
    },
    examples: [
      { description: 'Check current scratch-org pool status (read-only)', input: { action: 'status' } },
      { description: 'Fill the pool up to five orgs', input: { action: 'fill', size: 5, confirmExecution: true } }
    ]
  },
  {
    name: 'sfdt_record_get',
    description: 'Read one Salesforce record and report which fields are editable, and why the rest are not. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '15 or 18 character record Id.' },
        sobject: { type: 'string', description: 'Object API name. Optional — resolved from the Id key prefix when omitted.' },
        org: { type: 'string', description: 'Org alias. Defaults to config defaultOrg.' }
      },
      required: ['id']
    },
    examples: [
      { description: 'Read an Account and see what is writable', input: { id: '001800000000001AAA' } }
    ]
  },
  {
    name: 'sfdt_record_edit',
    description: 'Update fields on one record. Fields the org reports as non-editable are refused locally, with the reason, before anything is sent. Mutating — requires confirmExecution.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '15 or 18 character record Id.' },
        fields: { type: 'object', description: 'Field API name to value, e.g. { "Name": "Acme" }.', additionalProperties: true },
        sobject: { type: 'string', description: 'Object API name. Optional.' },
        org: { type: 'string', description: 'Org alias. Defaults to config defaultOrg.' },
        dryRun: { type: 'boolean', description: 'Return the exact request body without sending it.' },
        confirmExecution: { type: 'boolean', description: 'Must be true to write to the org.' }
      },
      required: ['id', 'fields', 'confirmExecution']
    },
    examples: [
      { description: 'Rename an Account', input: { id: '001800000000001AAA', fields: { Name: 'Acme Corp' }, confirmExecution: true } }
    ]
  },
  {
    name: 'sfdt_record_clone',
    description: 'Create a copy of a record from its createable fields, with optional overrides. Mutating — requires confirmExecution.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Record Id to copy.' },
        fields: { type: 'object', description: 'Overrides applied to the copy.', additionalProperties: true },
        sobject: { type: 'string', description: 'Object API name. Optional.' },
        org: { type: 'string', description: 'Org alias. Defaults to config defaultOrg.' },
        dryRun: { type: 'boolean', description: 'Return the exact request body without sending it.' },
        confirmExecution: { type: 'boolean', description: 'Must be true to create a record.' }
      },
      required: ['id', 'confirmExecution']
    },
    examples: [
      { description: 'Clone an Opportunity under a new name', input: { id: '006800000000001AAA', fields: { Name: 'Renewal FY27' }, confirmExecution: true } }
    ]
  },
  {
    name: 'sfdt_data_export',
    description: 'Export a configured data set from the org to local files. Reads from the org and writes local data files (read-only with respect to the org).',
    inputSchema: {
      type: 'object',
      properties: {
        set: { type: 'string', description: 'Data set name (from config).' },
        org: { type: 'string', description: 'Org alias. Defaults to config defaultOrg.' }
      },
      required: ['set']
    },
    examples: [
      { description: 'Export the accounts data set from the dev org', input: { set: 'accounts', org: 'dev' } }
    ]
  },
  {
    name: 'sfdt_data_import',
    description: 'Import a configured data set into the org. Mutating (writes records) — requires confirmExecution.',
    inputSchema: {
      type: 'object',
      properties: {
        set: { type: 'string', description: 'Data set name (from config).' },
        org: { type: 'string', description: 'Org alias. Defaults to config defaultOrg.' },
        confirmExecution: { type: 'boolean', description: 'Must be true to write records to the org.' }
      },
      required: ['set', 'confirmExecution']
    },
    examples: [
      { description: 'Import the accounts data set into the dev org', input: { set: 'accounts', org: 'dev', confirmExecution: true } }
    ]
  },
  {
    name: 'sfdt_data_load',
    description: 'Load a bulk data set (bulk.json) into the org over Bulk API v2 — insert or upsert by external id. Mutating (writes records) — requires confirmExecution.',
    inputSchema: {
      type: 'object',
      properties: {
        set: { type: 'string', description: 'Data set name — must be a bulk data set (bulk.json), not a tree one.' },
        org: { type: 'string', description: 'Org alias. Defaults to config defaultOrg.' },
        wait: { type: 'integer', minimum: 0, description: 'Minutes to wait for each job. Defaults to config data.bulk.waitMinutes (10).' },
        async: { type: 'boolean', description: 'Queue each job and return immediately instead of waiting.' },
        confirmExecution: { type: 'boolean', description: 'Must be true to write records to the org.' }
      },
      required: ['set', 'confirmExecution']
    },
    examples: [
      { description: 'Load the seed data set into the dev org', input: { set: 'seed', org: 'dev', confirmExecution: true } }
    ]
  },
  {
    name: 'sfdt_data_delete',
    description: 'Bulk-delete a configured data set in the org. Destructive — requires confirmExecution.',
    inputSchema: {
      type: 'object',
      properties: {
        set: { type: 'string', description: 'Data set name (from config).' },
        org: { type: 'string', description: 'Org alias. Defaults to config defaultOrg.' },
        confirmExecution: { type: 'boolean', description: 'Must be true to delete records in the org.' }
      },
      required: ['set', 'confirmExecution']
    },
    examples: [
      { description: 'Bulk-delete the accounts data set in the dev1 scratch org', input: { set: 'accounts', org: 'dev1', confirmExecution: true } }
    ]
  },
  {
    name: 'sfdt_apex_logs',
    description: 'List recent Apex debug logs, or retrieve one log body by Id. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        org: { type: 'string', description: 'Salesforce org alias. Defaults to config defaultOrg.' },
        logId: { type: 'string', description: 'Retrieve this debug log\'s body instead of listing.' },
        limit: { type: 'number', description: 'Maximum logs to list (default 20).' }
      }
    },
    examples: [
      { description: 'List the 10 most recent debug logs in the dev org', input: { org: 'dev', limit: 10 } },
      { description: 'Fetch one debug log body by Id', input: { logId: '07L5g00000AbCdEEAV' } }
    ]
  },
  {
    name: 'sfdt_apex_trace',
    description: 'Manage Apex debug trace flags. action="list" is read-only; action="start"/"stop" write TraceFlag records in the org and require confirmExecution.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['start', 'stop', 'list'], description: 'start/stop trace flags (mutating) or list them (read-only).' },
        org: { type: 'string', description: 'Salesforce org alias. Defaults to config defaultOrg.' },
        user: { type: 'string', description: 'Username to trace / stop tracing (defaults to the authenticated user).' },
        duration: { type: 'number', description: 'start only: trace window in minutes (max 1440).' },
        debugLevel: { type: 'string', description: 'start only: DebugLevel DeveloperName (default SFDT_Trace, created if missing).' },
        all: { type: 'boolean', description: 'stop only: delete every USER_DEBUG trace flag in the org.' },
        confirmExecution: { type: 'boolean', description: 'Required when action="start" or "stop" (they write to the org).' }
      },
      required: ['action']
    },
    examples: [
      { description: 'List trace flags (read-only)', input: { action: 'list', org: 'dev' } },
      { description: 'Start a 30-minute trace for a user', input: { action: 'start', org: 'dev', user: 'admin@example.com', duration: 30, confirmExecution: true } },
      { description: 'Stop the authenticated user\'s trace flags', input: { action: 'stop', org: 'dev', confirmExecution: true } }
    ]
  },
  {
    name: 'sfdt_apex_run',
    description: 'Execute Anonymous Apex in the org from a file or inline code. Mutating (the code runs with the authenticated user\'s permissions) — requires confirmExecution.',
    inputSchema: {
      type: 'object',
      properties: {
        org: { type: 'string', description: 'Salesforce org alias. Defaults to config defaultOrg.' },
        file: { type: 'string', description: 'Path to an Apex code file (relative to the project root).' },
        apexCode: { type: 'string', description: 'Inline Apex code (used when no file is given).' },
        confirmExecution: { type: 'boolean', description: 'Must be true to execute code in the org.' }
      },
      required: ['confirmExecution']
    },
    examples: [
      { description: 'Run an Apex script file against the dev org', input: { org: 'dev', file: 'scripts/apex/reset-flags.apex', confirmExecution: true } },
      { description: 'Run a one-liner inline', input: { apexCode: 'System.debug(UserInfo.getUserName());', confirmExecution: true } }
    ]
  },
  {
    name: 'sfdt_test',
    description: 'Run Apex tests via the enhanced test runner. Optionally limit to specific test classes. Consumes org test resources; not metadata-mutating.',
    inputSchema: {
      type: 'object',
      properties: {
        classNames: { type: 'array', items: { type: 'string' }, description: 'Only run these Apex test classes (defaults to the configured set).' }
      }
    },
    examples: [
      { description: 'Run two specific Apex test classes', input: { classNames: ['AccountServiceTest', 'ContactTriggerTest'] } }
    ]
  },
  {
    name: 'sfdt_history',
    description: 'Show recent sfdt run history (audit, monitor, quality, test, deploy, agent-test, …) from the local run index — trend org-health, test, and deploy outcomes over time. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', description: 'Filter to one run type (e.g. audit | monitor | quality | test-run | deploy | agent-test).' },
        limit: { type: 'number', description: 'Maximum rows to return (default 30).' }
      }
    },
    examples: [
      { description: 'Show the last 10 audit runs', input: { type: 'audit', limit: 10 } },
      { description: 'Show recent deploy history', input: { type: 'deploy', limit: 30 } }
    ]
  },
  {
    name: 'sfdt_api_versions',
    description: 'Audit Salesforce API versions across local source and the org — per-type version distributions (Apex classes/triggers, Flows, LWC, Aura), sourceApiVersion, the org\'s max API version, and below-floor/behind-ceiling outliers. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        org: { type: 'string', description: 'Target org alias (default: config defaultOrg).' },
        localOnly: { type: 'boolean', description: 'Skip the org side even when an org is configured.' }
      }
    },
    examples: [
      { description: 'Full local + org API-version report', input: { org: 'dev' } },
      { description: 'Offline scan of local source only', input: { localOnly: true } }
    ]
  },
  {
    name: 'sfdt_soql_search',
    description: 'Find sObjects in the org by name substring (schema search across the org inventory). Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        term: { type: 'string', description: 'Case-insensitive substring matched against sObject API names (omit for all).' },
        category: { type: 'string', enum: ['all', 'custom', 'standard'], description: 'Which sObjects to scan (default all).' },
        limit: { type: 'number', description: 'Maximum matches to return (default 100).' },
        org: { type: 'string', description: 'Salesforce org alias. Defaults to config defaultOrg.' }
      }
    },
    examples: [
      { description: 'Find custom objects with "invoice" in the name', input: { term: 'invoice', category: 'custom' } },
      { description: 'List the first 20 standard objects in the dev org', input: { category: 'standard', limit: 20, org: 'dev' } }
    ]
  },
  {
    name: 'sfdt_soql_describe',
    description: 'Describe an sObject — fields (type, picklists, references), key prefix, and child relationships. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        sobject: { type: 'string', description: 'sObject API name (e.g. Account, Invoice__c).' },
        filter: { type: 'string', description: 'Only return fields whose API name or label contains this substring.' },
        tooling: { type: 'boolean', description: 'Describe a Tooling API object.' },
        org: { type: 'string', description: 'Salesforce org alias. Defaults to config defaultOrg.' }
      },
      required: ['sobject']
    },
    examples: [
      { description: 'Describe Account, only fields matching "phone"', input: { sobject: 'Account', filter: 'phone' } },
      { description: 'Describe the ApexClass Tooling object in dev', input: { sobject: 'ApexClass', tooling: true, org: 'dev' } }
    ]
  },
  {
    name: 'sfdt_soql_validate',
    description: 'Validate a SOQL query without executing it — local static checks plus an org LIMIT 0 round-trip (degrades to local-only when the org is unreachable). Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The SOQL query to validate.' },
        org: { type: 'string', description: 'Salesforce org alias. Defaults to config defaultOrg.' }
      },
      required: ['query']
    },
    examples: [
      { description: 'Validate a query against the default org', input: { query: 'SELECT Id, Name FROM Account WHERE CreatedDate = LAST_N_DAYS:7' } }
    ]
  },
  {
    name: 'sfdt_soql_plan',
    description: 'Fetch the org query plans for a SOQL query (REST explain endpoint) — leading operation, relative cost, cardinality, and notes. The query is never executed. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The SOQL query to explain.' },
        org: { type: 'string', description: 'Salesforce org alias. Defaults to config defaultOrg.' }
      },
      required: ['query']
    },
    examples: [
      { description: 'Explain a query to check it is selective', input: { query: 'SELECT Id FROM Case WHERE Status = \'Open\'' } }
    ]
  },
  {
    name: 'sfdt_soql_query',
    description: 'Execute a SOQL SELECT with a row bound enforced (config soql.defaultLimit/maxLimit — never unbounded). Returns records plus truncation metadata. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The SOQL SELECT to run.' },
        limit: { type: 'number', description: 'Row bound (default config soql.defaultLimit, clamped to soql.maxLimit).' },
        tooling: { type: 'boolean', description: 'Query the Tooling API.' },
        org: { type: 'string', description: 'Salesforce org alias. Defaults to config defaultOrg.' }
      },
      required: ['query']
    },
    examples: [
      { description: 'Fetch 10 recent accounts', input: { query: 'SELECT Id, Name FROM Account ORDER BY CreatedDate DESC', limit: 10 } },
      { description: 'Count Apex classes via the Tooling API', input: { query: 'SELECT COUNT() FROM ApexClass', tooling: true, org: 'dev' } }
    ]
  },
  {
    name: 'sfdt_get_parked_result',
    description: 'Retrieve the full payload of a previously parked tool result.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'Reference string starting with parked://' }
      },
      required: ['ref']
    }
  }
];

// SEP-2549 cache metadata for tools/list: the catalog is a static module
// constant that cannot change within a process, so clients may cache it
// long-lived and share it across users.
const TOOLS_LIST_CACHE = { ttlMs: 86_400_000, cacheScope: 'global' };

// W3C Trace Context traceparent: version-traceid-parentid-flags, all lowercase hex.
const TRACEPARENT_RE = /^[0-9a-f]{2}-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/;
const TRACESTATE_MAX_LENGTH = 512;

/**
 * Extracts W3C Trace Context from a request's `_meta`, validating shape so
 * attacker-controlled values can't inject into audit logs. Invalid values are
 * treated as absent.
 *
 * @param {object|undefined} meta - `request.params._meta`
 * @returns {{ traceparent: string, tracestate?: string } | null}
 */
function extractTraceContext(meta) {
  const traceparent = meta?.traceparent;
  if (typeof traceparent !== 'string' || !TRACEPARENT_RE.test(traceparent)) {
    return null;
  }
  const tracestate = meta.tracestate;
  if (
    typeof tracestate === 'string' &&
    tracestate.length > 0 &&
    tracestate.length <= TRACESTATE_MAX_LENGTH &&
    !/[\r\n]/.test(tracestate)
  ) {
    return { traceparent, tracestate };
  }
  return { traceparent };
}

export class SfdtMcpServer {
  #server;
  #config;

  async start() {
    try {
      this.#config = await loadConfig();
    } catch (err) {
      console.error(`MCP Server start failed: Config not found. ${err.message}`);
      process.exit(1);
    }

    this.#server = new Server(
      { name: 'sfdt-devops-server', version: '1.0.0' },
      { capabilities: { tools: {} } }
    );

    this.#setupHandlers();

    const transport = new StdioServerTransport();
    await this.#server.connect(transport);
    console.error('sfdt MCP Stdio Server running...');
  }

  #setupHandlers() {
    this.#server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: TOOLS,
      ttlMs: TOOLS_LIST_CACHE.ttlMs,
      cacheScope: TOOLS_LIST_CACHE.cacheScope,
    }));

    this.#server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      const trace = extractTraceContext(request.params._meta);
      const traceSuffix = trace ? ` traceparent=${trace.traceparent}` : '';

      // Log arg keys and size only — values can carry org aliases, file
      // paths, and job IDs that must not land in audit logs. Key names are
      // attacker-controlled, so neutralize characters (comma, brackets, CR/LF)
      // that could forge the bracketed list or inject extra log lines.
      const argKeys = Object.keys(args ?? {}).map((k) => k.replace(/[^\w.-]/g, '_'));
      const argBytes = Buffer.byteLength(JSON.stringify(args ?? {}), 'utf8');
      console.error(`MCP Call: ${name} argKeys=[${argKeys.join(',')}] argBytes=${argBytes}${traceSuffix}`);

      try {
        const result = await this.#executeTool(name, args ?? {});
        // Automatically check if results exceed context budgets and park them
        const processed = await parkIfNeeded(result, this.#config);

        return {
          ...(trace && { _meta: trace }),
          content: [
            {
              type: 'text',
              text: typeof processed === 'string' ? processed : JSON.stringify(processed, null, 2),
            },
          ],
        };
      } catch (err) {
        console.error(`Tool execution failed (${name})${traceSuffix}:`, err.stack || err.message);
        return {
          ...(trace && { _meta: trace }),
          isError: true,
          content: [
            {
              type: 'text',
              text: `Error executing tool "${name}": ${err.message}`,
            },
          ],
        };
      }
    });
  }

  async #executeTool(name, args) {
    const projectRoot = this.#config._projectRoot;
    const logDir = this.#config.logDir ?? path.join(projectRoot, 'logs');

    // Handle standard tool calls
    switch (name) {
      case 'sfdt_preflight': {
        const cmdArgs = ['preflight'];
        if (args.strict) cmdArgs.push('--strict');

        const { exitCode, stdout, stderr } = await this.#runCliCommand(cmdArgs);
        return { exitCode, stdout, stderr };
      }

      case 'sfdt_drift': {
        const cmdArgs = ['drift', '--json'];
        if (args.org) cmdArgs.push('--org', args.org);

        const { stdout } = await this.#runCliCommand(cmdArgs);
        return this.#parseCliJson(stdout);
      }

      case 'sfdt_coverage': {
        const cmdArgs = ['coverage', '--json'];
        if (args.org) cmdArgs.push('--org', args.org);
        const { stdout } = await this.#runCliCommand(cmdArgs);
        return this.#parseCliJson(stdout);
      }

      case 'sfdt_scan': {
        const cmdArgs = ['scan', '--json'];
        if (args.org) cmdArgs.push('--org', args.org);
        const { stdout } = await this.#runCliCommand(cmdArgs);
        return this.#parseCliJson(stdout);
      }

      case 'sfdt_field_impact': {
        const cmdArgs = ['field', 'impact', args.field, '--json'];
        if (args.org) cmdArgs.push('--org', args.org);
        if (args.links) cmdArgs.push('--links');
        const { stdout } = await this.#runCliCommand(cmdArgs);
        return this.#parseCliJson(stdout);
      }
      case 'sfdt_dependencies': {
        const cmdArgs = ['dependencies', args.name, '--json'];
        if (args.org) cmdArgs.push('--org', args.org);
        const { stdout } = await this.#runCliCommand(cmdArgs);
        return this.#parseCliJson(stdout);
      }

      case 'sfdt_flow_scan': {
        const cmdArgs = ['flow', 'scan', '--json'];
        if (args.org) cmdArgs.push('--org', args.org);
        const { stdout } = await this.#runCliCommand(cmdArgs);
        return this.#parseCliJson(stdout);
      }

      case 'sfdt_release': {
        if (!args.confirmExecution) {
          throw new Error('Building a release writes release artifacts to the repo. Pass confirmExecution: true to proceed.');
        }
        const cliArgs = ['release'];
        if (args.version) cliArgs.push(String(args.version));
        if (args.package) cliArgs.push('--package', args.package);
        if (args.name) cliArgs.push('--name', args.name);
        const { exitCode, stdout, stderr } = await this.#runCliCommand(cliArgs);
        return { exitCode, stdout, stderr };
      }

      case 'sfdt_scratch_create': {
        if (!args.confirmExecution) {
          throw new Error('Creating a scratch org consumes a DevHub allocation. Pass confirmExecution: true to proceed.');
        }
        const cliArgs = ['scratch', 'create', '--json'];
        if (args.alias) cliArgs.push('--alias', args.alias);
        if (args.days != null) cliArgs.push('--days', String(args.days));
        const { stdout } = await this.#runCliCommand(cliArgs);
        return this.#parseCliJson(stdout);
      }

      case 'sfdt_scratch_delete': {
        if (!args.confirmExecution) {
          throw new Error('Deleting a scratch org is destructive. Pass confirmExecution: true to proceed.');
        }
        const cliArgs = ['scratch', 'delete', args.target, '--yes', '--json'];
        const { stdout } = await this.#runCliCommand(cliArgs);
        return this.#parseCliJson(stdout);
      }

      case 'sfdt_scratch_pool': {
        const action = args.action === 'fill' ? 'fill' : 'status';
        if (action === 'fill' && !args.confirmExecution) {
          throw new Error('Filling the scratch pool creates scratch orgs. Pass confirmExecution: true to proceed.');
        }
        const cliArgs = ['scratch', 'pool', action, '--json'];
        if (action === 'fill' && args.size != null) cliArgs.push('--size', String(args.size));
        const { stdout } = await this.#runCliCommand(cliArgs);
        return this.#parseCliJson(stdout);
      }

      case 'sfdt_record_get': {
        const cliArgs = ['record', 'get', args.id, '--json'];
        if (args.sobject) cliArgs.push('--sobject', args.sobject);
        if (args.org) cliArgs.push('--org', args.org);
        const { stdout } = await this.#runCliCommand(cliArgs);
        return this.#parseCliJson(stdout);
      }

      case 'sfdt_record_edit': {
        if (!args.confirmExecution) {
          throw new Error('Editing a record writes to the org. Pass confirmExecution: true to proceed.');
        }
        const cliArgs = ['record', 'edit', args.id, '--json'];
        for (const [field, value] of Object.entries(args.fields ?? {})) {
          cliArgs.push('--set', `${field}=${value}`);
        }
        if (args.sobject) cliArgs.push('--sobject', args.sobject);
        if (args.org) cliArgs.push('--org', args.org);
        if (args.dryRun) cliArgs.push('--dry-run');
        const { stdout } = await this.#runCliCommand(cliArgs);
        return this.#parseCliJson(stdout);
      }

      case 'sfdt_record_clone': {
        if (!args.confirmExecution) {
          throw new Error('Cloning a record creates one in the org. Pass confirmExecution: true to proceed.');
        }
        const cliArgs = ['record', 'clone', args.id, '--json'];
        for (const [field, value] of Object.entries(args.fields ?? {})) {
          cliArgs.push('--set', `${field}=${value}`);
        }
        if (args.sobject) cliArgs.push('--sobject', args.sobject);
        if (args.org) cliArgs.push('--org', args.org);
        if (args.dryRun) cliArgs.push('--dry-run');
        const { stdout } = await this.#runCliCommand(cliArgs);
        return this.#parseCliJson(stdout);
      }

      case 'sfdt_data_export': {
        const cliArgs = ['data', 'export', args.set, '--json'];
        if (args.org) cliArgs.push('--org', args.org);
        const { stdout } = await this.#runCliCommand(cliArgs);
        return this.#parseCliJson(stdout);
      }

      case 'sfdt_data_import': {
        if (!args.confirmExecution) {
          throw new Error('Importing a data set writes records to the org. Pass confirmExecution: true to proceed.');
        }
        const cliArgs = ['data', 'import', args.set, '--json'];
        if (args.org) cliArgs.push('--org', args.org);
        const { stdout } = await this.#runCliCommand(cliArgs);
        return this.#parseCliJson(stdout);
      }

      case 'sfdt_data_load': {
        if (!args.confirmExecution) {
          throw new Error('Loading a data set writes records to the org. Pass confirmExecution: true to proceed.');
        }
        const cliArgs = ['data', 'load', args.set, '--json'];
        if (args.org) cliArgs.push('--org', args.org);
        if (args.wait != null) cliArgs.push('--wait', String(args.wait));
        if (args.async) cliArgs.push('--async');
        const { stdout } = await this.#runCliCommand(cliArgs);
        return this.#parseCliJson(stdout);
      }

      case 'sfdt_data_delete': {
        if (!args.confirmExecution) {
          throw new Error('Deleting a data set is destructive. Pass confirmExecution: true to proceed.');
        }
        const cliArgs = ['data', 'delete', args.set, '--yes', '--json'];
        if (args.org) cliArgs.push('--org', args.org);
        const { stdout } = await this.#runCliCommand(cliArgs);
        return this.#parseCliJson(stdout);
      }

      case 'sfdt_apex_logs': {
        const cliArgs = args.logId
          ? ['apex', 'logs', 'get', args.logId, '--json']
          : ['apex', 'logs', 'list', '--json'];
        if (!args.logId && args.limit != null) cliArgs.push('--limit', String(args.limit));
        if (args.org) cliArgs.push('--org', args.org);
        const { stdout } = await this.#runCliCommand(cliArgs);
        return this.#parseCliJson(stdout);
      }

      case 'sfdt_apex_trace': {
        const action = ['start', 'stop', 'list'].includes(args.action) ? args.action : 'list';
        if (action !== 'list' && !args.confirmExecution) {
          throw new Error('Starting or stopping a trace flag writes to the org. Pass confirmExecution: true to proceed.');
        }
        const cliArgs = ['apex', 'trace', action, '--json'];
        if (args.org) cliArgs.push('--org', args.org);
        if (action !== 'list' && args.user) cliArgs.push('--user', args.user);
        if (action === 'start' && args.duration != null) cliArgs.push('--duration', String(args.duration));
        if (action === 'start' && args.debugLevel) cliArgs.push('--level', args.debugLevel);
        if (action === 'stop' && args.all) cliArgs.push('--all');
        const { stdout } = await this.#runCliCommand(cliArgs);
        return this.#parseCliJson(stdout);
      }

      case 'sfdt_apex_run': {
        if (!args.confirmExecution) {
          throw new Error('Anonymous Apex executes code in the org. Pass confirmExecution: true to proceed.');
        }
        if (!args.file && !args.apexCode) {
          throw new Error('Provide "file" (a path in the project) or "apexCode" (inline Apex).');
        }
        let apexFile = args.file ? path.resolve(projectRoot, args.file) : null;
        let tmpDir = null;
        if (!apexFile) {
          tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sfdt-mcp-apex-'));
          apexFile = path.join(tmpDir, 'anonymous.apex');
          await fs.writeFile(apexFile, args.apexCode);
        }
        try {
          const cliArgs = ['apex', 'run', '--file', apexFile, '--json'];
          if (args.org) cliArgs.push('--org', args.org);
          const { stdout } = await this.#runCliCommand(cliArgs);
          return this.#parseCliJson(stdout);
        } finally {
          if (tmpDir) await fs.remove(tmpDir).catch(() => {});
        }
      }

      case 'sfdt_test': {
        const cliArgs = ['test'];
        if (Array.isArray(args.classNames) && args.classNames.length > 0) {
          cliArgs.push('--class-names', args.classNames.join(','));
        }
        const { exitCode, stdout, stderr } = await this.#runCliCommand(cliArgs);
        return { exitCode, stdout, stderr };
      }

      case 'sfdt_history': {
        const cmdArgs = ['history', '--json'];
        if (args.type) cmdArgs.push('--type', args.type);
        if (args.limit != null) cmdArgs.push('--limit', String(args.limit));
        const { stdout } = await this.#runCliCommand(cmdArgs);
        return this.#parseCliJson(stdout);
      }

      case 'sfdt_soql_search': {
        const cmdArgs = ['soql', 'search'];
        if (args.term) cmdArgs.push(args.term);
        cmdArgs.push('--json');
        if (args.category) cmdArgs.push('--category', args.category);
        if (args.limit != null) cmdArgs.push('--limit', String(args.limit));
        if (args.org) cmdArgs.push('--org', args.org);
        const { stdout } = await this.#runCliCommand(cmdArgs);
        return this.#parseCliJson(stdout);
      }

      case 'sfdt_soql_describe': {
        const cmdArgs = ['soql', 'describe', args.sobject, '--json'];
        if (args.filter) cmdArgs.push('--filter', args.filter);
        if (args.tooling) cmdArgs.push('--tooling');
        if (args.org) cmdArgs.push('--org', args.org);
        const { stdout } = await this.#runCliCommand(cmdArgs);
        return this.#parseCliJson(stdout);
      }

      case 'sfdt_soql_validate': {
        const cmdArgs = ['soql', 'validate', args.query, '--json'];
        if (args.org) cmdArgs.push('--org', args.org);
        const { stdout } = await this.#runCliCommand(cmdArgs);
        return this.#parseCliJson(stdout);
      }

      case 'sfdt_soql_plan': {
        const cmdArgs = ['soql', 'plan', args.query, '--json'];
        if (args.org) cmdArgs.push('--org', args.org);
        const { stdout } = await this.#runCliCommand(cmdArgs);
        return this.#parseCliJson(stdout);
      }

      case 'sfdt_soql_query': {
        const cmdArgs = ['soql', 'query', args.query, '--json'];
        if (args.limit != null) cmdArgs.push('--limit', String(args.limit));
        if (args.tooling) cmdArgs.push('--tooling');
        if (args.org) cmdArgs.push('--org', args.org);
        const { stdout } = await this.#runCliCommand(cmdArgs);
        return this.#parseCliJson(stdout);
      }

      case 'sfdt_api_versions': {
        const cmdArgs = ['versions', '--json'];
        if (args.org) cmdArgs.push('--org', args.org);
        if (args.localOnly) cmdArgs.push('--local-only');
        const { stdout } = await this.#runCliCommand(cmdArgs);
        return this.#parseCliJson(stdout);
      }

      case 'sfdt_compare': {
        const cmdArgs = ['compare', '--source', args.source, '--target', args.target];
        const { exitCode, stdout, stderr } = await this.#runCliCommand(cmdArgs);

        const latestPath = path.join(logDir, 'compare-latest.json');
        if (exitCode === 0 && await fs.pathExists(latestPath)) {
          return await fs.readJson(latestPath);
        }
        return { exitCode, stdout, stderr };
      }

      case 'sfdt_quality': {
        const cmdArgs = ['quality'];
        if (args.generateStubs) cmdArgs.push('--generate-stubs');
        if (args.fixPlan) cmdArgs.push('--fix-plan');
        if (args.apexGuru) cmdArgs.push('--apexguru');
        if (args.org) cmdArgs.push('--org', args.org);

        const { exitCode, stdout, stderr } = await this.#runCliCommand(cmdArgs);
        const latestPath = path.join(logDir, args.apexGuru ? 'apexguru-latest.json' : 'quality-latest.json');
        if (exitCode === 0 && await fs.pathExists(latestPath)) {
          return await fs.readJson(latestPath);
        }
        return { exitCode, stdout, stderr };
      }

      case 'sfdt_logs': {
        const type = args.type;
        if (type === 'preflight' || type === 'drift' || type === 'quality') {
          const fileMap = {
            preflight: 'preflight-latest.json',
            drift: 'drift-latest.json',
            quality: 'quality-latest.json',
          };
          const filePath = path.join(logDir, fileMap[type]);
          if (await fs.pathExists(filePath)) {
            return await fs.readJson(filePath);
          }
          return { error: `No latest log found for type: ${type}` };
        }

        const subDirMap = {
          deploy: 'deploy-results',
          rollback: 'rollback-results',
        };
        const archiveDir = path.join(logDir, subDirMap[type]);
        if (!(await fs.pathExists(archiveDir))) {
          return { error: `No log history found for type: ${type}` };
        }

        const files = (await fs.readdir(archiveDir))
          .filter((f) => f.endsWith('.json'))
          .sort();
        if (files.length === 0) {
          return { error: `No log files found in ${archiveDir}` };
        }

        const newestFile = files[files.length - 1];
        return await fs.readJson(path.join(archiveDir, newestFile));
      }

      case 'sfdt_manifest_from_git': {
        const cmdArgs = ['manifest'];
        if (args.base) cmdArgs.push('--base', args.base);
        if (args.head) cmdArgs.push('--head', args.head);
        if (args.package) cmdArgs.push('--package', args.package);
        if (args.name) cmdArgs.push('--name', args.name);

        const { exitCode, stdout, stderr } = await this.#runCliCommand(cmdArgs);
        return { exitCode, stdout, stderr };
      }

      case 'sfdt_validate': {
        // Validation = a dry-run deploy. Pass the explicit --dry-run flag so
        // deploy.js sets options.dryRun (and thus SFDT_DRY_RUN) for the script,
        // rather than relying on ambient env-var inheritance through the CLI.
        const env = {
          SFDT_NON_INTERACTIVE: 'true',
          SFDT_TARGET_ORG: args.targetOrg,
          SFDT_DRY_RUN: 'true',
        };
        if (args.manifest) env.SFDT_MANIFEST_PATH = path.resolve(projectRoot, args.manifest);
        if (args.testLevel) env.SFDT_TEST_LEVEL = args.testLevel;
        if (Array.isArray(args.testClasses) && args.testClasses.length > 0) {
          env.SFDT_SPECIFIED_TESTS = args.testClasses.join(' ');
        }

        const { exitCode, stdout, stderr } = await this.#runCliCommand(['deploy', '--dry-run'], env);
        return { exitCode, stdout, stderr };
      }

      case 'sfdt_deploy': {
        // A real (non-dry-run) deploy mutates the org and requires explicit ack.
        if (!args.dryRun && !args.confirmExecution) {
          throw new Error('A real deployment is a potentially destructive action. Pass confirmExecution: true (or dryRun: true to validate only).');
        }

        if (args.smart) {
          // Smart delta deploy runs as a self-contained, non-interactive CLI path.
          const cliArgs = ['deploy', '--smart', '--agent', '--target-org', args.targetOrg];
          if (args.dryRun) cliArgs.push('--dry-run');
          if (args.deltaBase) cliArgs.push('--delta-base', args.deltaBase);
          if (args.deltaHead) cliArgs.push('--delta-head', args.deltaHead);
          const { exitCode, stdout, stderr } = await this.#runCliCommand(cliArgs, { SFDT_NON_INTERACTIVE: 'true' });
          return { exitCode, stdout, stderr };
        }

        const env = {
          SFDT_NON_INTERACTIVE: 'true',
          SFDT_TARGET_ORG: args.targetOrg,
          SFDT_DRY_RUN: args.dryRun ? 'true' : 'false',
        };
        if (args.manifest) env.SFDT_MANIFEST_PATH = path.resolve(projectRoot, args.manifest);
        if (args.testLevel) env.SFDT_TEST_LEVEL = args.testLevel;
        if (args.destructiveTiming) env.SFDT_DESTRUCTIVE_TIMING = args.destructiveTiming;
        if (Array.isArray(args.testClasses) && args.testClasses.length > 0) {
          env.SFDT_SPECIFIED_TESTS = args.testClasses.join(' ');
        }

        const { exitCode, stdout, stderr } = await this.#runCliCommand(['deploy'], env);
        return { exitCode, stdout, stderr };
      }

      case 'sfdt_quick_deploy': {
        if (!args.confirmExecution) {
          throw new Error('Quick deploy is a release-modifying action. You must pass confirmExecution: true to acknowledge authorization.');
        }

        const env = {
          SFDT_NON_INTERACTIVE: 'true',
          SFDT_TARGET_ORG: args.targetOrg,
          SFDT_VALIDATION_JOB_ID: args.validationJobId,
          SFDT_DRY_RUN: 'false',
        };

        const { exitCode, stdout, stderr } = await this.#runCliCommand(['deploy'], env);
        return { exitCode, stdout, stderr };
      }

      case 'sfdt_rollback': {
        if (!args.confirmExecution) {
          throw new Error('Rollback is a destructive state reversion. You must pass confirmExecution: true to acknowledge authorization.');
        }

        const cmdArgs = ['rollback', '--json'];
        const { stdout } = await this.#runCliCommand(cmdArgs);
        return this.#parseCliJson(stdout);
      }

      case 'sfdt_audit': {
        const check = args.check && args.check !== 'all' ? args.check : 'all';
        const cmdArgs = ['audit', check, '--json'];
        if (args.org) cmdArgs.push('--org', args.org);
        const { stdout } = await this.#runCliCommand(cmdArgs);
        return this.#parseCliJson(stdout);
      }

      case 'sfdt_monitor': {
        const check = args.check && args.check !== 'all' ? args.check : 'all';
        const cmdArgs = ['monitor', check, '--json'];
        if (args.org) cmdArgs.push('--org', args.org);
        if (check === 'all' && args.backup) cmdArgs.push('--backup');
        const { stdout } = await this.#runCliCommand(cmdArgs);
        return this.#parseCliJson(stdout);
      }

      case 'sfdt_notify': {
        const type = args.type === 'audit' ? 'audit' : 'monitor';
        const { exitCode, stdout, stderr } = await this.#runCliCommand(['notify', 'snapshot', '--type', type], {
          SFDT_NON_INTERACTIVE: 'true',
        });
        return { exitCode, stdout, stderr };
      }

      case 'sfdt_retrofit': {
        if (args.execute && !args.confirmExecution) {
          throw new Error('A real retrofit deploy is potentially destructive. Pass confirmExecution: true (or omit execute for validate-only).');
        }
        const cliArgs = ['retrofit', '--source', args.source, '--target', args.target, '--json'];
        if (args.metadata) cliArgs.push('--metadata', args.metadata);
        if (args.execute) cliArgs.push('--execute');
        const { exitCode, stdout, stderr } = await this.#runCliCommand(cliArgs, { SFDT_NON_INTERACTIVE: 'true' });
        try { return JSON.parse(stdout); } catch { return { exitCode, stdout, stderr }; }
      }

      case 'sfdt_pr_comment': {
        const type = args.type === 'audit' ? 'audit' : 'monitor';
        const cliArgs = ['pr', 'comment', '--type', type, '--json'];
        if (args.pr) cliArgs.push('--pr', String(args.pr));
        const { exitCode, stdout, stderr } = await this.#runCliCommand(cliArgs, { SFDT_NON_INTERACTIVE: 'true' });
        try { return JSON.parse(stdout); } catch { return { exitCode, stdout, stderr }; }
      }

      case 'sfdt_docs': {
        const cmdArgs = ['docs', 'generate', '--json'];
        if (args.ai) cmdArgs.push('--ai');
        const { stdout } = await this.#runCliCommand(cmdArgs);
        return this.#parseCliJson(stdout);
      }

      case 'sfdt_get_parked_result': {
        return await getParkedResult(args.ref, this.#config);
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }

  // Unwrap the sf-native JSON envelope ({ status, result, warnings }) emitted by
  // the CLI's --json commands: return the inner `result` on success. Falls back
  // to the whole parsed object (error envelopes, which have no `result`) or the
  // raw string when stdout is not JSON.
  #parseCliJson(stdout) {
    try {
      const parsed = JSON.parse(stdout);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'result' in parsed) {
        return parsed.result;
      }
      return parsed;
    } catch {
      return stdout;
    }
  }

  async #runCliCommand(args, envOverrides = {}) {
    const projectRoot = this.#config._projectRoot;
    
    // Explicitly run with stdout/stderr captured (never inherit)
    // so we do not corrupt standard stdio channels of the parent MCP process.
    const result = await execa('node', [ENTRYPOINT, ...args], {
      cwd: projectRoot,
      env: {
        ...process.env,
        SFDT_NON_INTERACTIVE: 'true',
        ...envOverrides,
      },
      reject: false,
    });

    return {
      exitCode: result.exitCode,
      stdout: (result.stdout ?? '').trim(),
      stderr: (result.stderr ?? '').trim(),
    };
  }
}
