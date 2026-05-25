/** Extract the file name from a path, handling both POSIX (/) and Windows (\) separators.
 *
 * WSL paths use "/", but the PowerShell fallback returns Windows paths like
 * "C:\\Users\\you\\file.txt". Splitting on "/" alone leaves the whole path as
 * the "name", so file previews and downloads end up labelled by full path.
 */
export function basename(path: string): string {
  return path.split(/[/\\]/).pop() || path;
}
