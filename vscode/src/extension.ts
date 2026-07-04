import * as vscode from 'vscode';
import { spawn } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { COMMAND_GROUPS, flattenCommands, findCommand, docsUrlFor, type CommandEntry } from './lib/commands.js';
import { buildTerminalCommand } from './lib/terminal.js';
import { runSfdtForResult, captureSfdt } from './lib/run-json.js';
import { parseSmartDeployOutput, summaryLines, isValidationJobId, buildQuickDeployCommand } from './lib/smart-deploy-output.js';
import { renderSummary, nativeSpecFor, type NativeCommandSpec, type QualityResult } from './lib/render-summary.js';
import { qualityFromRun, qualityFromSnapshot, qualityToDiagnostics, groupByFile, type DiagnosticEntry } from './lib/diagnostics.js';
import { buildStatusTree } from './lib/status.js';
import { evaluatePrereqs } from './lib/prereqs.js';
import { classifyOrg, colorForOrg } from './lib/org-color.js';
import { readSnapshots, readQualityLog } from './lib/io.js';
import { OrgHealthProvider } from './tree.js';
import { CommandsProvider } from './commandsTree.js';
import { StatusProvider } from './statusTree.js';
import { DashboardController } from './dashboard.js';
import { StatusBar } from './statusBar.js';

function cfg() {
  return vscode.workspace.getConfiguration('sfdt');
}
function cliPath(): string {
  return cfg().get<string>('cliPath') || 'sfdt';
}
function defaultOrg(): string | undefined {
  return cfg().get<string>('defaultOrg') || undefined;
}
function dashboardPort(): number {
  return cfg().get<number>('dashboardPort') || 7654;
}
function orgColorEnabled(): boolean {
  return cfg().get<boolean>('orgColor') !== false;
}
function workspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

/** Capture stdout from an arbitrary command (sf, git, npm). Never throws. */
function capture(cmd: string, args: string[], cwd?: string, timeoutMs = 8000): Promise<string> {
  return new Promise((resolve) => {
    let out = '';
    let done = false;
    const finish = (v: string) => { if (!done) { done = true; resolve(v); } };
    try {
      const child = spawn(cmd, args, { cwd, env: { ...process.env }, shell: false });
      const timer = setTimeout(() => { child.kill(); finish(''); }, timeoutMs);
      child.stdout?.on('data', (d) => (out += d.toString()));
      child.on('error', () => { clearTimeout(timer); finish(''); });
      child.on('close', () => { clearTimeout(timer); finish(out); });
    } catch {
      finish('');
    }
  });
}

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('SFDT');
  const results = vscode.window.createOutputChannel('SFDT Results');
  const diagnostics = vscode.languages.createDiagnosticCollection('sfdt');
  let latestSfdtVersion: string | undefined;

  const SEVERITY: Record<DiagnosticEntry['severity'], vscode.DiagnosticSeverity> = {
    error: vscode.DiagnosticSeverity.Error,
    warning: vscode.DiagnosticSeverity.Warning,
    info: vscode.DiagnosticSeverity.Information,
  };

  /** Replace the Problems-pane contents with the given file-anchored entries. */
  const publishDiagnostics = (entries: DiagnosticEntry[]) => {
    diagnostics.clear();
    for (const [file, fileEntries] of groupByFile(entries)) {
      const uri = vscode.Uri.file(file);
      diagnostics.set(
        uri,
        fileEntries.map((e) => {
          const lineIdx = Math.max(0, e.line - 1);
          const d = new vscode.Diagnostic(
            new vscode.Range(lineIdx, 0, lineIdx, Number.MAX_SAFE_INTEGER),
            e.message,
            SEVERITY[e.severity],
          );
          d.source = e.source;
          if (e.code) d.code = e.code;
          return d;
        }),
      );
    }
  };

  // ── Status gatherer (org / git / versions / health) ──
  const gatherStatus = async () => {
    const root = workspaceRoot();
    const org = defaultOrg();
    const [orgJson, sfVer, sfdtVer, branch] = await Promise.all([
      capture('sf', ['org', 'display', '--json', ...(org ? ['--target-org', org] : [])], root),
      capture('sf', ['--version'], root, 5000),
      capture(cliPath(), ['--version'], root, 5000),
      capture('git', ['rev-parse', '--abbrev-ref', 'HEAD'], root, 4000),
    ]);
    let instanceUrl: string | undefined;
    let connected: boolean | undefined;
    let orgAlias = org;
    try {
      const parsed = JSON.parse(orgJson);
      const r = parsed.result ?? {};
      instanceUrl = r.instanceUrl;
      connected = r.connectedStatus ? /connected/i.test(r.connectedStatus) : undefined;
      orgAlias = org ?? r.alias ?? r.username;
    } catch { /* no org / sf unavailable */ }
    const { audit, monitor } = root ? await readSnapshots(root) : { audit: null, monitor: null };
    return buildStatusTree({
      orgAlias,
      instanceUrl,
      connected,
      gitBranch: branch.trim() || undefined,
      audit,
      monitor,
      sfdtVersion: (sfdtVer.trim().split('\n')[0] || undefined),
      sfVersion: (sfVer.trim().split('\n')[0] || undefined),
      latestSfdtVersion,
    });
  };

  // ── Providers ──
  const commands = new CommandsProvider();
  const health = new OrgHealthProvider(workspaceRoot);
  const status = new StatusProvider(gatherStatus);
  const dashboard = new DashboardController(cliPath, workspaceRoot, dashboardPort);
  const statusBar = new StatusBar(workspaceRoot);

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('sfdtCommands', commands),
    vscode.window.registerTreeDataProvider('sfdtOrgHealth', health),
    vscode.window.registerTreeDataProvider('sfdtStatus', status),
    output,
    results,
    diagnostics,
    statusBar,
    { dispose: () => dashboard.dispose() },
  );

  // ── Integrated terminal execution ──
  let terminal: vscode.Terminal | undefined;
  const sfdtTerminal = (): vscode.Terminal => {
    if (!terminal || terminal.exitStatus !== undefined) {
      terminal = vscode.window.createTerminal({ name: 'SFDT', cwd: workspaceRoot() });
    }
    return terminal;
  };
  context.subscriptions.push(
    vscode.window.onDidCloseTerminal((t) => { if (t === terminal) terminal = undefined; }),
  );

  const sendToTerminal = (commandLine: string) => {
    const term = sfdtTerminal();
    term.show(true);
    term.sendText(commandLine);
  };

  const runInTerminal = (args: string[]) => {
    sendToTerminal(buildTerminalCommand(args, { cliPath: cliPath(), org: defaultOrg() }));
  };

  // ── Org picker (shared by sfdt.pickOrg and one-shot flows like Quick Deploy) ──
  // Lists authenticated orgs via `sf org list --json`, falling back to a manual
  // input box when the sf CLI is unavailable. Returns the chosen alias without
  // persisting it — callers decide whether to save it as the default.
  const chooseOrg = async (placeHolder: string): Promise<string | undefined> => {
    const json = await capture('sf', ['org', 'list', '--json'], workspaceRoot());
    let aliases: Array<{ label: string; description?: string }> = [];
    try {
      const r = JSON.parse(json).result ?? {};
      const orgs = [...(r.nonScratchOrgs ?? []), ...(r.scratchOrgs ?? [])];
      aliases = orgs.map((o: Record<string, unknown>) => ({
        label: String(o.alias || o.username),
        description: String(o.username ?? ''),
      }));
    } catch { /* fall through to manual input */ }
    if (aliases.length > 0) {
      const pick = await vscode.window.showQuickPick(aliases, { placeHolder });
      return pick?.label;
    }
    return vscode.window.showInputBox({ prompt: 'Org alias for sfdt (--org)', value: defaultOrg() ?? '' });
  };

  // ── Smart deploy: validate & review, then optionally execute ──
  // `sfdt deploy` has no --json, so the dry-run output is captured and parsed
  // by the vscode-free smart-deploy-output module (thin UI: the CLI computes
  // the delta/test level; the extension only reads what it printed).
  const smartDeployExecute = async (production: boolean, orgName: string) => {
    const message = production
      ? `⚠ PRODUCTION DEPLOY — this will deploy to "${orgName}", which the validation flagged as a PRODUCTION org.`
      : `Deploy the validated smart delta to "${orgName}"?`;
    const detail = production
      ? 'This immediately modifies a production Salesforce org. Local tests will run. Are you absolutely sure?'
      : 'Runs `sfdt deploy --smart` in the integrated terminal so you can watch the deployment stream.';
    const confirmLabel = production ? 'Deploy to PRODUCTION' : 'Deploy';
    const picked = await vscode.window.showWarningMessage(message, { modal: true, detail }, confirmLabel);
    if (picked !== confirmLabel) return;
    runInTerminal(['deploy', '--smart']);
  };

  const smartDeployPreview = async (): Promise<void> => {
    const args = ['deploy', '--smart', '--dry-run'];
    const cap = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'SFDT: computing delta and validating (sfdt deploy --smart --dry-run)…',
        cancellable: false,
      },
      () => captureSfdt(args, { cliPath: cliPath(), cwd: workspaceRoot(), org: defaultOrg() }),
    );
    const raw = [cap.stdout, cap.stderr].filter((s) => s && s.trim()).join('\n');
    results.appendLine('');
    results.appendLine(`═══ ${new Date().toISOString()} · sfdt ${args.join(' ')} ═══`);
    results.appendLine(raw || '(no output)');
    results.show(true);
    if (cap.spawnError) {
      vscode.window.showErrorMessage(`Could not run the sfdt CLI: ${cap.spawnError}`);
      return;
    }
    if (cap.timedOut) {
      vscode.window.showErrorMessage('Smart-deploy validation timed out — see the SFDT Results channel.');
      return;
    }
    const summary = parseSmartDeployOutput(raw);
    if (summary.noChanges) {
      vscode.window.showInformationMessage('Smart deploy: no metadata changes detected between refs — nothing to deploy.');
      return;
    }
    const lines = summaryLines(summary);
    const orgName = summary.org ?? defaultOrg() ?? 'the default org';
    const validated = summary.succeeded && !summary.failed && cap.code === 0;
    const items: vscode.QuickPickItem[] = [];
    if (validated) {
      items.push({
        label: summary.production ? '$(rocket) Deploy now — ⚠ PRODUCTION' : '$(rocket) Deploy now',
        description: `sfdt deploy --smart → ${orgName}`,
        detail: lines.join('  ·  '),
      });
    }
    items.push(
      { label: '$(refresh) Re-validate', description: 'Run the delta validation again' },
      { label: '$(close) Cancel' },
    );
    const placeHolder = validated
      ? `Validation passed · ${lines.join(' · ')}`
      : `Validation failed${summary.failureDetail ? ` — ${summary.failureDetail}` : ''} · see SFDT Results`;
    const pick = await vscode.window.showQuickPick(items, { placeHolder, ignoreFocusOut: true, matchOnDetail: true });
    if (!pick) return;
    if (pick.label.startsWith('$(rocket)')) return smartDeployExecute(summary.production, orgName);
    if (pick.label.startsWith('$(refresh)')) return smartDeployPreview();
  };

  // ── Quick Deploy: promote a previously validated job (0Af…) ──
  // The CLI's quick-deploy path is deployment-assistant.sh's non-interactive
  // branch, driven by SFDT_VALIDATION_JOB_ID; the built command env-prefixes
  // the vars and redirects stdin from /dev/null so the CLI's script runner
  // flags the run non-interactive while output streams in the terminal.
  const quickDeploy = async (): Promise<void> => {
    const jobId = (
      await vscode.window.showInputBox({
        prompt: 'Salesforce validation job ID from a prior validate run (starts with 0Af)',
        placeHolder: '0Af… (15 or 18 characters)',
        validateInput: (v) =>
          isValidationJobId(v.trim()) ? undefined : 'Enter a 15- or 18-character deploy request ID starting with "0Af"',
      })
    )?.trim();
    if (!jobId) return;
    const org = await chooseOrg('Target org for the quick deploy');
    if (!org) return;
    const picked = await vscode.window.showWarningMessage(
      `Quick Deploy validation job ${jobId} to "${org}"?`,
      {
        modal: true,
        detail:
          'Promotes the already-validated deployment without re-running tests. The org must match the one the validation ran against.',
      },
      'Quick Deploy',
    );
    if (picked !== 'Quick Deploy') return;
    if (process.platform === 'win32') {
      vscode.window.showWarningMessage(
        'Quick Deploy sends a POSIX-style command (env prefix + /dev/null redirect) — use a bash-compatible integrated terminal (Git Bash/WSL), not PowerShell or cmd.',
      );
    }
    sendToTerminal(buildQuickDeployCommand({ cliPath: cliPath(), org, jobId }));
  };

  // ── Refresh (snapshots feed Org Health + Status + status bar) ──
  const refreshViews = async () => {
    await Promise.all([health.refresh(), status.refresh(), statusBar.refresh(defaultOrg())]);
    await applyOrgColor();
  };

  // ── Native (non-terminal) execution for snapshot-producing commands ──
  // Runs the CLI (with --json when supported) under a progress notification,
  // refreshes the trees, and renders a markdown summary into the
  // "SFDT Results" channel.
  const runNative = async (args: string[], spec: NativeCommandSpec, label?: string): Promise<void> => {
    const startedAt = new Date().toISOString();
    const run = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `SFDT: running \`sfdt ${args.join(' ')}\`…`,
        cancellable: false,
      },
      () =>
        runSfdtForResult(args, {
          cliPath: cliPath(),
          cwd: workspaceRoot(),
          org: spec.org ? defaultOrg() : undefined,
          json: spec.json,
        }),
    );
    // Quality violations are file-anchored — surface them in the Problems
    // pane (paths resolved against the workspace root so each entry opens the
    // right file). Sources: the run's envelope/stdout markers, else a
    // logs/quality-latest.json snapshot written during this run (today's CLI
    // swallows the scanner output, so the snapshot is the only place real
    // violation data lands). Each run replaces the previous set — a run that
    // produced no parseable quality result clears stale entries rather than
    // leaving them behind.
    let quality: QualityResult | null = null;
    if (spec.kind === 'quality') {
      const root = workspaceRoot();
      const snapshot = root ? await readQualityLog(root) : null;
      quality = qualityFromRun(run, { snapshot, since: startedAt });
      publishDiagnostics(qualityToDiagnostics(quality, root));
    }
    await refreshViews();
    const summary = renderSummary(spec.kind, run, { label, quality });
    results.appendLine('');
    results.appendLine(`═══ ${new Date().toISOString()} · sfdt ${args.join(' ')} ═══`);
    results.appendLine(summary.markdown);
    results.show(true);
    const show =
      summary.severity === 'error'
        ? vscode.window.showErrorMessage
        : summary.severity === 'warn'
          ? vscode.window.showWarningMessage
          : vscode.window.showInformationMessage;
    // When the CLI itself failed (couldn't run, timed out, or emitted no
    // envelope), offer the terminal as a graceful fallback.
    const actions = run.ok ? [] : ['Run in Terminal'];
    const picked = await show(summary.headline, ...actions);
    if (picked === 'Run in Terminal') runInTerminal(args);
  };

  // Single entry point for catalog entries (tree clicks, quick-pick search,
  // palette shortcuts). Snapshot/report-producing commands (audit/monitor/
  // preflight/quality/coverage — including audit/monitor subcommands) run
  // natively with rendered results; interactive commands (deploy picker,
  // init) and destructive ones keep the integrated terminal.
  const runEntry = async (entry: CommandEntry) => {
    if (entry.action === 'dashboard') return dashboard.open();
    if (!entry.args) return;
    const spec = nativeSpecFor(entry);
    if (spec) return runNative(entry.args, spec, entry.label);
    if (entry.destructive) {
      const ok = await vscode.window.showWarningMessage(
        `Run "sfdt ${entry.args.join(' ')}"? This can modify the org or your project.`,
        { modal: true },
        'Run',
      );
      if (ok !== 'Run') return;
    }
    runInTerminal(entry.args);
  };

  // Auto-refresh when any snapshot file changes, regardless of how it was run.
  // A quality snapshot additionally feeds the Problems pane: dashboard
  // (`sfdt ui`) quality runs write logs/quality-latest.json, so violations
  // from those scans land here live — each snapshot replaces the previous
  // diagnostics set.
  const publishFromQualitySnapshot = async () => {
    const r = workspaceRoot();
    if (!r) return;
    publishDiagnostics(qualityToDiagnostics(qualityFromSnapshot(await readQualityLog(r)), r));
  };
  const root = workspaceRoot();
  if (root) {
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(root, 'logs/*-latest.json'),
    );
    const onSnapshot = (uri: vscode.Uri) => {
      void refreshViews();
      if (path.basename(uri.fsPath) === 'quality-latest.json') void publishFromQualitySnapshot();
    };
    watcher.onDidCreate(onSnapshot);
    watcher.onDidChange(onSnapshot);
    context.subscriptions.push(watcher);
  }

  // ── Per-org window tint ──
  async function applyOrgColor(): Promise<void> {
    if (!orgColorEnabled()) return;
    const org = defaultOrg();
    const orgJson = await capture('sf', ['org', 'display', '--json', ...(org ? ['--target-org', org] : [])], workspaceRoot());
    let customizations: Record<string, string> | null = null;
    try {
      const r = JSON.parse(orgJson).result ?? {};
      customizations = colorForOrg(classifyOrg({
        instanceUrl: r.instanceUrl,
        isSandbox: r.isSandbox,
        isScratch: r.isScratchOrg,
        isDevEdition: typeof r.edition === 'string' && /developer/i.test(r.edition),
      }));
    } catch { /* leave untinted */ }
    try {
      await cfg().update('orgColorCustomizations', undefined, vscode.ConfigurationTarget.Workspace).then(undefined, () => {});
      const workbench = vscode.workspace.getConfiguration('workbench');
      await workbench.update('colorCustomizations', customizations ?? {}, vscode.ConfigurationTarget.Workspace);
    } catch { /* color update is best-effort */ }
  }

  // ── Prerequisite / welcome context ──
  const refreshPrereqs = async () => {
    const r = workspaceRoot();
    const hasSf = (await capture('sf', ['--version'], r, 5000)).trim().length > 0;
    const hasSfdt = (await capture(cliPath(), ['--version'], r, 5000)).trim().length > 0;
    const hasConfig = !!r && fs.existsSync(path.join(r, '.sfdt', 'config.json'));
    const state = evaluatePrereqs({ hasSf, hasSfdt, hasConfig });
    await vscode.commands.executeCommand('setContext', 'sfdt:ready', state.ready);
    await vscode.commands.executeCommand('setContext', 'sfdt:hasSfdt', hasSfdt);
  };

  // ── Refresh latest-version hint without blocking ──
  const refreshLatestVersion = () => {
    void capture('npm', ['view', '@sfdt/cli', 'version'], workspaceRoot(), 6000).then((v) => {
      const trimmed = v.trim();
      if (trimmed) { latestSfdtVersion = trimmed; void status.refresh(); }
    });
  };

  // ── Commands ──
  context.subscriptions.push(
    vscode.commands.registerCommand('sfdt.runEntry', (arg: CommandEntry | { entry: CommandEntry }) => {
      // Leaf click passes a CommandEntry; the context menu passes the CmdNode.
      const entry = arg && 'entry' in arg ? arg.entry : (arg as CommandEntry);
      return runEntry(entry);
    }),
    vscode.commands.registerCommand('sfdt.runArgs', (args: string[]) => {
      // Org Health / Status tree nodes pass raw argv — give audit/monitor
      // (and friends) the same native rendering as the Commands tree.
      const spec = nativeSpecFor({ id: args[0] ?? '', args });
      return spec ? runNative(args, spec) : runInTerminal(args);
    }),
    vscode.commands.registerCommand('sfdt.refresh', () => { refreshLatestVersion(); return refreshViews(); }),
    vscode.commands.registerCommand('sfdt.openDashboard', () => dashboard.open()),

    vscode.commands.registerCommand('sfdt.searchCommands', async () => {
      const pick = await vscode.window.showQuickPick(
        flattenCommands().map((e) => ({ label: e.label, detail: e.detail, description: e.args?.join(' '), entry: e })),
        { placeHolder: 'Run an sfdt command…', matchOnDetail: true, matchOnDescription: true },
      );
      if (pick) await runEntry(pick.entry);
    }),

    vscode.commands.registerCommand('sfdt.copyCommand', async (node?: { entry?: CommandEntry }) => {
      const entry = node?.entry;
      if (!entry?.args) return;
      await vscode.env.clipboard.writeText(buildTerminalCommand(entry.args, { cliPath: cliPath(), org: defaultOrg() }));
      vscode.window.showInformationMessage('Command copied to clipboard');
    }),

    vscode.commands.registerCommand('sfdt.openCommandDocs', async (node?: { entry?: CommandEntry }) => {
      const url = node?.entry ? docsUrlFor(node.entry.id) : 'https://sfdt.dev/cli/commands';
      if (url) await vscode.env.openExternal(vscode.Uri.parse(url));
    }),

    vscode.commands.registerCommand('sfdt.pickOrg', async () => {
      const chosen = await chooseOrg('Select the target org');
      if (chosen !== undefined) {
        await cfg().update('defaultOrg', chosen, vscode.ConfigurationTarget.Workspace);
        await refreshViews();
      }
    }),

    vscode.commands.registerCommand('sfdt.setOrg', () => vscode.commands.executeCommand('sfdt.pickOrg')),
    vscode.commands.registerCommand('sfdt.smartDeployPreview', () => smartDeployPreview()),
    vscode.commands.registerCommand('sfdt.quickDeploy', () => quickDeploy()),
    vscode.commands.registerCommand('sfdt.init', () => runInTerminal(['init'])),
    vscode.commands.registerCommand('sfdt.clearDiagnostics', () => diagnostics.clear()),

    // Dedicated palette shortcuts to common commands (back-compat + discoverability).
    // runEntry routes snapshot-producing commands (audit/monitor/preflight/
    // quality/coverage) natively; interactive ones (deploy, backup, docs)
    // keep the terminal.
    ...(['audit', 'monitor', 'deploy', 'preflight', 'quality', 'backup', 'docs-generate'].map((id) =>
      vscode.commands.registerCommand(`sfdt.${id.replace('-generate', '')}`, () => {
        const entry = findCommand(id);
        if (!entry) return;
        return runEntry(entry);
      }),
    )),
  );

  // Initial population.
  void refreshPrereqs();
  refreshLatestVersion();
  void refreshViews();

  // React to config changes (org / color toggle).
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('sfdt.defaultOrg') || e.affectsConfiguration('sfdt.orgColor')) {
        void refreshViews();
      }
      if (e.affectsConfiguration('sfdt.cliPath')) void refreshPrereqs();
    }),
  );

  // Keep COMMAND_GROUPS referenced so tree-shaking never drops it (defensive).
  void COMMAND_GROUPS.length;
}

export function deactivate(): void {
  /* subscriptions disposed by VS Code */
}
