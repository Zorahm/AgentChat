/** The UI has no @types/node (it targets the browser), but these suites run on
 *  Node. Only the two globals the suites actually touch are declared. */
declare const process: {
  exitCode: number | undefined;
  argv: readonly string[];
};
