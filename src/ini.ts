import type { ConfigResult } from './rcon.ts';

// ServerSettings.ini, as the whitelist (vip.ts) and the map rotations (rotations.ts) edit it: one section at a time,
// leaving every other line as it was.

const isHeader = (line: string): boolean => /^\s*\[.*\]\s*$/.test(line);

// Where a section's lines are: `start` is its header line and `end` the line after its last, or -1 for both when the
// file has no such section. A section that is there twice cannot be edited safely, so that throws.
export const sectionRange = (lines: string[], section: string): { start: number; end: number } => {
  const starts = lines.flatMap((line, i) => (line.trim().toLowerCase() === section.toLowerCase() ? [i] : []));
  if (starts.length > 1) throw new Error(`ServerSettings.ini has ${section} more than once`);
  const start = starts[0] ?? -1;
  if (start === -1) return { start, end: -1 };
  const next = lines.findIndex((line, i) => i > start && isHeader(line));
  return { start, end: next === -1 ? lines.length : next };
};

export const sectionLines = (text: string, section: string): string[] => {
  const lines = text.split(/\r?\n/);
  const { start, end } = sectionRange(lines, section);
  return start === -1 ? [] : lines.slice(start + 1, end);
};

// A new section at the end of the file, after a blank line.
export const appendSection = (text: string, section: string, lines: string[]): string => {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const all = text.split(/\r?\n/);
  const body = all.at(-1) === '' ? all.slice(0, -1) : all;
  return [...body, ...(body.length > 0 ? [''] : []), section, ...lines, ''].join(eol);
};

// Why a change to `key` did not take: the server refused the file, or would leave the key out.
export const refusal = (result: ConfigResult, key: string): string | null => {
  if (!result.ok) return `the server refused the change: ${result.errors.join('; ') || 'no reason given'}`;
  if (result.ignored.some((item) => item.toLowerCase().includes(key.toLowerCase()))) {
    return `the server ignores ${key} edits (it may be set by a launch argument)`;
  }
  return null;
};
