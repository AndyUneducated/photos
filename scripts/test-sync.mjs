/**
 * Publishing from more than one computer, end to end.
 *
 * Builds a throwaway sandbox: a bare repository standing in for GitHub, and two independent
 * checkouts of the studio ("computer A" and "computer B") each running its own server. Then walks
 * through what happens in real life — publishing in turn, publishing while behind, a genuine
 * conflict and each way of resolving it, a push GitHub rejects, a commit that never got pushed,
 * and a studio killed mid-publish — and checks that the gallery on both sides ends up right.
 *
 * Never touches this repository's own gallery or remote.
 *
 *   node scripts/test-sync.mjs
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { createSandbox } from './test-helpers.mjs';

let failures = 0;
function check(label, condition, detail = '') {
  if (condition) console.log(`  PASS  ${label}`);
  else {
    failures++;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

const sandbox = await createSandbox('sync-test');
const { machine, remoteTitles, remoteTree } = sandbox;

try {
  const a = await machine('A', 4481, { fresh: true });

  console.log('\nFirst publish creates the gallery on GitHub');
  const setupA = await a.post('/api/setup');
  check('A: gallery branch created locally', setupA.created === true && !setupA.adopted, JSON.stringify(setupA));
  let op = await a.publish('A1');
  check('A: publish A1 pushed', op.state === 'done' && op.result.git.pushed, summary(op));
  check('GitHub has A1', sameSet(await remoteTitles(), ['A1']), (await remoteTitles()).join(','));

  console.log('\nA fresh clone adopts what is on GitHub');
  const b = await machine('B', 4482, { fresh: false });
  const setupB = await b.post('/api/setup');
  check('B: adopted the remote gallery instead of starting empty', setupB.adopted === true, JSON.stringify(setupB));
  check('B: sees A1 straight away', sameSet(await b.localTitles(), ['A1']), (await b.localTitles()).join(','));
  op = await b.publish('B1');
  check('B: publish B1 pushed without any conflict', op.state === 'done' && op.result.git.pushed, summary(op));

  console.log('\nPublishing while behind brings the other computer’s photos in first');
  op = await a.publish('A2');
  check('A: publish A2 succeeded', op.state === 'done' && op.result.git.pushed, summary(op));
  check('A: a pull step ran', op.steps.some((s) => s.id === 'pull' && s.state === 'done'), stepList(op));
  check('GitHub has A1, B1, A2', sameSet(await remoteTitles(), ['A1', 'B1', 'A2']), (await remoteTitles()).join(','));

  console.log('\nA real conflict stops before changing anything');
  op = await a.publish('A3', { push: false });
  check('A: local-only publish A3', op.state === 'done' && !op.result.git.pushed, summary(op));
  check('A: reports unpushed changes', (await a.get('/api/state')).git.unpushed === true);
  op = await b.publish('B2');
  check('B: publish B2 (behind, so pulled first)', op.state === 'done' && op.result.git.pushed, summary(op));

  const headBefore = await a.head();
  const a4 = await a.stage('A4');
  op = await a.publishStaged(a4, 'A4');
  const conflict = op.error?.conflict;
  check('A: publish A4 stops with a conflict', op.state === 'conflict' && conflict, summary(op));
  check(
    'conflict lists B2 as added on the other computer',
    conflict?.onlyRemote.some((x) => x.title === 'B2' && x.why === 'added on another computer'),
    JSON.stringify(conflict?.onlyRemote),
  );
  check(
    'conflict lists A3 as added on this computer',
    conflict?.onlyLocal.some((x) => x.title === 'A3' && x.why === 'added on this computer'),
    JSON.stringify(conflict?.onlyLocal),
  );
  check('conflict error is readable and has a hint', Boolean(op.error?.error && op.error?.hint), JSON.stringify(op.error).slice(0, 200));
  check('A: nothing changed locally after the conflict', (await a.head()) === headBefore && !(await a.dirty()));
  check('A: the A4 photo is still waiting in the studio', await a.isStaged(a4));

  op = await a.publishStaged(a4, 'A4', { resolution: { action: 'merge', remoteCommit: '0'.repeat(40) } });
  check('an answer given for a different remote state is not honoured', op.state === 'conflict', summary(op));

  op = await a.publishStaged(a4, 'A4', { resolution: { action: 'merge', remoteCommit: conflict.remoteCommit } });
  check('A: keep-both publish succeeded', op.state === 'done' && op.result.git.pushed, summary(op));
  check(
    'GitHub has everything from both computers',
    sameSet(await remoteTitles(), ['A1', 'B1', 'A2', 'A3', 'B2', 'A4']),
    (await remoteTitles()).join(','),
  );
  check('A: local matches GitHub', (await a.tree()) === (await remoteTree()));
  check('A: no longer reports unpushed changes', (await a.get('/api/state')).git.unpushed === false);

  console.log('\nOverwriting GitHub on purpose');
  op = await b.publish('B3', { push: false });
  op = await a.publish('A5');
  check('A: publish A5 pushed', op.state === 'done' && op.result.git.pushed, summary(op));
  const b4 = await b.stage('B4');
  op = await b.publishStaged(b4, 'B4');
  check('B: publish B4 stops with a conflict', op.state === 'conflict', summary(op));
  op = await b.publishStaged(b4, 'B4', { resolution: { action: 'force', remoteCommit: op.error.conflict.remoteCommit } });
  check('B: forced publish succeeded', op.state === 'done' && op.result.git.pushed, summary(op));
  check(
    'GitHub is now exactly B (A5 gone, B3 and B4 present)',
    sameSet(await remoteTitles(), ['A1', 'B1', 'A2', 'B2', 'B3', 'B4']),
    (await remoteTitles()).join(','),
  );

  console.log('\nA push GitHub rejects is rolled back, not faked');
  const headB = await b.head();
  await sandbox.rejectPushes(true);
  const b5 = await b.stage('B5');
  op = await b.publishStaged(b5, 'B5');
  check('B: publish B5 failed', op.state === 'failed', summary(op));
  check('failure is marked as rolled back', op.error?.rolledBack === true, JSON.stringify(op.error).slice(0, 300));
  check('failure has a readable hint', /Nothing was published/.test(op.error?.hint || ''), op.error?.hint);
  check('failure is explained as GitHub refusing it', op.error?.code === 'git-push-refused', `${op.error?.code}: ${op.error?.error}`);
  check('failure carries git’s own output for debugging', /rejected on purpose/.test(op.error?.detail?.stderr || ''), JSON.stringify(op.error?.detail).slice(0, 300));
  check('the failing milestone is marked', op.steps.some((s) => s.id === 'push' && s.state === 'failed'), stepList(op));
  check('B: branch is back where it was', (await b.head()) === headB);
  check('B: worktree is clean', !(await b.dirty()));
  check('B: B5 is still waiting in the studio', await b.isStaged(b5));
  check('B: B5 is not in the local gallery', !(await b.localTitles()).includes('B5'));
  check('GitHub does not have B5', !(await remoteTitles()).includes('B5'));
  await sandbox.rejectPushes(false);
  op = await b.publishStaged(b5, 'B5');
  check('B: retrying B5 after the problem is fixed works', op.state === 'done' && op.result.git.pushed, summary(op));

  console.log('\nA commit that never reached GitHub is pushed by the next sync');
  op = await b.publish('B6', { push: false });
  check('B: reports unpushed changes', (await b.get('/api/state')).git.unpushed === true);
  op = await b.runOp('/api/sync', {});
  check('B: sync pushed them', op.state === 'done' && op.result.git.pushed, summary(op));
  check('GitHub has B6', (await remoteTitles()).includes('B6'));
  check('B: in sync afterwards', (await b.get('/api/state')).git.unpushed === false);
  op = await b.runOp('/api/sync', {});
  check('B: a second sync has nothing to push', op.state === 'done' && !op.result.git.pushed, summary(op));

  console.log('\nA studio killed mid-publish is put back on restart');
  await b.stop();
  const headBeforeCrash = await b.head();
  await writeFile(join(b.dir, 'studio', '.state', 'journal.json'), JSON.stringify({
    opId: 'crash', kind: 'publish', title: 'Publishing “Crashed”', startedAt: Date.now(), head: headBeforeCrash,
  }));
  await mkdir(join(b.dir, 'gallery', 'albums', 'half-written', 'w'), { recursive: true });
  await writeFile(join(b.dir, 'gallery', 'albums', 'half-written', 'w', 'x.avif'), 'partial');
  await writeFile(join(b.dir, 'gallery', 'manifest.json'), '{ "truncated": ');
  await b.start();
  const st = await b.get('/api/state');
  check('B: recovery reported a rollback', st.recovery?.outcome === 'rolled-back', JSON.stringify(st.recovery));
  check('B: gallery is clean after recovery', !(await b.dirty()));
  check('B: branch unchanged after recovery', (await b.head()) === headBeforeCrash);
  check('B: recovery is only reported once', (await b.get('/api/state')).recovery === null);
} catch (err) {
  failures++;
  console.log(`\nThe test threw an exception: ${err.message}`);
  console.log(err.stack);
  for (const m of sandbox.machines) if (m.log.trim()) console.log(`\n--- server ${m.name} log ---\n${m.log.trim()}`);
} finally {
  await sandbox.cleanup();
}

console.log(failures === 0 ? '\nAll passed.' : `\n${failures} failed.`);
process.exit(failures === 0 ? 0 : 1);

// ---------------------------------------------------------------- helpers

function sameSet(actual, expected) {
  return actual.length === expected.length && expected.every((x) => actual.includes(x));
}

function summary(op) {
  return `${op.state}${op.error ? `: ${op.error.error} [${op.error.code}]` : ''}`;
}

function stepList(op) {
  return op.steps.map((s) => `${s.id}=${s.state}`).join(' ');
}
