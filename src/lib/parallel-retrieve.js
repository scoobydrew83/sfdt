import { execa } from 'execa';

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export async function parallelRetrieve(delta, config, { cwd, onProgress } = {}) {
  const members = [];
  for (const [type, names] of delta) {
    for (const name of names) members.push(`${type}:${name}`);
  }

  if (members.length === 0) return { retrieved: 0, total: 0, errors: [] };

  const batchSize = config.pullCache?.batchSize ?? 100;
  const parallelism = config.pullCache?.parallelism ?? 5;
  const batches = chunk(members, batchSize);
  const errors = [];
  const successfulMembers = [];
  let retrieved = 0;

  for (let i = 0; i < batches.length; i += parallelism) {
    const window = batches.slice(i, i + parallelism);
    const windowResults = await Promise.all(
      window.map(async (batch) => {
        try {
          const metadataArgs = batch.flatMap((m) => ['--metadata', m]);
          const timeout = (config.pullCache?.retrieveTimeoutSeconds ?? 360) * 1000;
          await execa('sf', ['project', 'retrieve', 'start', ...metadataArgs], { cwd, timeout });
          return { batch, ok: true };
        } catch (err) {
          errors.push({ batch, error: err.message });
          return { batch, ok: false };
        }
      }),
    );
    const windowSucceeded = windowResults.filter((r) => r.ok).flatMap((r) => r.batch);
    successfulMembers.push(...windowSucceeded);
    retrieved = successfulMembers.length;
    onProgress?.({ retrieved, total: members.length });
  }

  return { retrieved, total: members.length, errors, successfulMembers };
}
