const PEPPERED_IMAGE_NAMES = new Set([
  'peppered.exe',
  'peppered-win64-shipping.exe',
]);

export type PepperedTasklistState = 'running' | 'not-running' | 'unverified';
export type TasklistReader = () => Promise<string>;

const CLOSE_GAME_ERROR = 'Close PEPPERED before restoring a checkpoint.';
const VERIFY_GAME_ERROR = 'Could not verify that PEPPERED is closed. Close the game and try again.';

function parseCsvRow(line: string): string[] | null {
  const fields: string[] = [];
  let index = 0;
  while (index < line.length) {
    if (line[index] !== '"') return null;
    index += 1;
    let value = '';
    let closed = false;
    while (index < line.length) {
      const character = line[index];
      if (character !== '"') {
        value += character;
        index += 1;
        continue;
      }
      if (line[index + 1] === '"') {
        value += '"';
        index += 2;
        continue;
      }
      index += 1;
      closed = true;
      break;
    }
    if (!closed) return null;
    fields.push(value);
    if (index === line.length) break;
    if (line[index] !== ',') return null;
    index += 1;
    if (index === line.length) return null;
  }
  if (fields.length !== 5 || !fields[0] || !/^\d+$/.test(fields[1]) || fields.slice(2).some((field) => !field)) return null;
  return fields;
}

export function parsePepperedTasklist(stdout: string): PepperedTasklistState {
  const lines = stdout.split(/\r?\n/).filter((line) => line.length > 0);
  if (lines.length === 0) return 'unverified';
  let malformed = false;
  let running = false;
  for (const line of lines) {
    const fields = parseCsvRow(line);
    if (fields === null) {
      malformed = true;
      continue;
    }
    if (PEPPERED_IMAGE_NAMES.has(fields[0].toLowerCase())) running = true;
  }
  if (running) return 'running';
  return malformed ? 'unverified' : 'not-running';
}

export async function verifyPepperedClosed(platform: NodeJS.Platform, readTasklist: TasklistReader): Promise<void> {
  if (platform !== 'win32') return;
  let stdout: string;
  try {
    stdout = await readTasklist();
  } catch (cause) {
    throw new Error(VERIFY_GAME_ERROR, { cause });
  }
  const state = parsePepperedTasklist(stdout);
  if (state === 'unverified') throw new Error(VERIFY_GAME_ERROR);
  if (state === 'running') throw new Error(CLOSE_GAME_ERROR);
}
