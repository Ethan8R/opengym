/* Running a provider CLI as a child process, with the blast radius kept small.
 *
 * Three things matter here and none of them are about convenience:
 *   · no shell, ever — argv is an array, and the user's free text never reaches it anyway
 *     (it travels inside the payload file, as JSON data)
 *   · the environment is built from nothing rather than inherited, so the child cannot read
 *     SUPABASE_SECRET_KEY, ADMIN_UIDS, VAPID keys or anything else this process holds
 *   · the child runs as an unprivileged user (created in the Dockerfile) whose uid cannot
 *     read ./data, so a CLI that decided to go looking finds nothing to find
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';

// Resolved once: the container creates a `coach` user, but a bare `node server.js` on a
// developer's laptop has no such user and must still work.
let coachIds = null;
export function unprivilegedIds() {
  if (coachIds !== null) return coachIds;
  coachIds = null;
  try {
    const passwd = fs.readFileSync('/etc/passwd', 'utf8');
    const line = passwd.split('\n').find(l => l.startsWith('coach:'));
    if (line && process.getuid && process.getuid() === 0) {
      const [, , uid, gid] = line.split(':');
      coachIds = { uid: +uid, gid: +gid };
    }
  } catch { /* not linux, or no passwd file — run as ourselves */ }
  return coachIds;
}

/**
 * Run `cmd argv`, feed `stdin`, resolve { code, stdout, stderr, timedOut }.
 * Never rejects on a non-zero exit: the caller classifies failures, and a CLI that prints a
 * useful error and exits 1 is more informative than a thrown Error with none of it.
 */
export function run(cmd, argv, { stdin = '', env = {}, cwd, timeoutMs = 300000, asCoach = true } = {}) {
  return new Promise(resolve => {
    const ids = asCoach ? unprivilegedIds() : null;
    let child;
    try {
      child = spawn(cmd, argv, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], ...(ids || {}) });
    } catch (e) {
      resolve({ code: -1, stdout: '', stderr: e.message, spawnError: true });
      return;
    }
    let stdout = '', stderr = '', timedOut = false, done = false;
    // Output is bounded: a CLI stuck in a loop must not take the server's memory with it.
    const CAP = 4 * 1024 * 1024;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    child.stdout.on('data', d => { if (stdout.length < CAP) stdout += d; });
    child.stderr.on('data', d => { if (stderr.length < CAP) stderr += d; });
    const finish = (code, err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr: stderr || (err ? err.message : ''), timedOut, spawnError: !!err });
    };
    child.on('error', e => finish(-1, e));
    child.on('close', code => finish(code));
    try { child.stdin.end(stdin); } catch { /* child already gone; 'close' handles it */ }
  });
}
