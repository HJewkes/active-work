/**
 * How a note's `read_if` condition is printed after its one-line entry, so a
 * reader can skip a note that does not apply without opening it. Empty when
 * the note declares none, which keeps those lines byte-identical to before.
 */
export function readIfSuffix(readIf: string | undefined): string {
  return readIf === undefined ? '' : ` (read if: ${readIf})`;
}
