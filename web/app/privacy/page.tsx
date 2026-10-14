import type { Metadata } from "next";
import Link from "next/link";
import { Chrome } from "../components/Chrome";
import {
  EFFECTIVE_DATE,
  ENTITY,
  ENTITY_JURISDICTION,
  ISSUES_URL,
  REPO_URL,
  SECURITY_URL,
} from "../lib/legal";

export const metadata: Metadata = {
  title: "Privacy Policy — SFDT",
  description:
    "What the SFDT browser extension, VS Code extension, CLI and sfdt.dev read, store and send. No accounts, no analytics, no server of ours holding your data.",
};

/**
 * The canonical privacy policy for every SFDT surface.
 *
 * Every factual claim here was checked against the code at the ref that added
 * this page; `extension/PRIVACY.md` points at this page and the two must be
 * changed together. The three outbound destinations named in §6 are the whole
 * set — a new one is a policy change, not just a code change.
 */
export default function Privacy() {
  return (
    <Chrome title="Privacy" path="/privacy">
      <article className="legal">
        <p className="kicker">Legal</p>
        <h1>Privacy Policy</h1>
        <p className="legal-date">
          Effective {EFFECTIVE_DATE}. Applies to all SFDT software and to this website.
        </p>

        <ul className="toc">
          <li>
            <a href="#summary">Summary</a>
          </li>
          <li>
            <a href="#browser-extension">Browser extension</a>
          </li>
          <li>
            <a href="#vscode">VS Code extension</a>
          </li>
          <li>
            <a href="#cli">CLI</a>
          </li>
          <li>
            <a href="#site">sfdt.dev</a>
          </li>
          <li>
            <a href="#outbound">Where data goes</a>
          </li>
          <li>
            <a href="#limited-use">Limited Use</a>
          </li>
          <li>
            <a href="#controls">Your controls</a>
          </li>
          <li>
            <a href="#contact">Contact</a>
          </li>
        </ul>

        <h2 id="summary">Summary</h2>
        <p>
          SFDT is a set of developer tools for Salesforce admins and developers, published by{" "}
          {ENTITY} ({ENTITY_JURISDICTION}). This policy covers four surfaces:
        </p>
        <ul>
          <li>
            the <strong>browser extension</strong> &ldquo;SFDT for Salesforce&rdquo; (Chrome Web
            Store; the same source also builds for Firefox),
          </li>
          <li>
            the <strong>VS Code extension</strong> &ldquo;SFDT for Salesforce&rdquo; (
            <span className="mono">sfdt.sfdt-devtools</span>),
          </li>
          <li>
            the <strong>command-line tool</strong> <span className="mono">@sfdt/cli</span>, and
          </li>
          <li>
            this <strong>website</strong>, <span className="mono">sfdt.dev</span>.
          </li>
        </ul>
        <div className="callout">
          <p>
            <strong>There is no SFDT server.</strong> We operate no accounts, no sign-up, no
            billing and no analytics backend. No SFDT surface sends your Salesforce data, your
            source code or your usage to {ENTITY} or to any service we control, because no such
            service exists. Everything these tools record, they record on your own device.
          </p>
        </div>
        <p>
          All of the source is public at{" "}
          <a href={REPO_URL}>github.com/scoobydrew83/sfdt</a>. Every claim below can be checked
          against it, and the sections that name a test are enforced by that test in CI.
        </p>

        <h2 id="browser-extension">1. Browser extension</h2>

        <h3>What it reads</h3>
        <ul>
          <li>
            <strong>Salesforce pages.</strong> The content script is injected only on{" "}
            <span className="mono">
              *.salesforce.com, *.salesforce-setup.com, *.my.salesforce.com, *.lightning.force.com
            </span>
            . It reads the page&rsquo;s DOM and URL to place its UI and to work out context — the
            record Id, object or Flow you are looking at. It does not read any other site.
          </li>
          <li>
            <strong>Your existing Salesforce session cookie</strong> (
            <span className="mono">sid</span>), so API calls run as you without a second login. The
            cookie is read in the extension&rsquo;s background service worker only, and is used
            only as the authorization on requests to your own org. It is never shown in the UI,
            never written to storage and never sent anywhere else — enforced with no allowlisted
            exceptions by <span className="mono">test/sid-never-leaves-worker.test.ts</span>.
          </li>
          <li>
            <strong>Your org&rsquo;s data, when you run a tool.</strong> SOQL/SOSL results, record
            fields, Flow and other metadata, debug logs, org limits, test and coverage results, and
            streaming events are fetched from your org&rsquo;s REST, Tooling, SOAP and streaming
            APIs and rendered in your browser.
          </li>
          <li>
            Additional host permissions (<span className="mono">*.my.salesforce.mil</span>,{" "}
            <span className="mono">*.lightning.force.mil</span>,{" "}
            <span className="mono">*.sfcrmapps.cn</span>,{" "}
            <span className="mono">*.mcas.ms</span>) exist so GovCloud, Salesforce China and
            Microsoft Defender-proxied orgs can have their API session resolved and called. No UI
            is injected on them.
          </li>
        </ul>

        <h3>What it stores, and where</h3>
        <p>
          All extension state lives in <span className="mono">chrome.storage.local</span> inside
          your own browser profile. None of it is synced to other browsers and none of it is
          transmitted to us.
        </p>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Key</th>
                <th>Contents</th>
                <th>Written when</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className="mono">sfdt.settings</td>
                <td>Per-feature toggles, AI provider preference, local bridge token</td>
                <td>You save the options page</td>
              </tr>
              <tr>
                <td className="mono">sfdt.killswitch.cache</td>
                <td>The disabled-feature list most recently returned by the local CLI bridge</td>
                <td>After a successful bridge ping</td>
              </tr>
              <tr>
                <td className="mono">sfdt.telemetry</td>
                <td>Opt-in local feature-use counters (see below)</td>
                <td>Only while you have telemetry switched on</td>
              </tr>
              <tr>
                <td className="mono">sfdt.activity</td>
                <td>
                  The last 100 operations you ran: timestamp, tool id, action label, outcome, and a
                  truncated description of the target
                </td>
                <td>
                  After a SOQL/SOSL run, anonymous Apex execution, metadata deploy/retrieve, or
                  bridge tool run
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p>
          A separate memory-only cache (<span className="mono">chrome.storage.session</span>, which
          the browser clears when it closes) holds the resolved API hostname and org id per
          Salesforce host so each call does not have to re-resolve it. It never holds the session
          cookie. Incognito windows get a wholly separate session (
          <span className="mono">incognito: &quot;split&quot;</span>), so incognito and normal
          browsing never share resolved sessions.
        </p>

        <h3>The activity log</h3>
        <p>
          This is the only local key that can contain data from your org, so it is worth being
          precise. The <span className="mono">resource</span> field stores the{" "}
          <strong>first 120 characters</strong> of the SOQL statement or Apex snippet you ran, or a
          class name or deploy job id. Whitespace is collapsed before the cap is applied, so it
          cannot be padded past the limit. Query <em>results</em> are never stored — no records, no
          field values returned by Salesforce, ever. The log is capped at 100 entries and the
          oldest falls off. A <span className="mono">WHERE</span> clause can contain personal data,
          which is why the cap exists and why the log has its own switch: Options → Activity log →
          uncheck &ldquo;Record recent activity&rdquo; and nothing is written at all.
        </p>

        <h3>Telemetry — opt-in, local-only</h3>
        <p>
          The extension collects no telemetry unless you open the options page and check
          &ldquo;Enable local telemetry&rdquo;. Even then, it stays on your device:
        </p>
        <ul>
          <li>
            The schema is a per-feature{" "}
            <span className="mono">{`{ activated, errored, disabled_remote }`}</span> integer
            triple keyed by feature id, plus coarse local-bridge failure counts by category
            (offline, timeout, unauthorized, protocol, other) and a month key such as{" "}
            <span className="mono">2026-10</span>.
          </li>
          <li>Counters reset at the start of each calendar month and are capped at 500 feature ids.</li>
          <li>
            No org names, usernames, Flow names, record ids, IP addresses, or timestamps finer than
            the month.
          </li>
          <li>
            <strong>No network egress.</strong> The counters are read back into the options page so
            you can see your own usage. This is enforced by{" "}
            <span className="mono">test/telemetry.test.ts</span>.
          </li>
          <li>
            If you are also running the local CLI, the extension may push a copy of these counters
            through the local bridge to{" "}
            <span className="mono">&lt;project&gt;/.sfdt/telemetry-snapshot.json</span> on your own
            disk, so <span className="mono">sfdt extension stats</span> can render them.
          </li>
        </ul>

        <h3>The local CLI bridge and native host</h3>
        <p>
          Some features (Flow Deploy, Rollback, Org Compare, Drift Check, Metadata Scan, Quality
          Results, the deeper Org Health checks, and the AI runs) work by asking the{" "}
          <span className="mono">sfdt</span> CLI on your own machine to do the work. They are
          inactive until you start it yourself with <span className="mono">sfdt ui</span>. Requests
          then go to <span className="mono">http://127.0.0.1:7654</span> — a loopback address,
          meaning the traffic never leaves your machine — authenticated with a bearer token stored
          in your home directory. The optional native messaging host (
          <span className="mono">com.sfdt.host</span>, installed only if you run{" "}
          <span className="mono">sfdt extension install-host</span>) is a read-only fallback over
          stdio to a process on the same machine, and its manifest permits only this
          extension&rsquo;s id to talk to it.
        </p>
        <p>
          The disabled-feature list the extension caches (its &ldquo;kill switch&rdquo;) is read by
          that local bridge from a file in your own project,{" "}
          <span className="mono">.sfdt/feature-flags.json</span>. No server of ours is contacted for
          it.
        </p>

        <h3>AI features</h3>
        <p>
          Two features can use a language model: the Flow <strong>AI Assistant</strong> (its
          non-AI half — clean up, summarise, copy — runs in the browser) and{" "}
          <strong>Generate query</strong> in the SOQL Runner, which ships <strong>off</strong>.
          Neither contains a model endpoint: the prompt goes over the local bridge to the CLI,
          which calls the provider <em>you</em> configured, under <em>your</em> API key or
          subscription, billed to you and governed by that provider&rsquo;s privacy policy. We are
          not in that path — we do not see, log or store prompts or completions.
        </p>
        <p>
          For Generate query, what is sent is the description you typed plus a schema table for the
          objects involved: object and field API names, labels, data types, whether a field is
          required, and inline help text. Record data is not sent, and a check refuses the send
          outright if any value from the results table on screen appears in the assembled prompt.
          With no bridge running, or with <span className="mono">&quot;features.ai&quot;: false</span>{" "}
          in the project config, nothing is sent and the panel tells you what to enable.
        </p>

        <h3>Permissions, and what each is for</h3>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Permission</th>
                <th>Why it is requested</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className="mono">storage</td>
                <td>Save your feature toggles and the opt-in local counters described above</td>
              </tr>
              <tr>
                <td className="mono">clipboardWrite</td>
                <td>
                  Copy generated output to your clipboard when you ask — reports, SOQL results,
                  object schema, the Copy-JSON actions
                </td>
              </tr>
              <tr>
                <td className="mono">cookies</td>
                <td>
                  Read your existing Salesforce session cookies to list the orgs you are already
                  logged into and authenticate calls to the one you pick. Read locally; never
                  transmitted off your device
                </td>
              </tr>
              <tr>
                <td className="mono">contextMenus</td>
                <td>
                  Offer an optional right-click &ldquo;Inspect this record&rdquo; item on your
                  Salesforce pages. It reads only the URL to find a record Id
                </td>
              </tr>
              <tr>
                <td className="mono">sidePanel</td>
                <td>
                  Dock the extension&rsquo;s own tool panel beside Lightning. No new data access and
                  no new host access. Chrome only; Firefox&rsquo;s native sidebar needs no
                  permission
                </td>
              </tr>
              <tr>
                <td className="mono">host_permissions</td>
                <td>
                  The Salesforce origins listed above, so feature scripts can run and API calls can
                  be made against your logged-in org — plus{" "}
                  <span className="mono">localhost</span> /{" "}
                  <span className="mono">127.0.0.1</span> for the local CLI bridge, inactive until
                  you start it
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p>
          The extension bundles no remote code: there is no{" "}
          <span className="mono">externally_connectable</span>, no remotely-loaded script, and no{" "}
          <span className="mono">eval</span>. It contains no third-party SDK, analytics service,
          error reporter, ad network or tracking pixel.
        </p>

        <h2 id="vscode">2. VS Code extension</h2>
        <p>
          The VS Code extension is a thin user interface over the CLI; it reimplements no logic. It
          runs <span className="mono">sfdt</span>, <span className="mono">sf</span>,{" "}
          <span className="mono">git</span> and <span className="mono">npm</span> in your workspace
          and renders what they print.
        </p>
        <ul>
          <li>
            <strong>Reads</strong> files in your workspace: <span className="mono">sfdx-project.json</span>,{" "}
            <span className="mono">.sfdt/config.json</span>, the{" "}
            <span className="mono">logs/*-latest.json</span> snapshots the CLI wrote, and the Apex
            test files you act on.
          </li>
          <li>
            <strong>Stores nothing of its own.</strong> It uses no VS Code global or workspace
            state, no secret storage, and keeps no database. The one file it can write is the
            opt-in <span className="mono">sfdt.orgColor</span> window tint, which adds{" "}
            <span className="mono">workbench.colorCustomizations</span> to your workspace&rsquo;s{" "}
            <span className="mono">.vscode/settings.json</span> and removes those keys again when
            you turn it off.
          </li>
          <li>
            <strong>Has no telemetry.</strong> It reports nothing — not to us, and not into VS
            Code&rsquo;s own telemetry channel. Whatever VS Code itself collects is Microsoft&rsquo;s
            and is governed by your VS Code telemetry setting and Microsoft&rsquo;s privacy
            statement.
          </li>
          <li>
            <strong>The embedded dashboard</strong> (<span className="mono">SFDT: Open Dashboard</span>
            ) is a webview framing <span className="mono">http://localhost:&lt;port&gt;</span> —
            the <span className="mono">sfdt ui</span> server running on your own machine. Its
            content-security policy allows that origin and nothing else.
          </li>
          <li>
            <strong>One outbound request.</strong> On activation and on refresh it runs{" "}
            <span className="mono">npm view @sfdt/cli version</span> to show an &ldquo;update
            available&rdquo; hint. That goes from your machine to whichever npm registry your{" "}
            <span className="mono">npm</span> is configured for (by default{" "}
            <span className="mono">registry.npmjs.org</span>) and carries nothing about you beyond
            what any npm request carries. Nothing else leaves your machine.
          </li>
        </ul>

        <h2 id="cli">3. Command-line tool</h2>
        <p>
          The CLI runs on your machine, under your shell, against orgs you have already
          authenticated with Salesforce&rsquo;s own <span className="mono">sf</span> CLI. It never
          asks for, stores or transmits your Salesforce credentials; its config references secrets
          by environment-variable <em>name</em>, never by value.
        </p>

        <h3>What it writes to your disk</h3>
        <ul>
          <li>
            <span className="mono">.sfdt/config.json</span> — your project configuration.
          </li>
          <li>
            <span className="mono">logs/</span> — timestamped JSON snapshots of audit, monitor,
            quality, deploy and test runs, plus <span className="mono">history.db</span>, a local
            SQLite index of your runs (type, timestamp, org alias, exit code, duration, status and
            a small summary). It keeps the most recent 200 rows per run type and prunes the rest.
          </li>
          <li>
            <span className="mono">~/.sfdt/bridge-token</span> — the local bridge&rsquo;s bearer
            token, written with <span className="mono">0600</span> permissions so other users on
            the machine cannot read it.
          </li>
          <li>Backups, reports and generated documentation, where you asked them to go.</li>
        </ul>
        <p>
          Audit logs and AI prompts pass through a redaction step that strips credential-shaped
          material: access and refresh tokens, bearer and basic auth headers, private key blocks,
          SFDX auth URLs, and secret-shaped assignments. To be clear about its limit — that step
          removes <em>credentials</em>, not business data. A query, log or diff that you choose to
          send somewhere may still contain personal data from your org, and deciding that is your
          call, not ours.
        </p>

        <h3>What it sends, and only when you ask</h3>
        <ul>
          <li>
            <strong>Your Salesforce org</strong>, through the <span className="mono">sf</span> CLI
            you authenticated.
          </li>
          <li>
            <strong>The npm registry</strong> — <span className="mono">registry.npmjs.org</span> —
            when you run <span className="mono">sfdt update</span>, and when the local dashboard
            loads, to fill in its &ldquo;update available&rdquo; banner.
          </li>
          <li>
            <strong>An AI provider you configure</strong>, and only with{" "}
            <span className="mono">&quot;features.ai&quot;: true</span>. That is either a provider
            CLI already installed and signed in on your machine (Claude Code, Gemini, OpenAI/Codex)
            or an OpenAI-compatible endpoint you point <span className="mono">ai.baseURL</span> at —
            which can be entirely local, for example Ollama on{" "}
            <span className="mono">http://localhost:11434/v1</span>. The API key is read from the
            environment variable you name. Your prompts go to your provider under your own account;
            they never reach us.
          </li>
          <li>
            <strong>Notification channels you set up</strong>, if you enable notifications: Slack,
            Microsoft Teams, Google Chat, a generic webhook, Grafana Loki, or email over an SMTP
            server you supply. Only to destinations you configured, with the content you asked to
            be sent.
          </li>
          <li>
            <strong>GitHub</strong>, through your own authenticated{" "}
            <span className="mono">gh</span> CLI, for the pull-request comment and description
            helpers.
          </li>
        </ul>
        <p>
          The local dashboard (<span className="mono">sfdt ui</span>) binds to{" "}
          <span className="mono">127.0.0.1</span> only and is token-authenticated; it is not
          reachable from your network. A development-loop telemetry facility exists in the source (
          <span className="mono">src/lib/harness-telemetry.js</span>) for this repository&rsquo;s own
          work: it writes a local JSONL file only when an explicit path is passed, and no path is
          passed in installed CLI use.
        </p>

        <h2 id="site">4. This website</h2>
        <ul>
          <li>
            <strong>No accounts, no cookies, no analytics.</strong> The site sets no cookies of its
            own, runs no analytics or tag manager, embeds no tracking pixel and carries no
            advertising. There is no form to submit and no user input collected anywhere on it.
          </li>
          <li>
            <strong>Hosting.</strong> The site runs on Cloudflare Workers. To deliver a page,
            Cloudflare necessarily processes the request — including your IP address and user agent
            — as any web host does, under Cloudflare&rsquo;s own terms. We do not add analytics on
            top of that, and we do not build profiles from it.
          </li>
          <li>
            <strong>One third-party request.</strong> Pages load the Inter typeface from Google
            Fonts (<span className="mono">fonts.googleapis.com</span>,{" "}
            <span className="mono">fonts.gstatic.com</span>), so your browser contacts Google when
            you load a page here and Google receives that request under its own privacy policy.
            That is the only third-party request the site makes.
          </li>
          <li>
            <strong>The Trailblazer pages</strong> render a fixture list bundled with the site in
            the current release. When live ingest lands, it will cache only what Trailhead already
            publishes publicly.
          </li>
          <li>
            <strong>The in-browser tools</strong> (Flow Studio, Security, Field Impact) are
            interface placeholders in the current release — no file upload and no org connection is
            wired up yet, so there is nothing for them to process. The design they are being built
            to keeps the work in your browser and its Web Worker: org metadata, Flow XML,
            permission data and any OAuth tokens are never written to Cloudflare, and tokens, when
            that lands, live in memory and <span className="mono">sessionStorage</span> only.
          </li>
          <li>
            <strong>
              <span className="mono">GET /api/engine</span>
            </strong>{" "}
            is a version endpoint and nothing more. It accepts no input and returns the analysis
            engine&rsquo;s package name and version (plus a literal{" "}
            <span className="mono">orgData: &quot;never&quot;</span>) so a client can check
            compatibility. It reads no request body, no query string and nothing about you, and it
            stores nothing.
          </li>
          <li>
            Following a documentation link from the CLI or from either extension is an ordinary
            request to this site and is handled exactly as above.
          </li>
        </ul>

        <h2 id="outbound">5. Where data goes — the complete list</h2>
        <p>
          Across all four surfaces, data leaves your device to exactly these destinations, each of
          which you choose:
        </p>
        <ol>
          <li>
            <strong>Your own Salesforce org</strong> — the origin you are already authenticated to.
          </li>
          <li>
            <strong>The npm registry</strong> — version checks from the CLI, the local dashboard
            and the VS Code extension.
          </li>
          <li>
            <strong>An AI provider you configured</strong> — under your own API key or
            subscription, only when AI features are enabled and you invoke one.
          </li>
          <li>
            <strong>Notification channels you configured</strong> — Slack, Teams, Google Chat, a
            webhook, Loki or your SMTP server, only when you set them up.
          </li>
          <li>
            <strong>GitHub</strong> — through your own <span className="mono">gh</span> CLI, for the
            PR helpers.
          </li>
          <li>
            <strong>Google Fonts</strong> — when you load a page on this website.
          </li>
        </ol>
        <p>
          {ENTITY} is not a destination on that list. We receive no personal data from these tools,
          so we are not a controller or processor of any of it, we have nothing to sell and nothing
          to share, and no data of yours is used for advertising, profiling, creditworthiness or
          lending decisions. Loopback traffic to{" "}
          <span className="mono">127.0.0.1</span> and the native messaging host are not on the list
          because they do not leave your machine.
        </p>

        <h2 id="limited-use">6. Chrome Web Store Limited Use</h2>
        <p>
          The browser extension&rsquo;s collection and use of information complies with the{" "}
          <a href="https://developer.chrome.com/docs/webstore/program-policies/limited-use/">
            Chrome Web Store User Data Policy
          </a>
          , including its Limited Use requirements. Specifically:
        </p>
        <ul>
          <li>
            Any data the extension handles is used only to provide the user-facing features
            described in the listing and in this policy — its single purpose of enhancing
            Salesforce for admins and developers.
          </li>
          <li>
            We <strong>transfer no user data</strong> to anyone. The extension sends data only to
            your own Salesforce org, to a process on your own machine, or — if you explicitly
            enable an AI feature — to the model provider you configured under your own key. There
            is no transfer to {ENTITY}.
          </li>
          <li>We do not sell user data, and we do not transfer it for advertising purposes.</li>
          <li>
            We do not use or transfer user data to determine creditworthiness or for lending
            purposes.
          </li>
          <li>
            No human at {ENTITY} reads user data. We have no mechanism to: nothing is transmitted
            to us.
          </li>
        </ul>

        <h2 id="controls">7. Your controls</h2>
        <ul>
          <li>
            <strong>Browser extension:</strong> every feature has a toggle on the options page, and
            three ship off by default (Delete records, Bulk delete from SOQL results, Generate SOQL
            from a description). Local telemetry is a single checkbox, off by default. The activity
            log has its own switch and a &ldquo;Clear activity log now&rdquo; action. To erase
            everything at once: <span className="mono">chrome://extensions</span> → SFDT for
            Salesforce → Site data → Remove all.
          </li>
          <li>
            <strong>CLI:</strong> delete <span className="mono">.sfdt/</span> and{" "}
            <span className="mono">logs/</span> to remove its local state. Set{" "}
            <span className="mono">&quot;features.ai&quot;: false</span> to disable AI entirely;
            configure no notification channels and nothing is ever sent.
          </li>
          <li>
            <strong>VS Code extension:</strong> uninstalling removes it completely — it keeps no
            state outside your workspace.
          </li>
          <li>
            <strong>This website:</strong> there is nothing to opt out of, because nothing is
            collected.
          </li>
        </ul>
        <p>
          If you are wondering how to exercise a right of access, deletion or portability against
          us: there is no request to make, because we hold no data about you. The copy that exists
          is on your own device, under your own control, and the paths above remove it.
        </p>

        <h3>Children&rsquo;s privacy</h3>
        <p>
          SFDT is a developer and administrator productivity tool. It is not directed at children
          under 13 and we do not knowingly collect any data from them.
        </p>

        <h2 id="contact">8. Changes and contact</h2>
        <p>
          If this policy changes materially, the effective date above changes with it, and because
          this page is in a public repository, the full history of every edit is visible in git.
        </p>
        <p>
          Questions about privacy, or a correction to anything on this page:{" "}
          <a href={ISSUES_URL}>open an issue</a> in the public repository. Please report security
          vulnerabilities privately instead, through{" "}
          <a href={SECURITY_URL}>GitHub&rsquo;s private security advisories</a>, as described in{" "}
          <a href={`${REPO_URL}/blob/main/SECURITY.md`}>SECURITY.md</a>.
        </p>
        <p className="faint">
          SFDT is an independent open-source project and is not affiliated with, endorsed by, or
          sponsored by Salesforce, Inc. See the <Link href="/terms">Terms of Use</Link>.
        </p>
      </article>
    </Chrome>
  );
}
