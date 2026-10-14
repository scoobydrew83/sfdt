import type { Metadata } from "next";
import Link from "next/link";
import { Chrome } from "../components/Chrome";
import {
  CONTACT_EMAIL,
  CONTACT_MAILTO,
  EFFECTIVE_DATE,
  ENTITY,
  ENTITY_JURISDICTION,
  ISSUES_URL,
  POSTAL_ADDRESS_LINES,
  REPO_URL,
  SECURITY_URL,
} from "../lib/legal";

export const metadata: Metadata = {
  title: "Terms of Use — SFDT",
  description:
    "Terms of use for sfdt.dev and the SFDT tools: Apache-2.0 licensing, no warranty, limitation of liability, trademark notices and governing law.",
};

/**
 * Terms of Use for this website and for the published SFDT builds.
 *
 * The Apache-2.0 licence in the repository is what governs the software itself;
 * §2 says so explicitly, and nothing on this page may be written so as to
 * narrow the rights that licence grants.
 */
export default function Terms() {
  return (
    <Chrome title="Terms" path="/terms">
      <article className="legal">
        <p className="kicker">Legal</p>
        <h1>Terms of Use</h1>
        <p className="legal-date">
          Effective {EFFECTIVE_DATE}. Applies to this website and to the published SFDT builds.
        </p>

        <h2 id="who">1. Who these terms are with</h2>
        <p>
          SFDT is published by {ENTITY}, a limited liability company organised in{" "}
          {ENTITY_JURISDICTION} (&ldquo;we&rdquo;, &ldquo;us&rdquo;). These terms cover your use
          of this website at <span className="mono">sfdt.dev</span> and of the builds we publish:
          the <span className="mono">@sfdt/cli</span> command-line tool on npm, the browser
          extension &ldquo;SFDT for Salesforce&rdquo; on the Chrome Web Store, and the VS Code
          extension <span className="mono">sfdt.sfdt-devtools</span> on the Visual Studio
          Marketplace.
        </p>
        <p>
          There are no accounts and no fees. Using the site or installing a build means you accept
          these terms; if you do not, do not use them.
        </p>

        <h2 id="licence">2. The software is open source — the licence governs it</h2>
        <p>
          SFDT&rsquo;s source code is public at{" "}
          <a href={REPO_URL}>github.com/scoobydrew83/sfdt</a> and is licensed to you under the{" "}
          <a href="https://www.apache.org/licenses/LICENSE-2.0">Apache License, Version 2.0</a>.
          That licence — not this page — is what grants and governs your rights to use, copy,
          modify and redistribute the software.
        </p>
        <div className="callout">
          <p>
            <strong>Nothing in these terms limits the rights the Apache-2.0 licence grants you.</strong>{" "}
            If anything here conflicts with that licence in respect of the software, the licence
            controls. These terms add only what a licence does not cover: the operation of this
            website and the things we say about the builds we distribute.
          </p>
        </div>
        <p>
          Third-party components are listed with their own licences and attributions in{" "}
          <a href={`${REPO_URL}/blob/main/THIRD_PARTY_NOTICES.md`}>THIRD_PARTY_NOTICES.md</a>, and
          those licences continue to apply to those components.
        </p>

        <h2 id="your-use">3. Your use of the tools and the site</h2>
        <p>
          SFDT operates on Salesforce orgs you already have access to, using credentials you supply
          through Salesforce&rsquo;s own tooling. You are responsible for:
        </p>
        <ul>
          <li>
            having authority to run these tools against the orgs you point them at, and complying
            with your own organisation&rsquo;s policies and with your agreements with Salesforce;
          </li>
          <li>
            what you run. Some features change or delete data in your org — deploys, rollbacks,
            record and bulk deletes, data imports, permission writes. The destructive ones ship off
            by default or require a typed confirmation, but the decision and the consequences are
            yours. Validate against a sandbox or scratch org first, and keep your own backups;
          </li>
          <li>
            the data you choose to route elsewhere — to an AI provider, a notification channel or a
            webhook you configure. The{" "}
            <Link href="/privacy">Privacy Policy</Link> describes exactly what each path sends;
          </li>
          <li>
            your own credentials and API keys. We never receive them, so we cannot rotate or revoke
            them for you.
          </li>
        </ul>
        <p>
          As for this website: use it lawfully. Do not attempt to break, overload or probe it
          beyond ordinary use, do not use it to distribute malware, and do not scrape it in a way
          that degrades it for others. Security research is welcome — report findings through{" "}
          <a href={SECURITY_URL}>GitHub&rsquo;s private security advisories</a> rather than
          publicly.
        </p>

        <h2 id="availability">4. Availability and changes</h2>
        <p>
          The site and the tools are provided free of charge and with no service commitment. We may
          change, break, deprecate or withdraw any feature, endpoint, page or published build at any
          time, and we do not promise any uptime, retention or backwards compatibility. Content on
          this site — including fixture data on the Trailblazer pages — may be incomplete,
          out of date or illustrative rather than live, and is not advice you should rely on
          without checking it.
        </p>

        <h2 id="warranty">5. No warranty</h2>
        <p>
          <strong>
            The software and this website are provided &ldquo;AS IS&rdquo; and
            &ldquo;AS AVAILABLE&rdquo;, without warranties or conditions of any kind, either
            express or implied.
          </strong>{" "}
          This includes, without limitation, any implied warranties or conditions of title,
          non-infringement, merchantability, fitness for a particular purpose, accuracy, or
          uninterrupted or error-free operation. This mirrors section 7 of the Apache-2.0 licence
          and extends the same disclaimer to the website.
        </p>
        <p>
          In particular, SFDT&rsquo;s audits, quality scores, security and field-impact analyses,
          deployment test selection and AI-generated output are <em>aids to your judgement, not
          substitutes for it</em>. They can be wrong, incomplete or out of date. Nothing SFDT
          produces is legal, security or compliance advice, and a passing check is not a guarantee
          that a deployment is safe.
        </p>

        <h2 id="liability">6. Limitation of liability</h2>
        <p>
          To the maximum extent permitted by applicable law, and in no event, whether in contract,
          tort (including negligence), strict liability or otherwise, will {ENTITY} or any
          contributor be liable to you for any damages arising out of or relating to the software or
          this website. This includes, without limitation, any direct, indirect, special,
          incidental, exemplary or consequential damages, and any loss of or damage to data,
          metadata or Salesforce configuration, loss of profits, revenue, goodwill, or business
          interruption — even if advised of the possibility of such damages. This mirrors section 8
          of the Apache-2.0 licence and extends it to the website.
        </p>
        <p>
          Where liability cannot lawfully be excluded, our total aggregate liability relating to the
          software and this website is limited to the greater of the amount you paid us for them
          (which is zero) or US$100.
        </p>
        <p>
          Some jurisdictions do not allow the exclusion of certain warranties or the limitation of
          certain liabilities. In those jurisdictions the exclusions and limitations above apply
          only to the extent the law allows, and nothing here affects rights that cannot lawfully be
          waived.
        </p>

        <h2 id="trademarks">7. Trademarks and independence</h2>
        <div className="callout">
          <p>
            <strong>
              SFDT is an independent open-source project. It is not affiliated with, endorsed by,
              sponsored by, certified by, or in any way officially connected to Salesforce, Inc.
            </strong>
          </p>
        </div>
        <p>
          Salesforce<sup>®</sup>, Salesforce Platform, Flow Builder, Apex, Lightning, Trailhead,
          Trailblazer, Agentforce, Salesforce DX and related names, marks and logos are trademarks
          or registered trademarks of Salesforce, Inc. or its affiliates. They are used on this site
          and in SFDT&rsquo;s documentation and interface <strong>nominatively</strong> — that is,
          only to describe the products SFDT interoperates with and the features it works on. No
          sponsorship or endorsement is claimed or implied, and no right in those marks is asserted.
        </p>
        <p>
          Google Chrome, Microsoft Visual Studio Code, Microsoft Teams, Google Chat, Slack,
          Cloudflare, GitHub, npm, Grafana Loki, Anthropic Claude, Google Gemini and OpenAI are
          trademarks of their respective owners and are likewise referred to nominatively. Those
          companies do not sponsor or endorse SFDT.
        </p>
        <p>
          Your rights to SFDT&rsquo;s own name and logo are limited to what the Apache-2.0 licence
          says: section 6 of that licence grants no trademark rights. You may of course state
          factually that your work uses or builds on SFDT.
        </p>

        <h2 id="third-party">8. Third-party services</h2>
        <p>
          SFDT interoperates with services operated by other people: your Salesforce org, the npm
          registry, AI providers, notification platforms and GitHub, among others. Your use of those
          services is governed by their terms and their privacy policies, not by these. We are not
          responsible for what they do, what they charge you, or what they do with content you send
          them through a path you configured.
        </p>

        <h2 id="governing-law">9. Governing law and venue</h2>
        <p>
          These terms, and any dispute arising out of or relating to them, this website or the
          builds we publish, are governed by the laws of the <strong>State of Texas</strong> and the
          federal laws of the United States applicable there, without regard to conflict-of-laws
          rules. You and {ENTITY} agree to the exclusive jurisdiction of the state and federal
          courts located in Texas for any such dispute, and each waives any objection to venue
          there.
        </p>
        <p>
          The United Nations Convention on Contracts for the International Sale of Goods does not
          apply. If you are a consumer resident elsewhere, this clause does not deprive you of the
          protection of mandatory consumer-protection law in your place of residence.
        </p>

        <h2 id="general">10. General</h2>
        <ul>
          <li>
            <strong>Changes.</strong> We may update these terms; the effective date above changes
            when we do, and the full edit history is public in git. Continuing to use the site or
            the builds after a change means you accept the updated terms.
          </li>
          <li>
            <strong>Severability.</strong> If a provision is held unenforceable, the rest stays in
            force and the unenforceable part is limited to the minimum extent necessary.
          </li>
          <li>
            <strong>No waiver.</strong> Not enforcing a provision is not a waiver of it.
          </li>
          <li>
            <strong>Entire agreement.</strong> For the website and the published builds, these
            terms together with the <Link href="/privacy">Privacy Policy</Link> are the whole
            agreement between us — except that the Apache-2.0 licence remains the agreement
            covering the software itself.
          </li>
        </ul>

        <h2 id="contact">11. Contact and notices</h2>
        <p>
          <strong>Privately, and for anything legal.</strong> Email{" "}
          <a href={CONTACT_MAILTO}>{CONTACT_EMAIL}</a>, or write to us:
        </p>
        <address className="legal-address">
          {POSTAL_ADDRESS_LINES.map((line) => (
            <span key={line}>{line}</span>
          ))}
        </address>
        <p>
          Any notice required under these terms — a legal notice, a trademark or copyright
          complaint, a dispute, or anything you would rather not put in public — should go to one of
          those two addresses, and we will treat a notice as given when it reaches either. Notices
          to you may be given through this website or the repository.
        </p>
        <p>
          <strong>Publicly, if you would rather.</strong> A question about these terms, or anything
          that looks wrong on this page, is also welcome as an{" "}
          <a href={ISSUES_URL}>issue in the public repository</a> — often the faster route for
          anything that is fine in the open. Security vulnerabilities go privately through{" "}
          <a href={SECURITY_URL}>GitHub&rsquo;s security advisories</a>, per{" "}
          <a href={`${REPO_URL}/blob/main/SECURITY.md`}>SECURITY.md</a>. Privacy and data-subject
          requests are handled through the contact routes in the{" "}
          <Link href="/privacy">Privacy Policy</Link>, which are the same ones.
        </p>
        <p className="faint">
          {ENTITY}, {ENTITY_JURISDICTION}.
        </p>
      </article>
    </Chrome>
  );
}
