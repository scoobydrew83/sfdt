import path from 'path';
import fs from 'fs-extra';
import { loadConfig } from '../lib/config.js';
import { print } from '../lib/output.js';
import { fetchInventory } from '../lib/org-inventory.js';
import { diffInventories } from '../lib/org-diff.js';
import { renderPackageXml } from '../lib/metadata-mapper.js';

export function registerCompareCommand(program) {
  program
    .command('compare')
    .description('Compare metadata between two orgs or an org and local source')
    .option('--source <alias|local>', 'Source org alias or "local"', 'local')
    .option('--target <alias>', 'Target org alias (default: config.defaultOrg)')
    .option('--output <file>', 'Write a package.xml of source-only items to this file')
    .action(async (options) => {
      try {
        const config = await loadConfig();
        const source = options.source ?? 'local';
        const target = options.target ?? config.defaultOrg;
        const logDir = config.logDir ?? path.join(config._projectRoot, 'logs');

        print.header(`Comparing ${source} → ${target}`);
        print.info('Fetching source inventory…');

        const [sourceMap, targetMap] = await Promise.all([
          fetchInventory(source, config),
          fetchInventory(target, config),
        ]);

        print.info('Diffing inventories…');
        const items = diffInventories(sourceMap, targetMap);

        const resultPath = path.join(logDir, 'compare-latest.json');
        await fs.ensureDir(logDir);
        await fs.outputJson(
          resultPath,
          { date: new Date().toISOString(), source, target, items },
          { spaces: 2 },
        );

        const sourceOnly = items.filter((i) => i.status === 'source-only');
        const targetOnly = items.filter((i) => i.status === 'target-only');
        const both = items.filter((i) => i.status === 'both');

        print.success(
          `Comparison complete. ${sourceOnly.length} only in source · ${targetOnly.length} only in target · ${both.length} in both`,
        );
        print.info(`Results written to ${resultPath}`);

        if (options.output) {
          const manifestMeta = {};
          for (const item of sourceOnly) {
            if (!manifestMeta[item.type]) manifestMeta[item.type] = [];
            manifestMeta[item.type].push(item.member);
          }
          const xml = renderPackageXml(manifestMeta, config.sourceApiVersion ?? '63.0');
          await fs.outputFile(options.output, xml);
          print.success(`Package.xml written to ${options.output}`);
        }
      } catch (err) {
        print.error(`Comparison failed: ${err.message}`);
        process.exitCode = 1;
      }
    });
}
