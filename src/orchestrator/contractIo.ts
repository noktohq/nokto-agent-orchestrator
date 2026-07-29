import { readFileSync } from 'node:fs';
import { load } from 'js-yaml';
import { taskContractSchema } from '../types.js';
import type { TaskContract } from '../types.js';

export class ContractParseError extends Error {}

/** Leser og strengt validerer en oppgavekontrakt fra en YAML- eller JSON-fil. */
export function loadTaskContract(path: string): TaskContract {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    throw new ContractParseError(
      `Kunne ikke lese oppgavefil "${path}": ${err instanceof Error ? err.message : String(err)}`
    );
  }

  let parsed: unknown;
  try {
    parsed = load(raw);
  } catch (err) {
    throw new ContractParseError(
      `Ugyldig YAML/JSON i "${path}": ${err instanceof Error ? err.message : String(err)}`
    );
  }

  const result = taskContractSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new ContractParseError(`Oppgavekontrakt "${path}" er ugyldig: ${issues}`);
  }
  return result.data;
}
