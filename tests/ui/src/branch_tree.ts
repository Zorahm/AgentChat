/** Does branching blow up a chat?
 *
 * Gemini shipped conversation branches and chats started failing around the
 * tenth message: the client was sending the whole branched tree, so the request
 * grew with every regenerate until the model refused it and the composer went
 * dead. AgentChat has the same feature (retry → assistant variants, edit → user
 * variants), so these scenarios grow a session the way a heavy user would and
 * assert that variants cost nothing on the wire, that the tree stays a tree, and
 * that everything grows linearly. */

import type { ChatSession } from "../../../ui/src/types/chat";
import { assert, assertEqual, assertNear, report, section, test } from "./assert";
import {
  corruption,
  edit,
  emptySession,
  lastAssistantId,
  measure,
  printTable,
  retry,
  send,
  switchTo,
  type Metrics,
} from "./chat_sim";

function assertSound(session: ChatSession, where: string): void {
  const { anomaly } = corruption(session.root);
  assert(anomaly === null, `${where}: tree is corrupt — ${anomaly}`);
}

/** N plain turns, no branching — the control. */
function linear(turns: number): ChatSession {
  let s = emptySession();
  for (let i = 1; i <= turns; i++) s = send(s, `message ${i}`);
  return s;
}

/** N turns where the user regenerates every answer `retries` times. */
function branched(turns: number, retries: number): ChatSession {
  let s = emptySession();
  for (let i = 1; i <= turns; i++) {
    s = send(s, `message ${i}`);
    for (let r = 0; r < retries; r++) s = retry(s);
  }
  return s;
}

function main(): void {
  section("Branching cost");

  const rows: Metrics[] = [];

  test("branches cost nothing on the wire", () => {
    // The core invariant. History is rebuilt per send from currentBranch(),
    // which follows activeVariantIdx and never walks variants[] — so the request
    // must be byte-identical whether or not the user regenerated every answer.
    const plain = measure("20 turns, no branches", linear(20));
    const withVariants = measure("20 turns, retry x2 each", branched(20, 2));
    rows.push(plain, withVariants);
    assertEqual(withVariants.wire, plain.wire, "wire message count");
    assertEqual(withVariants.wireBytes, plain.wireBytes, "wire payload bytes");
    assert(withVariants.nodes === plain.nodes, "branching must not add nodes to the branch");
  });

  test("the request grows linearly with conversation length", () => {
    const ten = measure("10 turns", linear(10));
    const twenty = measure("20 turns", linear(20));
    rows.push(ten);
    assertEqual(twenty.wire, ten.wire * 2, "wire message count doubles with the turns");
    assertNear(twenty.wireBytes, ten.wireBytes * 2, 0.05, "wire bytes double with the turns");
  });

  test("fat tool results are truncated for replay", () => {
    // expandToWire caps each replayed tool result (TOOL_OUTPUT_REPLAY_LIMIT);
    // without it a handful of file reads would dwarf the conversation.
    const m = measure("20 turns", linear(20));
    assert(
      m.wireBytes < m.storedBytes / 2,
      `wire payload (${m.wireBytes}) should be far below the stored tree (${m.storedBytes})`,
    );
  });

  test("the stored tree grows with variants, but only linearly", () => {
    const plain = measure("20 turns, no branches", linear(20));
    const x3 = measure("20 turns, retry x2 each", branched(20, 2));
    // Three variants per answer ⇒ ~3x the stored bytes. Anything materially
    // above that means variants are being duplicated, not shared.
    assertNear(x3.storedBytes, plain.storedBytes * 3, 0.05, "stored bytes with 3 variants per turn");
  });

  section("Tree integrity");

  test("no node is reachable by two paths after heavy branching", () => {
    let s = branched(20, 2);
    const firstUserId = s.root[0]?.id;
    assert(firstUserId !== undefined, "session has a root user node");
    for (let i = 1; i <= 5; i++) {
      s = edit(s, firstUserId as string, `edit ${i}`);
      for (let k = 0; k < 3; k++) s = send(s, `follow-up ${i}.${k}`);
    }
    rows.push(measure("branched + 5 edits", s));
    assertSound(s, "after 20 branched turns and 5 edits");
  });

  test("editing the first message restarts the branch, it does not fork the tail", () => {
    let s = linear(5);
    const firstUserId = s.root[0]?.id as string;
    s = edit(s, firstUserId, "rewritten opening");
    const m = measure("edit message #1", s);
    rows.push(m);
    assertEqual(m.branch, 2, "active branch after editing the opening message");
    assertSound(s, "after editing the first message");
  });

  section("Switching between branches");

  test("each branch keeps its own tail and stays writable", () => {
    let s = linear(5);
    const forkPoint = lastAssistantId(s);
    assertEqual(measure("", s).branch, 10, "messages before the fork");

    s = retry(s); // variant 1 on the last answer
    for (let i = 1; i <= 5; i++) s = send(s, `branch B ${i}`);
    const inB = measure("retry@5 + 5 turns in B", s);
    rows.push(inB);
    assertEqual(inB.branch, 20, "messages on branch B");

    s = switchTo(s, forkPoint, 0);
    assertEqual(measure("", s).branch, 10, "branch A is back to where it was left");
    for (let i = 1; i <= 5; i++) s = send(s, `branch A ${i}`);
    const inA = measure("+5 turns in A", s);
    rows.push(inA);
    assertEqual(inA.branch, 20, "messages on branch A");

    s = switchTo(s, forkPoint, 1);
    const backInB = measure("back to B", s);
    assertEqual(backInB.branch, 20, "branch B kept its own tail");
    for (let i = 1; i <= 5; i++) s = send(s, `branch B tail ${i}`);
    const grownB = measure("+5 more in B", s);
    rows.push(grownB);
    assertEqual(grownB.branch, 30, "branch B after writing again");
    assertSound(s, "after switching branches three times");
  });

  test("a heavily branched chat stays cheap to walk", () => {
    // The walk runs on every render and every autosave; a super-linear cost here
    // is what turns a long chat into an unusable one.
    const m = measure("40 turns, retry x2 each", branched(40, 2));
    rows.push(m);
    assert(m.walkMs < 100, `walking a 40-turn branched chat took ${m.walkMs.toFixed(1)}ms`);
    assertEqual(m.anomaly, null, "tree integrity");
  });

  printTable("measurements", rows);
  report("branch_tree");
}

main();
